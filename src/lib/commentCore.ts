import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  getReactionFeedId,
  isUserComment,
  Reaction,
  readCommentsInRange,
  readSingleComment,
  SingleComment,
  UserComment,
  writeCommentToIndex,
  writeReactionsToIndex,
} from '@solarpunkltd/comment-system';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { COMMENTS_TO_READ, EVENTS } from './constants';
import { SwarmChatUtils } from './utils';

export class SwarmComment {
  private emitter: EventEmitter;
  private utils: SwarmChatUtils;
  private userDetails: ChatSettingsUser;
  private swarmSettings: ChatSettingsSwarm;

  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private fetchProcessRunning = false;
  private stopFetch = false;
  private identifier: string;
  private startFeedIdx: number;

  constructor(settings: ChatSettings) {
    const signer = new PrivateKey(remove0x(settings.user.privateKey));

    this.userDetails = {
      privateKey: settings.user.privateKey,
      ownAddress: signer.publicKey().address().toString(),
      nickname: settings.user.nickname,
      ownIndex: -1,
    };

    this.swarmSettings = {
      bee: new Bee(settings.infra.beeUrl),
      beeUrl: settings.infra.beeUrl,
      stamp: settings.infra.stamp || '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // placeholder stamp if smart gateway is used
      enveloped: settings.infra.enveloped,
      gsocTopic: settings.infra.gsocTopic,
      gsocResourceId: settings.infra.gsocResourceId,
      chatTopic: settings.infra.chatTopic,
      chatAddress: settings.infra.chatAddress,
    };

    this.identifier = Topic.fromString(this.swarmSettings.chatTopic).toString();
    this.startFeedIdx = -1;
    this.emitter = new EventEmitter();
    this.utils = new SwarmChatUtils(this.userDetails, this.swarmSettings);
  }

  public start() {
    this.init();
    this.startMessagesFetchProcess();
  }

  public stop() {
    this.emitter.cleanAll();
    this.stopMessagesFetchProcess();
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
    const messageObj = this.transformMessage(message, type, targetMessageId, id);

    this.logger.info('Sending message:', {
      ...messageObj,
      index: nextIndex,
    });

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      if (type === MessageType.REACTION) {
        const reactionFeedId = getReactionFeedId(this.identifier).toString();
        const reactionNextIndex = FeedIndex.fromBigInt(0n);

        await writeReactionsToIndex([messageObj as Reaction], reactionNextIndex, {
          stamp: this.swarmSettings.stamp,
          identifier: reactionFeedId,
          beeApiUrl: this.swarmSettings.beeUrl,
        });
      } else {
        const comment = await writeCommentToIndex(messageObj as UserComment, FeedIndex.fromBigInt(BigInt(nextIndex)), {
          stamp: this.swarmSettings.stamp,
          identifier: this.identifier,
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
    if (this.startFeedIdx < 0) {
      return [];
    }

    const newStartIndex = this.startFeedIdx > COMMENTS_TO_READ ? this.startFeedIdx - COMMENTS_TO_READ : 0;
    this.logger.info('fetchPreviousMessages this.startFeedIdx:', this.startFeedIdx);
    this.logger.info('fetchPreviousMessages newStartIndex:', newStartIndex);

    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);

      // todo: debug
      this.logger.info('Fetching previous messages from: ', newStartIndex, ' to: ', this.startFeedIdx);

      const comments = await readCommentsInRange(
        FeedIndex.fromBigInt(BigInt(newStartIndex)),
        FeedIndex.fromBigInt(BigInt(this.startFeedIdx)),
        {
          identifier: this.identifier,
          // address: this.swarmSettings.chatAddress,
          beeApiUrl: this.swarmSettings.beeUrl,
        },
      );

      if (!comments) {
        return [];
      }

      isUserComment(comments);

      this.startFeedIdx = newStartIndex;
      return comments;
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
      await this.initOwnIndex();
      const previousComments = await this.fetchPreviousMessages();

      this.emitter.emit(EVENTS.LOADING_INIT, false);

      // todo: is ordering needed here?
      const messageState = this.orderMessages(previousComments).map((c: UserComment, ix) => {
        return {
          id: c.message.messageId || uuidv4() + 'todo', // TODO: require messageId
          username: c.user.username,
          address: c.user.address,
          chatTopic: this.identifier,
          userTopic: 'bagoy-chat-user-topic', // TODO: resolve message IF
          signature: 'bagoy-chat-signature', // TODO: resolve message IF
          timestamp: c.timestamp,
          index: this.startFeedIdx - ix,
          type: MessageType.TEXT,
          targetMessageId: c.message.threadId,
          message: c.message.text,
        };
      });

      for (const message of messageState) {
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, message);
      }
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
      () => readSingleComment(undefined, { identifier: this.identifier, beeApiUrl: this.swarmSettings.beeUrl }),
      RETRY_COUNT,
      DELAY,
    )) as SingleComment | undefined;

    let latestIndex = -1;
    if (result && Object.keys(result).length > 0 && result.nextIndex) {
      latestIndex = Number(new FeedIndex(result.nextIndex).toBigInt() - 1n);
    }

    this.logger.info('Own latest feed index:', latestIndex);
    this.userDetails.ownIndex = latestIndex;
    this.startFeedIdx = latestIndex;
  }

  private async fetchLatestMessage() {
    try {
      const latestComment = await readSingleComment(undefined, {
        identifier: this.identifier,
        // address: this.swarmSettings.chatAddress,
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      if (latestComment === undefined) {
        // todo: debug
        throw new Error(`Failed to read latest comment for identifier: ${this.identifier}`);
      }

      if (Object.keys(latestComment).length === 0) {
        // todo: debug
        this.logger.info('No comment found for identifier:', this.identifier);
        return;
      }

      this.logger.info('fetchLatestMessage comment:', {
        ...latestComment,
        nextIndex: latestComment?.nextIndex,
      });

      // TODO: scheme validation
      isUserComment(latestComment.comment);

      const messageData: MessageData = {
        id: latestComment.comment.message.messageId || uuidv4() + 'todo', // TODO: require messageId
        username: latestComment.comment.user.username,
        address: latestComment.comment.user.address,
        chatTopic: this.identifier,
        userTopic: 'bagoy-chat-user-topic', // TODO: resolve message IF
        signature: 'bagoy-chat-signature', // TODO: resolve message IF
        timestamp: latestComment.comment.timestamp,
        index:
          latestComment.nextIndex === undefined ? 0 : Number(new FeedIndex(latestComment.nextIndex).toBigInt() - 1n),
        type: MessageType.TEXT,
        targetMessageId: latestComment.comment.message.threadId,
        message: latestComment.comment.message.text,
      };

      // todo: debug
      this.logger.info('Fetched latest message:', JSON.stringify(messageData));
      this.userDetails.ownIndex = messageData.index;
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
      identifier: this.identifier,
      // address: this.swarmSettings.chatAddress,
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

  private transformMessage(
    message: string,
    type: MessageType,
    targetMessageId?: string,
    id?: string,
  ): UserComment | Reaction {
    if (type === MessageType.REACTION) {
      return {
        targetMessageId: targetMessageId,
        user: {
          username: this.userDetails.nickname,
          address: this.userDetails.ownAddress,
        },
        reactionType: message,
        timestamp: Date.now(),
        reactionId: id || uuidv4(),
      } as Reaction;
    } else {
      return {
        message: {
          text: message,
          messageId: id || uuidv4(),
          threadId: targetMessageId,
          parent: undefined, // TODO: handle parent messages if needed
        },
        timestamp: Date.now(),
        user: {
          username: this.userDetails.nickname,
          address: this.userDetails.ownAddress,
        },
      } as UserComment;
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
