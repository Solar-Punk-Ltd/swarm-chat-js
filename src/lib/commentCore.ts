import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  getReactionFeedId,
  isUserComment,
  MessageData as CommentMessageData,
  readSingleComment,
  updateReactions,
  writeCommentToIndex,
  writeReactionsToIndex,
} from '@solarpunkltd/comment-system';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, MessageData, MessageType } from '../interfaces';
import { getPrivateKeyFromIdentifier, retryAwaitableAsync } from '../utils/common';

import { EVENTS } from './constants';
import { SwarmMessaging } from './core';
import { SwarmHistory } from './history';
import { SwarmChatUtils } from './utils';

export class SwarmComment extends SwarmMessaging {
  private startIndex: bigint;
  private reactionIndex: bigint;
  private signer: PrivateKey;

  constructor(settings: ChatSettings) {
    super(settings);

    this.signer = getPrivateKeyFromIdentifier(settings.infra.chatTopic);

    this.swarmSettings = {
      ...this.swarmSettings,
      chatAddress: this.signer.publicKey().address().toString(),
    };

    this.startIndex = -1n;
    this.reactionIndex = -1n;

    this.utils = new SwarmChatUtils(
      {
        ...this.userDetails,
        privateKey: this.signer.toString(),
        ownAddress: this.signer.publicKey().address().toString(),
      },
      this.swarmSettings,
    );
    this.history = new SwarmHistory(this.utils, this.emitter);
  }

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
      signature: this.getSignature(message),
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
          signer: this.signer,
          identifier: reactionFeedId,
          beeApiUrl: this.swarmSettings.beeUrl,
        });

        this.reactionIndex = reactionNextIndex.toBigInt();
      } else {
        const comment = await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(BigInt(nextIndex)), {
          stamp: this.swarmSettings.stamp,
          signer: this.signer,
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

  public override async retryBroadcastUserMessage(_: MessageData) {
    this.logger.warn('Not implemented: retryBroadcastUserMessage');
  }

  protected override async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

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

    if (comment?.message?.index) {
      this.userDetails.ownIndex = comment.message.index;
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

      if (!isUserComment(latestComment.message)) {
        this.logger.warn('Invalid user comment during fetching');
        return;
      }

      this.userDetails.ownIndex = latestComment.message.index;
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, latestComment.message);
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

    if (!isUserComment(commentCheck.message)) {
      this.logger.warn('Invalid user comment during write');
      return;
    }

    // TODO: id check
    if (commentCheck.message.id !== comment.id || commentCheck.message.timestamp !== comment.timestamp) {
      throw new Error(`comment check failed, expected "${comment.message}", got: "${commentCheck.message.message}".
                Expected timestamp: ${comment.timestamp}, got: ${commentCheck.message.timestamp}`);
    }
  }

  protected override async startMessagesFetchProcess() {
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
}
