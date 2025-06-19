import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { readCommentsInRange, readSingleComment, UserComment, writeCommentToIndex } from '@solarpunkltd/comment-system';
import { loadLatestComments, readLatestComment } from 'src/utils/comments';
import { assertComment, isEmpty } from 'src/utils/validation';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { EVENTS } from './constants';
import { SwarmHistory } from './history';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter: EventEmitter;
  private utils: SwarmChatUtils;
  private history: SwarmHistory;
  private userDetails: ChatSettingsUser;
  private swarmSettings: ChatSettingsSwarm;

  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private fetchProcessRunning = false;
  private stopFetch = false;

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

    this.emitter = new EventEmitter();
    this.utils = new SwarmChatUtils(this.userDetails, this.swarmSettings);
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

      // await this.utils.writeOwnFeedDataByIndex(nextIndex, JSON.stringify(messageObj));
      const identifier = Topic.fromString(this.swarmSettings.chatTopic).toString();
      const comment = await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(BigInt(nextIndex)), {
        stamp: this.swarmSettings.stamp,
        identifier,
        // signer, // TODO: maybe export and use getPrivateKeyFromIdentifier(identifier);
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      await this.verifyWriteSuccess(FeedIndex.fromBigInt(BigInt(nextIndex)), identifier, comment);

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

      const messages = await this.history.fetchPreviousMessageState();
      return messages;
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  // TOOD: load history
  private async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      // const [ownIndexResult, historyInitResult] = await Promise.allSettled([this.initOwnIndex(), this.history.init()]);
      const [ownIndexResult] = await Promise.allSettled([this.initOwnIndex()]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      // if (historyInitResult.status === 'fulfilled') {
      //   this.gsocIndex = historyInitResult.value;
      // }

      this.emitter.emit(EVENTS.LOADING_INIT, false);
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
  }

  private async fetchLatestMessage() {
    try {
      const identifier = Topic.fromString(this.swarmSettings.chatTopic).toString();
      const latestCommet = await readLatestComment(
        identifier,
        this.swarmSettings.chatAddress,
        this.swarmSettings.beeUrl,
      );

      // TODO: scheme validation
      assertComment(latestCommet);

      const parsedData: MessageData = {
        id: latestCommet.message.messageId || uuidv4() + 'todo', // TODO: require messageId
        username: latestCommet.user.username,
        address: latestCommet.user.address,
        chatTopic: identifier,
        userTopic: 'bagoy-chat-user-topic', // TODO: resolve message IF
        signature: 'bagoy-chat-signature', // TODO: resolve message IF
        timestamp: latestCommet.timestamp,
        index: latestCommet.nextIndex === undefined ? 0 : Number(new FeedIndex(latestCommet.nextIndex).toBigInt() - 1n),
        type: MessageType.TEXT,
        targetMessageId: latestCommet.message.threadId,
        message: latestCommet.message.text,
      };

      this.logger.info('Fetched latest message:', parsedData);
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, parsedData.message);
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestMessage');
    }
  }

  private async verifyWriteSuccess(index: FeedIndex, identifier: string, comment: UserComment) {
    if (isEmpty(comment)) {
      throw 'Comment write failed, empty response!';
    }

    const commentCheck = await readSingleComment(index, {
      identifier,
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
