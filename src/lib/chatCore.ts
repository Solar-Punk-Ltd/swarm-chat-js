import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, MessageData, MessageType, StatefulMessage } from '../interfaces';
import { makeFeedIdentifier } from '../utils/bee';
import { retryAwaitableAsync } from '../utils/common';
import { validateGsocMessage } from '../utils/validation';

import { EVENTS } from './constants';
import { SwarmMessaging } from './core';
import { SwarmHistory } from './history';
import { SwarmChatUtils } from './utils';

export class SwarmChat extends SwarmMessaging {
  private gsocIndex: FeedIndex | null = null;

  constructor(settings: ChatSettings) {
    super(settings);

    this.utils = new SwarmChatUtils(this.userDetails, this.swarmSettings);
    this.history = new SwarmHistory(this.utils, this.emitter);
  }

  public async sendMessage(
    message: string,
    type: MessageType,
    targetMessageId?: string,
    id?: string,
    _?: MessageData[],
  ): Promise<void> {
    const nextIndex = this.userDetails.ownIndex === -1 ? 0 : this.userDetails.ownIndex + 1;
    const messageObj = {
      id: id || uuidv4(),
      username: this.userDetails.nickname,
      address: this.userDetails.ownAddress,
      chatTopic: this.swarmSettings.chatTopic,
      userTopic: this.utils.generateUserOwnedFeedId(this.swarmSettings.chatTopic, this.userDetails.ownAddress),
      signature: this.getSignature(),
      timestamp: Date.now(),
      index: nextIndex,
      type,
      targetMessageId,
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      await this.utils.writeOwnFeedDataByIndex(nextIndex, JSON.stringify(messageObj));

      this.userDetails.ownIndex = nextIndex;

      this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, messageObj);

      await this.broadcastUserMessage(messageObj);
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Chat.sendMessage');
    }
  }

  public async fetchPreviousMessages() {
    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);

      await this.history.fetchPreviousMessageState();
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public override async retryBroadcastUserMessage(message: MessageData) {
    await this.broadcastUserMessage(message);
  }

  protected override async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      const [ownIndexResult, historyInitResult] = await Promise.allSettled([this.initOwnIndex(), this.history.init()]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      if (historyInitResult.status === 'fulfilled') {
        this.gsocIndex = historyInitResult.value;
      }

      this.emitter.emit(EVENTS.LOADING_INIT, false);
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.initSelfState');
      this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
    }
  }

  private async initOwnIndex() {
    const RETRY_COUNT = 10;
    const DELAY = 1000;

    const { latestIndex } = await retryAwaitableAsync(() => this.utils.getOwnLatestFeedIndex(), RETRY_COUNT, DELAY);

    this.userDetails.ownIndex = latestIndex;
  }

  // TODO - batch requests
  private async fetchLatestMessage() {
    try {
      if (!this.gsocIndex) {
        return;
      }

      const topic = Topic.fromString(this.swarmSettings.chatTopic);
      const id = makeFeedIdentifier(topic, this.gsocIndex);

      const data = await this.utils.rawSocDownload(this.swarmSettings.chatAddress, id.toString());
      const parsedData = JSON.parse(data) as StatefulMessage;

      if (!validateGsocMessage(parsedData)) {
        this.logger.warn('Invalid GSOC message during fetching');
        return;
      }

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, parsedData.message);
      this.gsocIndex = this.gsocIndex.next();
    } catch (error: any) {
      if (this.utils.isNotFoundError(error)) {
        return;
      }

      this.errorHandler.handleError(error, 'Chat.fetchLatestMessage');
    }
  }

  private async broadcastUserMessage(message: MessageData) {
    try {
      return retryAwaitableAsync(() => this.utils.sendMessageToGsoc(JSON.stringify(message)));
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastUserMessage');
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

      await this.fetchLatestMessage();
      setTimeout(poll, 200); // with a little delay
    };

    poll();
  }
}
