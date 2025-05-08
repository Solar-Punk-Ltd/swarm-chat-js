import { Bee, EthAddress, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { v4 as uuidv4 } from 'uuid';

import { makeFeedIdentifier } from '../utils/bee';
import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateGsocMessage } from '../utils/validation';

import { EVENTS } from './constants';
import { SwarmHistory } from './history';
import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData } from './types';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter: EventEmitter;
  private utils: SwarmChatUtils;
  private history: SwarmHistory;
  private userDetails: ChatSettingsUser;
  private swarmSettings: ChatSettingsSwarm;

  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private gsocIndex: FeedIndex | null = null;
  private fetchMessageTimer: NodeJS.Timeout | null = null;

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
      stamp: settings.infra.stamp || '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      enveloped: settings.infra.enveloped,
      gsocTopic: settings.infra.gsocTopic,
      gsocResourceId: settings.infra.gsocResourceId,
      chatTopic: settings.infra.chatTopic,
      chatAddress: settings.infra.chatAddress,
      messageFetchInterval: settings.infra.messageFetchInterval || 1500,
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
  }

  public getEmitter() {
    return this.emitter;
  }

  public orderMessages(messages: any[]) {
    return this.utils.orderMessages(messages);
  }

  public async sendMessage(message: string, id?: string): Promise<void> {
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
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      await this.utils.writeOwnFeedDataByIndex(nextIndex, JSON.stringify(messageObj));

      this.userDetails.ownIndex = nextIndex;

      this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, messageObj);

      // TODO - add a retry option for the user if error happens, GSOC? BUG
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
    this.sendMessage(message.message, message.id);
  }

  // TODO - add a retry option for the user if error happens, GSOC? BUG
  public async retryBroadcastUserMessage(message: MessageData) {
    this.broadcastUserMessage(message);
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

    const { latestIndex } = await this.utils.retryAwaitableAsync(
      () => this.utils.getOwnLatestFeedIndex(),
      RETRY_COUNT,
      DELAY,
    );

    this.userDetails.ownIndex = latestIndex;
  }

  // TODO - batch requests
  private async fetchLatestMessage() {
    try {
      const nextIndex = this.gsocIndex?.next();
      if (!nextIndex) {
        this.logger.error('No next index available for fetching the latest message.');
        return;
      }

      const topic = Topic.fromString(this.swarmSettings.chatTopic);
      const id = makeFeedIdentifier(topic, nextIndex);

      const message = await this.utils.rawSocDownload(this.swarmSettings.chatAddress, id.toString());

      this.logger.debug('fetchLatestMessage entry CALLED', message);

      if (!validateGsocMessage(message)) {
        this.logger.warn('Invalid GSOC message during fetching');
        return;
      }

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, JSON.parse(message));
      this.gsocIndex = nextIndex;
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.fetchLatestMessage');
    }
  }

  private async broadcastUserMessage(message: MessageData) {
    try {
      this.logger.debug('broadcastUserMessage entry CALLED');

      console.log('DEBUG broadcastUserMessage', message);

      return this.utils.retryAwaitableAsync(() => this.utils.sendMessageToGsoc(JSON.stringify(message)));
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

  private startMessagesFetchProcess() {
    const { messageFetchInterval } = this.swarmSettings;

    if (this.fetchMessageTimer) {
      this.logger.warn('Messages fetch process is already running.');
      return;
    }
    this.fetchMessageTimer = setInterval(this.fetchLatestMessage.bind(this), messageFetchInterval);
  }

  private stopMessagesFetchProcess() {
    if (this.fetchMessageTimer) {
      clearInterval(this.fetchMessageTimer);
      this.fetchMessageTimer = null;
    }
  }
}
