import { HexString } from '@solarpunkltd/gsoc/dist/types';
import { ethers, Signature } from 'ethers';
import isEqual from 'lodash/isEqual';
import { v4 as uuidv4 } from 'uuid';

import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';
import { validateGsocMessage } from '../utils/validation';
import { waitForBroadcast } from '../utils/waitForBroadcast';

import { EVENTS, SECOND } from './constants';
import { SwarmHistory } from './history';
import { ChatSettings, EthAddress, GsocMessage, GsocSubscription, User, UserMap } from './types';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter = new EventEmitter();
  private utils = new SwarmChatUtils();
  private history: SwarmHistory;

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

  private gsocResourceId: HexString<number> | null = null;
  private gsocSubscribtion: GsocSubscription | null = null;

  private privateKey: string;
  private topic: string;
  private nickname: string;
  private ownAddress: EthAddress;
  private ownIndex: number = -1;

  constructor(settings: ChatSettings) {
    this.ownAddress = settings.ownAddress;
    this.privateKey = settings.privateKey;
    this.topic = settings.topic;
    this.nickname = settings.nickname;
    this.gsocResourceId = settings.gsocResourceId;

    this.bees = this.utils.initBees(settings.bees);
    this.history = new SwarmHistory({
      gsocResourceId: this.gsocResourceId,
      bees: this.bees,
      ownAddress: this.ownAddress,
      topic: this.topic,
      emitter: this.emitter,
    });

    this.FETCH_MESSAGE_INTERVAL_TIME = settings.fetchMessageIntervalTime || this.FETCH_MESSAGE_INTERVAL_TIME;
    this.IDLE_USER_CLEANUP_INTERVAL_TIME = settings.idleUserCleanupIntervalTime || this.IDLE_USER_CLEANUP_INTERVAL_TIME;
    this.READ_MESSAGE_TIMEOUT = settings.readMessageTimeout || this.READ_MESSAGE_TIMEOUT;
  }

  public start() {
    this.init();
    this.listenToNewSubscribers();
    this.startMessagesFetchProcess();
    this.startIdleUserCleanup();
    this.history.startHistoryUpdateProcess();
  }

  public stop() {
    this.stopMessagesFetchProcess();
    this.stopIdleUserCleanup();
    this.stopListenToNewSubscribers();
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
  public async sendMessage(message: string): Promise<void> {
    const messageObj = {
      id: uuidv4(),
      username: this.nickname,
      address: this.ownAddress,
      timestamp: Date.now(),
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_SENT, messageObj);

      const nextIndex = this.ownIndex === -1 ? 0 : this.ownIndex + 1;

      await this.utils.writeUserFeedDataByIndex({
        bees: this.bees,
        userAddress: this.ownAddress,
        rawTopic: this.topic,
        index: nextIndex,
        privateKey: this.privateKey,
        data: { ...messageObj, index: this.ownIndex },
      });

      this.ownIndex = nextIndex;

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
      () => this.utils.getLatestFeedIndex(this.bees, this.topic, this.ownAddress),
      RETRY_COUNT,
      DELAY,
    );

    this.ownIndex = latestIndex;
  }

  /**
   * Starts listening for new subscribers on the main GSOC node.
   * @throws Will throw an error if the GSOC Resource ID is not defined.
   */
  private listenToNewSubscribers() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const bee = this.utils.getMainGsocBee(this.bees);

      this.logger.debug('CALLED listenToNewSubsribers', bee.url, this.topic, this.gsocResourceId);
      this.gsocSubscribtion = this.utils.subscribeToGsoc(
        bee.url,
        this.topic,
        this.gsocResourceId,
        (gsocMessage: string) => this.gsocListenerQueue.enqueue(() => this.processGsocMessage(gsocMessage)),
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
  private processGsocMessage(message: string) {
    try {
      const parsedMessage: GsocMessage = JSON.parse(message);

      if (!validateGsocMessage(parsedMessage)) {
        this.logger.warn('Invalid GSOC message during processing');
        return;
      }
      this.logger.debug('New GSOC message:', parsedMessage);

      // TODO new punishment algorithm, is it required?
      if (isEqual(this.latestMessage, parsedMessage)) {
        return;
      }

      if (parsedMessage.messageSender) {
        this.updateActiveUsers(parsedMessage.messageSender);
        this.history.processHistoryUpdaterEntry(this.activeUsers, parsedMessage.historyEntry);
      } else {
        this.history.setHistoryEntry(parsedMessage.historyEntry);
      }

      this.latestMessage = parsedMessage;
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.userRegistrationOnGsoc');
    }
  }

  private async waitForMessageBroadcast(index: number): Promise<void> {
    return waitForBroadcast<number>({
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

      const { bee, stamp } = this.utils.getGsocBee(this.bees);

      const result = await this.utils.retryAwaitableAsync(() =>
        this.utils.sendMessageToGsoc(
          bee.url,
          this.topic,
          stamp,
          this.gsocResourceId!,
          JSON.stringify({
            messageSender,
            historyEntry: this.history.getHistoryEntryWithNewUpdater(this.activeUsers),
          }),
        ),
      );

      this.logger.debug('broadcastUserMessage entry CALLED');

      if (!result?.payload.length) throw new Error('GSOC result payload is empty');
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastNewAppState');
    }
  }

  private async makeMessageSender() {
    const wallet = new ethers.Wallet(this.privateKey);
    const address = wallet.address as EthAddress;

    if (address.toLowerCase() !== this.ownAddress.toLowerCase()) {
      throw new Error('The provided address does not match the address derived from the private key');
    }

    const timestamp = Date.now();
    const signature = (await wallet.signMessage(
      JSON.stringify({ username: this.nickname, address, timestamp }),
    )) as unknown as Signature;

    return {
      address,
      timestamp,
      signature,
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
      this.messagesQueue.enqueue(() => this.readMessage(user, this.topic));
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
  private async readMessage(user: User, rawTopic: string) {
    try {
      let nextIndex;
      const readCacheState = this.isUserIndexRead(user.address, user.index);
      if (readCacheState.isIndexRead) {
        return;
      } else {
        nextIndex = readCacheState.cachedIndex ? readCacheState.cachedIndex + 1 : user.index;
      }

      const messageData = await this.utils.fetchUserFeedDataByIndex({
        rawTopic,
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

  private stopListenToNewSubscribers() {
    if (this.gsocSubscribtion) {
      this.gsocSubscribtion.ws.close();
      this.gsocSubscribtion = null;
    }
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
