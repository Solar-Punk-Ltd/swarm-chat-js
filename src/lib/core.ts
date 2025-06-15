import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { v4 as uuidv4 } from 'uuid';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { makeFeedIdentifier } from '../utils/bee';
import { remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateGsocMessage } from '../utils/validation';

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

  private gsocIndex: FeedIndex | null = null;
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

      const messages = await this.history.fetchPreviousMessages();
      return messages;
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  public async retryBroadcastUserMessage(message: MessageData) {
    await this.broadcastUserMessage(message);
  }

  private async init() {
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

      const message = await this.utils.rawSocDownload(this.swarmSettings.chatAddress, id.toString());
      const parsedMessage = JSON.parse(message);

      if (!validateGsocMessage(parsedMessage)) {
        this.logger.warn('Invalid GSOC message during fetching');
        return;
      }

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, parsedMessage.message);
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
