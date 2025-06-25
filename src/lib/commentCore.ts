import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  getReactionFeedId,
  isReaction,
  isUserComment,
  MessageData as CommentMessageData,
  readSingleComment,
  SingleComment,
  updateReactions,
  writeCommentToIndex,
  writeReactionsToIndex,
} from '@solarpunkltd/comment-system';
import { v4 as uuidv4 } from 'uuid';

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

  private startIndex: bigint;
  private reactionIndex: bigint;
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

    this.startIndex = -1n;
    this.reactionIndex = -1n;
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
  public async sendMessage(
    message: string,
    type: MessageType,
    targetMessageId?: string,
    id?: string,
    prevState?: MessageData[],
  ): Promise<void> {
    const nextIndex = this.userDetails.ownIndex === -1 ? 0 : this.userDetails.ownIndex + 1;
    const messageObj = {
      id: id || uuidv4(),
      username: this.userDetails.nickname,
      address: this.userDetails.ownAddress,
      chatTopic: Topic.fromString(this.swarmSettings.chatTopic).toString(),
      userTopic: Topic.fromString(this.swarmSettings.chatTopic).toString(),
      signature: this.getSignature(),
      timestamp: Date.now(),
      index: nextIndex,
      type,
      targetMessageId,
      message,
    } as MessageData;

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      if (type === MessageType.REACTION) {
        const reactionFeedId = getReactionFeedId(Topic.fromString(this.swarmSettings.chatTopic).toString()).toString();
        const reactionNextIndex =
          this.reactionIndex === -1n ? FeedIndex.fromBigInt(0n) : FeedIndex.fromBigInt(this.reactionIndex + 1n);

        const newReactionState = updateReactions(prevState || [], messageObj) || [];

        await writeReactionsToIndex(newReactionState, reactionNextIndex, {
          stamp: this.swarmSettings.stamp,
          signer: this.chatSigner,
          identifier: reactionFeedId,
          beeApiUrl: this.swarmSettings.beeUrl,
        });

        this.reactionIndex = reactionNextIndex.toBigInt();
      } else {
        const comment = await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(BigInt(nextIndex)), {
          stamp: this.swarmSettings.stamp,
          signer: this.chatSigner,
          identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
          beeApiUrl: this.swarmSettings.beeUrl,
        });

        await this.verifyWriteSuccess(FeedIndex.fromBigInt(BigInt(nextIndex)), comment);

        this.userDetails.ownIndex = nextIndex;
      }

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

      await this.fetchLatestReactions();

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

    const comment = await retryAwaitableAsync(
      () =>
        readSingleComment(undefined, {
          identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
          address: this.swarmSettings.chatAddress,
          beeApiUrl: this.swarmSettings.beeUrl,
        }),
      RETRY_COUNT,
      DELAY,
    );

    if (comment?.comment?.index) {
      this.userDetails.ownIndex = comment.comment.index;
    }
  }

  private async fetchLatestMessage() {
    try {
      const latestComment = await readSingleComment(FeedIndex.fromBigInt(BigInt(this.userDetails.ownIndex + 1)), {
        identifier: Topic.fromString(this.swarmSettings.chatTopic).toString(),
        address: this.swarmSettings.chatAddress,
        beeApiUrl: this.swarmSettings.beeUrl,
      });

      if (!latestComment || Object.keys(latestComment).length === 0) {
        this.logger.debug(`No comment found at index: ${this.userDetails.ownIndex + 1}`);
        return;
      }

      if (!isUserComment(latestComment.comment)) {
        this.logger.warn('Invalid user comment during fetching');
        return;
      }

      this.userDetails.ownIndex = latestComment.comment.index;
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, latestComment.comment);
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestMessage');
    }
  }

  private async fetchLatestReactions(index?: bigint) {
    try {
      // TODO: rename to fetchLatestReactionState
      const reactionNextIndex = (await this.history.fetchLatestReactions(index, this.reactionIndex)).toBigInt();
      if (reactionNextIndex > this.reactionIndex) {
        this.reactionIndex = reactionNextIndex - 1n;
      }
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestReactions');
    }
  }

  private getSignature() {
    const { ownAddress: address, privateKey, nickname } = this.userDetails;

    const ownAddress = new EthAddress(address).toString();

    const signer = new PrivateKey(privateKey);
    const signerAddress = signer.publicKey().address().toString();

    if (signerAddress !== ownAddress) {
      throw new Error('The provided address does not match the address derived from the private key');
    }

    const timestamp = Date.now();
    const signature = signer.sign(JSON.stringify({ username: nickname, address: ownAddress, timestamp }));

    return signature.toHex();
  }

  private async verifyWriteSuccess(index: FeedIndex, comment?: CommentMessageData) {
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

    if (!isUserComment(commentCheck.comment)) {
      this.logger.warn('Invalid user comment during write');
      return;
    }

    // TODO: id check
    if (commentCheck.comment.id !== comment.id || commentCheck.comment.timestamp !== comment.timestamp) {
      throw new Error(`comment check failed, expected "${comment.message}", got: "${commentCheck.comment.message}".
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

      await Promise.allSettled([this.fetchLatestMessage(), this.fetchLatestReactions(this.reactionIndex + 1n)]);
      setTimeout(poll, 1000); // with 1 sec little delay
    };

    poll();
  }

  private stopMessagesFetchProcess() {
    this.stopFetch = true;
  }
}
