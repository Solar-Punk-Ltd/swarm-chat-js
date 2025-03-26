import { EthAddress, PrivateKey } from '@upcoming/bee-js';
import isEqual from 'lodash/isEqual';
import { v4 as uuidv4 } from 'uuid';

import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';
import { validateGsocMessage } from '../utils/validation';
import { waitForBroadcast } from '../utils/waitForBroadcast';

import { EVENTS, SECOND } from './constants';
import { SwarmEventEmitterReader } from './contract';
import { SwarmHistory } from './history';
import { ChatSettings, MessageData, User, UserMap } from './types';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter = new EventEmitter();
  private utils = new SwarmChatUtils();
  private history: SwarmHistory;
  private swarmEventEmitterReader: SwarmEventEmitterReader;

  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private bees;
  private messagesQueue = new Queue({ clearWaitTime: 200 });
  private gsocListenerQueue = new Queue({ clearWaitTime: 200 });

  private fetchMessageTimer: NodeJS.Timeout | null = null;
  private idleUserCleanupInterval: NodeJS.Timeout | null = null;

  private FETCH_MESSAGE_INTERVAL_TIME = 1000;
  private IDLE_USER_CLEANUP_INTERVAL_TIME = 5000;
  private READ_MESSAGE_TIMEOUT = 1500;

  private activeUsers: UserMap = {};
  private latestMessage: any | null = null;
  private userIndexCache: Record<string, number> = {};

  private gsocResourceId: string | null = null;

  private privateKey: string;
  private gsocTopic: string;
  private chatTopic: string;
  private ownAddress: string;
  private swarmEmitterAddress: string;
  private nickname: string;
  private ownIndex = -1;

  // TODO: handle retry case when only soc send goes through, nothing goes through
  constructor(settings: ChatSettings) {
    this.ownAddress = remove0x(settings.ownAddress);
    this.privateKey = settings.privateKey;
    this.gsocTopic = settings.gsocTopic;
    this.chatTopic = settings.chatTopic;
    this.nickname = settings.nickname;
    this.gsocResourceId = settings.gsocResourceId;
    this.swarmEmitterAddress = settings.swarmEmitterAddress;

    this.bees = this.utils.initBees(settings.bees);
    this.history = new SwarmHistory({
      gsocResourceId: this.gsocResourceId,
      bees: this.bees,
      ownAddress: this.ownAddress,
      gsocTopic: this.gsocTopic,
      chatTopic: this.chatTopic,
      emitter: this.emitter,
      swarmEmitterAddress: this.swarmEmitterAddress,
    });
    this.swarmEventEmitterReader = new SwarmEventEmitterReader(
      settings.rpcUrl,
      settings.contractAddress,
      settings.swarmEmitterAddress,
    );

    this.FETCH_MESSAGE_INTERVAL_TIME = settings.fetchMessageIntervalTime || this.FETCH_MESSAGE_INTERVAL_TIME;
    this.IDLE_USER_CLEANUP_INTERVAL_TIME = settings.idleUserCleanupIntervalTime || this.IDLE_USER_CLEANUP_INTERVAL_TIME;
    this.READ_MESSAGE_TIMEOUT = settings.readMessageTimeout || this.READ_MESSAGE_TIMEOUT;
  }

  public start() {
    this.init();
    this.subscribeToGSOCEvent();
    this.startMessagesFetchProcess();
    this.startIdleUserCleanup();
    this.history.startHistoryUpdateProcess();
  }

  public stop() {
    this.stopMessagesFetchProcess();
    this.stopIdleUserCleanup();
    this.unsubFromGSOCEvent();
    this.history.stopHistoryUpdateProcess();
    this.emitter.cleanAll();
  }

  public getEmitter() {
    return this.emitter;
  }

  public orderMessages(messages: any[]) {
    return this.utils.orderMessages(messages);
  }

  /**
   * Sends a message to the chat by uploading it to a decentralized storage system and updating the feed index
   * after updating the feed index, the message is broadcasted to all subscribers.
   * @param message The message content to send.
   * @returns Resolves when the message is successfully broadcasted
   * @throws Will emit a `MESSAGE_REQUEST_ERROR` event if an error occurs during the process.
   */
  public async sendMessage(message: string, id?: string): Promise<void> {
    const nextIndex = this.ownIndex === -1 ? 0 : this.ownIndex + 1;
    const messageObj = {
      id: id || uuidv4(),
      username: this.nickname,
      address: this.ownAddress,
      timestamp: Date.now(),
      index: nextIndex,
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      await this.utils.writeUserFeedDataByIndex({
        bees: this.bees,
        userAddress: this.ownAddress,
        chatTopicBase: this.chatTopic,
        index: nextIndex,
        privateKey: this.privateKey,
        data: messageObj,
      });

      this.ownIndex = nextIndex;

      this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, messageObj);

      await this.waitForMessageBroadcast(nextIndex);
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Chat.sendMessage');
    }
  }

  /**
   * Fetches the previous 10 latest messages of the chat
   * @returns Resolves with the fetched messages.
   */
  public async fetchPreviousMessages() {
    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);
      const messages = await this.history.fetchPreviousMessages({ preDownloadHistory: true });
      return messages;
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.id);
  }

  public async retryBroadcastUserMessage(message: MessageData) {
    this.waitForMessageBroadcast(message.index);
  }

  /**
   * Initializes the user's own feed index by retrieving the latest index from Bee storage
   * also initializes the chat history if it exists and tries to load the latest 10 messages.
   * @throws Will emit a `CRITICAL_ERROR` event if the self index initialization fails. If the history init fails, a warning will be logged.
   * @returns Resolves when at least the self-index is successfully initialized.
   */
  private async init() {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      const [ownIndexResult, historyInitResult] = await Promise.allSettled([this.initOwnIndex(), this.history.init()]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      // TODO retry option for user if error happens
      if (historyInitResult.status === 'rejected') {
        this.logger.warn(`historyInitResult failed: ${historyInitResult.reason}`);
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
      () => this.utils.getLatestFeedIndex(this.bees, this.chatTopic, this.ownAddress),
      RETRY_COUNT,
      DELAY,
    );

    this.ownIndex = latestIndex;
  }

  /**
   * Starts listening for new subscribers on the main GSOC node.
   * @throws Will throw an error if the GSOC Resource ID is not defined.
   */
  private subscribeToGSOCEvent() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      this.swarmEventEmitterReader.onMessageFrom((_sender: string, event: string) =>
        this.gsocListenerQueue.enqueue(() => this.processGsocEvent(event)),
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.listenToNewSubscribers');
      this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
    }
  }

  /**
   * GSOC message handler that processes an incoming messages
   *
   * This handler updates the active users for message reading if the message is valid.
   * It also saves the latest history entry or gives a signal for a new history entiry creation.
   *
   * At the moment there are two types of messages.
   * User message with an actual chat message and a history entry that marks the next history updater.
   * History message which is the latest known history entry.
   * TODO - should these messages be separated on different GSOC nodes?
   *
   * @param gsocMessage - The GSOC message as a JSON string containing user data and history entry.
   */
  // TODO any
  private async processGsocEvent(event: string) {
    try {
      console.log('processGsocMessage CALLED', event);
      const [topic, index] = event.split('_');

      const message = await this.utils.fetchChatMessage(this.bees, topic, this.swarmEmitterAddress, index);

      if (!validateGsocMessage(message)) {
        this.logger.warn('Invalid GSOC message during processing');
        return;
      }
      this.logger.debug('New GSOC message:', message);

      // TODO new punishment algorithm, is it required?
      if (isEqual(this.latestMessage, message)) {
        return;
      }

      if (message.messageSender) {
        this.updateActiveUsers(message.messageSender);
        this.history.processHistoryUpdaterEntry(this.activeUsers, message.historyEntry);
      } else {
        this.history.setHistoryEntry(message.historyEntry);
      }

      this.latestMessage = message;
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.processGsocMessage');
    }
  }

  private async waitForMessageBroadcast(index: number): Promise<void> {
    return waitForBroadcast<void>({
      condition: () => Object.values(this.activeUsers).some((user) => user.index === index),
      broadcast: () => this.broadcastUserMessage(),
    });
  }

  /**
   * Broadcasts a message to all the listeners thorugh a GSOC node.
   * The new message will mark the next history updater.
   * @throws Will throw an error if the GSOC Resource ID is not defined.
   * @thorws If the broadcast result is invalid
   */
  private async broadcastUserMessage() {
    try {
      this.logger.debug('broadcastUserMessage entry CALLED');
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const messageSender = await this.makeMessageSender();

      console.log('DEBUG broadcastUserMessage', messageSender);

      await this.utils.retryAwaitableAsync(() =>
        this.utils.sendMessageToGsoc(
          this.bees,
          this.gsocTopic,
          this.gsocResourceId!,
          JSON.stringify({
            messageSender,
            historyEntry: this.history.getHistoryEntryWithNewUpdater(this.activeUsers),
          }),
        ),
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastUserMessage');
    }
  }

  private async makeMessageSender() {
    const ownAddress = new EthAddress(this.ownAddress).toString();

    const signer = new PrivateKey(this.privateKey);
    const signerAddress = signer.publicKey().address().toString();

    if (signerAddress !== ownAddress) {
      throw new Error('The provided address does not match the address derived from the private key');
    }

    const timestamp = Date.now();
    const signature = signer.sign(JSON.stringify({ username: this.nickname, address: ownAddress, timestamp }));

    return {
      address: ownAddress,
      timestamp,
      signature: signature.toHex(),
      index: this.getOwnIndex(),
      username: this.nickname,
    };
  }

  private async readAllActiveUserMessage() {
    // Return when the previous batch is still processing
    const isWaiting = await this.messagesQueue.waitForProcessing();
    if (isWaiting) {
      return;
    }

    for (const user of Object.values(this.activeUsers)) {
      this.messagesQueue.enqueue(() => this.readMessage(user, this.chatTopic));
    }
  }

  /**
   * Reads a message from a specific user feed.
   * The retrieved message is emitted to the MESSAGE_RECEIVED event.
   * The function maintains a local index cache preventing the same message from being read multiple times
   * and to make sure that all messages are read in order.
   * @param user - The user for whom the message is being read.
   * @param rawTopic - The topic associated with the user's feed.
   * @returns Resolves when the message is successfully processed.
   */

  // TODO skip message if fails to many times
  private async readMessage(user: User, chatTopic: string) {
    try {
      let nextIndex: number;
      const readCacheState = this.isUserIndexRead(user.address, user.index);

      if (readCacheState.isIndexRead) {
        return;
      } else {
        nextIndex = readCacheState.cachedIndex ? readCacheState.cachedIndex + 1 : user.index;
      }

      const messageData = await this.utils.fetchUserFeedDataByIndex({
        chatTopicBase: chatTopic,
        bees: this.bees,
        userAddress: user.address,
        index: nextIndex,
      });

      this.setUserIndexCache(user.address, nextIndex);
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, messageData);
    } catch (error) {
      this.errorHandler.handleError(error, 'readMessage');
    }
  }

  private unsubFromGSOCEvent() {
    this.swarmEventEmitterReader.removeAllListeners();
  }

  private startMessagesFetchProcess() {
    if (this.fetchMessageTimer) {
      this.logger.warn('Messages fetch process is already running.');
      return;
    }
    this.fetchMessageTimer = setInterval(this.readAllActiveUserMessage.bind(this), this.FETCH_MESSAGE_INTERVAL_TIME);
  }

  private stopMessagesFetchProcess() {
    if (this.fetchMessageTimer) {
      clearInterval(this.fetchMessageTimer);
      this.fetchMessageTimer = null;
    }
  }

  private startIdleUserCleanup(): void {
    if (this.idleUserCleanupInterval) {
      this.logger.warn('Idle user cleanup is already running.');
      return;
    }
    this.idleUserCleanupInterval = setInterval(this.removeIdleUsers.bind(this), this.IDLE_USER_CLEANUP_INTERVAL_TIME);
  }

  private stopIdleUserCleanup(): void {
    if (this.idleUserCleanupInterval) {
      clearInterval(this.idleUserCleanupInterval);
      this.idleUserCleanupInterval = null;
    }
  }

  private isUserIndexRead(userAddress: string, checkIndex: number) {
    const cachedIndex = this.userIndexCache[userAddress];
    return { cachedIndex, isIndexRead: cachedIndex === checkIndex };
  }

  private setUserIndexCache(address: string, index: number) {
    this.userIndexCache[address] = index;
  }

  private getOwnIndex() {
    return this.ownIndex;
  }

  private removeIdleUsers() {
    const now = Date.now();
    for (const user of Object.values(this.activeUsers)) {
      if (now - user.timestamp > 300 * SECOND) {
        delete this.activeUsers[user.address];
      }
    }
  }

  private updateActiveUsers(messageSender: User) {
    this.activeUsers[messageSender.address] = messageSender;
  }
}
