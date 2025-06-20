import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { readCommentsInRange, readSingleComment, UserComment, writeCommentToIndex } from '@solarpunkltd/comment-system';
import { assertComment, isEmpty } from 'src/utils/validation';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { COMMENTS_TO_READ, EVENTS } from './constants';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
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

  public async sendMessage(message: string, type: MessageType, targetMessageId?: string, id?: string): Promise<void> {
    const nextIndex = this.userDetails.ownIndex === -1 ? 0 : this.userDetails.ownIndex + 1;
    const messageObj: UserComment = {
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
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      const comment = await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(BigInt(nextIndex)), {
        stamp: this.swarmSettings.stamp,
        identifier: this.identifier,
        // signer, // TODO: maybe export and use getPrivateKeyFromIdentifier(identifier);
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      await this.verifyWriteSuccess(FeedIndex.fromBigInt(BigInt(nextIndex)), comment);

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

    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);

      const comments = await readCommentsInRange(
        FeedIndex.fromBigInt(BigInt(newStartIndex)),
        FeedIndex.fromBigInt(BigInt(this.startFeedIdx)),
        {
          identifier: this.identifier,
          address: this.swarmSettings.chatAddress,
          beeApiUrl: this.swarmSettings.beeUrl,
        },
      );
      // todo: debug
      this.logger.info('Fetching previous messages from: ', newStartIndex, ' to: ', this.startFeedIdx);

      this.startFeedIdx = newStartIndex;
      return comments;
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  // TODO: use history
  private async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      const [ownIndexResult, historyInitResult] = await Promise.allSettled([
        this.initOwnIndex(),
        this.fetchPreviousMessages(),
      ]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      let previousComments: UserComment[] = [];
      if (historyInitResult.status === 'fulfilled') {
        previousComments = historyInitResult.value;
      }

      this.emitter.emit(EVENTS.LOADING_INIT, false);

      // todo: is ordering needed here?
      previousComments = this.orderMessages(previousComments);

      const messageState = previousComments.map((c, ix) => {
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

  private async initOwnIndex() {
    const RETRY_COUNT = 10;
    const DELAY = 1000;

    const { latestIndex } = await retryAwaitableAsync(() => this.utils.getOwnLatestFeedIndex(), RETRY_COUNT, DELAY);

    this.userDetails.ownIndex = latestIndex;
    this.startFeedIdx = latestIndex;
  }

  private async fetchLatestMessage() {
    try {
      const latestComment = await readSingleComment(undefined, {
        identifier: this.identifier,
        address: this.swarmSettings.chatAddress,
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      // TODO: scheme validation
      assertComment(latestComment);

      const parsedData: MessageData = {
        id: latestComment.message.messageId || uuidv4() + 'todo', // TODO: require messageId
        username: latestComment.user.username,
        address: latestComment.user.address,
        chatTopic: this.identifier,
        userTopic: 'bagoy-chat-user-topic', // TODO: resolve message IF
        signature: 'bagoy-chat-signature', // TODO: resolve message IF
        timestamp: latestComment.timestamp,
        index:
          latestComment.nextIndex === undefined ? 0 : Number(new FeedIndex(latestComment.nextIndex).toBigInt() - 1n),
        type: MessageType.TEXT,
        targetMessageId: latestComment.message.threadId,
        message: latestComment.message.text,
      };

      // todo: debug
      this.logger.info('Fetched latest message:', parsedData);
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, parsedData.message);
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestMessage');
    }
  }

  private async verifyWriteSuccess(index: FeedIndex, comment: UserComment) {
    if (isEmpty(comment)) {
      throw 'Comment write failed, empty response!';
    }

    const commentCheck = await readSingleComment(index, {
      identifier: this.identifier,
      address: this.swarmSettings.chatAddress,
      beeApiUrl: this.swarmSettings.beeUrl,
    });

    assertComment(commentCheck);
    // TODO: id check
    if (
      commentCheck.comment.message.text !== comment.message.text ||
      commentCheck.comment.timestamp !== comment.timestamp
    ) {
      throw `comment check failed, expected "${comment.message.text}", got: "${commentCheck?.comment.message.text}".
                Expected timestamp: ${comment.timestamp}, got: ${commentCheck?.comment.timestamp}`;
    }
  }

  // TODO: probably remove or use for verification
  // private getSignature() {
  //   const { ownAddress: address, privateKey, nickname } = this.userDetails;

  //   const ownAddress = new EthAddress(address).toString();

  //   const signer = new PrivateKey(privateKey);
  //   const signerAddress = signer.publicKey().address().toString();

  //   if (signerAddress !== ownAddress) {
  //     throw new Error('The provided address does not match the address derived from the private key');
  //   }

  //   const timestamp = Date.now();
  //   const signature = signer.sign(JSON.stringify({ username: nickname, address: ownAddress, timestamp }));

  //   return signature.toHex();
  // }

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
      setTimeout(poll, 200); // with a little delay
    };

    poll();
  }

  private stopMessagesFetchProcess() {
    this.stopFetch = true;
  }
}
