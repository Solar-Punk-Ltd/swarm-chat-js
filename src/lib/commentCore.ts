import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  getReactionFeedId,
  isUserComment,
  Reaction,
  readSingleComment,
  SingleComment,
  UserComment,
  writeCommentToIndex,
  writeReactionsToIndex,
} from '@solarpunkltd/comment-system';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { getPrivateKeyFromIdentifier, remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { EVENTS } from './constants';
import { SwarmHistory } from './history';
import { SwarmChatUtils } from './utils';

export class SwarmComment {
  private emitter: EventEmitter;
  private utils: SwarmChatUtils;
  private history: SwarmHistory;
  private userDetails: ChatSettingsUser;
  private swarmSettings: ChatSettingsSwarm;

  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private startIndex: bigint | undefined;
  private fetchProcessRunning = false;
  private stopFetch = false;
  private chatSigner: PrivateKey;

  constructor(settings: ChatSettings) {
    const signer = new PrivateKey(remove0x(settings.user.privateKey));

    this.userDetails = {
      privateKey: settings.user.privateKey,
      ownAddress: signer.publicKey().address().toString(),
      nickname: settings.user.nickname,
      ownIndex: -1,
    };

    this.chatSigner = getPrivateKeyFromIdentifier(settings.infra.chatTopic);

    this.swarmSettings = {
      bee: new Bee(settings.infra.beeUrl),
      beeUrl: settings.infra.beeUrl,
      stamp: settings.infra.stamp || '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // placeholder stamp if smart gateway is used
      enveloped: settings.infra.enveloped,
      gsocTopic: settings.infra.gsocTopic,
      gsocResourceId: settings.infra.gsocResourceId,
      chatTopic: settings.infra.chatTopic,
      chatAddress: this.chatSigner.publicKey().address().toString(),
    };

    this.emitter = new EventEmitter();
    this.utils = new SwarmChatUtils(
      {
        ...this.userDetails,
        privateKey: this.chatSigner.toString(),
        ownAddress: this.chatSigner.publicKey().address().toString(),
      },
      this.swarmSettings,
    );
    this.history = new SwarmHistory(this.utils, this.emitter);
  }

  public start() {
    this.init();
    this.startMessagesFetchProcess();
  }

  public stop() {
    this.emitter.cleanAll();
    this.stopMessagesFetchProcess();
    this.history.cleanup();
  }

  public getEmitter() {
    return this.emitter;
  }

  public orderMessages(messages: any[]) {
    return this.utils.orderMessages(messages);
  }

  // TODO: reaction handling with proper indexing and aggregation
  public async sendMessage(message: string, type: MessageType, targetMessageId?: string, id?: string): Promise<void> {
    const nextIndex = this.userDetails.ownIndex === -1 ? 0 : this.userDetails.ownIndex + 1;
    const messageObj = this.utils.transformMessage(message, type, targetMessageId, id);

    this.logger.info('Sending message:', {
      ...messageObj,
      index: nextIndex,
    });

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      if (type === MessageType.REACTION) {
        const reactionFeedId = getReactionFeedId(Topic.fromString(this.swarmSettings.chatTopic).toString()).toString();
        const reactionNextIndex = FeedIndex.fromBigInt(0n);

        await writeReactionsToIndex([messageObj as Reaction], reactionNextIndex, {
          stamp: this.swarmSettings.stamp,
          identifier: reactionFeedId,
          beeApiUrl: this.swarmSettings.beeUrl,
        });
      } else {
        const comment = await writeCommentToIndex(messageObj as UserComment, FeedIndex.fromBigInt(BigInt(nextIndex)), {
          stamp: this.swarmSettings.stamp,
          signer: this.chatSigner,
          identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
          beeApiUrl: this.swarmSettings.beeUrl,
        });

        await this.verifyWriteSuccess(FeedIndex.fromBigInt(BigInt(nextIndex)), comment);
      }

      this.userDetails.ownIndex = nextIndex;

      this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, messageObj);
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Comment.sendMessage');
    }
  }

  public async fetchPreviousMessages() {
    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);

      const newStartIndex = await this.history.fetchPreviousMessageState(this.startIndex);
      if (newStartIndex !== undefined) {
        this.startIndex = newStartIndex.toBigInt();
      }
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  public async retryBroadcastUserMessage(_: MessageData) {
    this.logger.debug('Not implemented: retryBroadcastUserMessage');
  }

  // TODO: use history
  private async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);
      // TODO: optimize
      const [ownIndexResult, historyInitResult] = await Promise.allSettled([
        this.initOwnIndex(),
        this.history.init(true),
      ]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      if (historyInitResult.status === 'fulfilled') {
        this.startIndex = historyInitResult.value.toBigInt();
      }

      this.emitter.emit(EVENTS.LOADING_INIT, false);
    } catch (error) {
      this.errorHandler.handleError(error, 'Comment.initSelfState');
      this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
    }
  }

  // TODO: fetch latest index and comment and start to load prev from there
  private async initOwnIndex() {
    const RETRY_COUNT = 10;
    const DELAY = 1000;

    const result = (await retryAwaitableAsync(
      () =>
        readSingleComment(undefined, {
          identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
          address: this.swarmSettings.chatAddress,
          beeApiUrl: this.swarmSettings.beeUrl,
        }),
      RETRY_COUNT,
      DELAY,
    )) as SingleComment | undefined;

    let latestIndex = -1n;
    if (result && Object.keys(result).length > 0 && result.nextIndex) {
      latestIndex = new FeedIndex(result.nextIndex).toBigInt() - 1n;
    }

    this.userDetails.ownIndex = Number(latestIndex);
  }

  private async fetchLatestMessage() {
    try {
      const latestComment = await readSingleComment(undefined, {
        identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
        address: this.swarmSettings.chatAddress,
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      if (latestComment === undefined) {
        // todo: debug
        throw new Error(
          `Failed to read latest comment for identifier: ${Topic.fromString(this.swarmSettings.chatTopic).toString()}`,
        );
      }

      if (Object.keys(latestComment).length === 0) {
        // todo: debug
        this.logger.info('No comment found for identifier:', Topic.fromString(this.swarmSettings.chatTopic).toString());
        return;
      }

      this.logger.info('fetchLatestMessage comment:', {
        ...latestComment,
        nextIndex: latestComment?.nextIndex,
      });

      // TODO: scheme validation
      isUserComment(latestComment.comment);

      const messageData = this.utils.transformComment(
        latestComment.comment,
        latestComment.nextIndex === undefined ? 0 : Number(new FeedIndex(latestComment.nextIndex).toBigInt() - 1n),
        MessageType.TEXT,
      );

      // todo: debug
      this.logger.info('Fetched latest message:', JSON.stringify(messageData));
      this.userDetails.ownIndex = messageData.index;
      this.logger.info('Own latest index updated:', this.userDetails.ownIndex);
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, messageData);
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestMessage');
    }
  }

  private async verifyWriteSuccess(index: FeedIndex, comment?: UserComment) {
    if (!comment) {
      throw new Error('Comment write failed, empty response!');
    }

    const commentCheck = await readSingleComment(index, {
      identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
      address: this.swarmSettings.chatAddress,
      beeApiUrl: this.swarmSettings.beeUrl,
    });

    if (!commentCheck) {
      throw new Error('Comment check failed, empty response!');
    }

    this.logger.info('verifying commentCheck:', {
      ...commentCheck,
      index: index.toString(),
    });

    isUserComment(commentCheck.comment);
    // TODO: id check
    if (
      commentCheck.comment.message.text !== comment.message.text ||
      commentCheck.comment.timestamp !== comment.timestamp
    ) {
      throw new Error(`comment check failed, expected "${comment.message.text}", got: "${commentCheck.comment.message.text}".
                Expected timestamp: ${comment.timestamp}, got: ${commentCheck.comment.timestamp}`);
    }
  }

  private async startMessagesFetchProcess() {
    if (this.fetchProcessRunning) return;

    this.fetchProcessRunning = true;
    this.stopFetch = false;

    const poll = async () => {
      if (this.stopFetch) {
        this.fetchProcessRunning = false;
        return;
      }

      await this.fetchLatestMessage();
      setTimeout(poll, 5000); // with 5 sec little delay
    };

    poll();
  }

  private stopMessagesFetchProcess() {
    this.stopFetch = true;
  }
}
