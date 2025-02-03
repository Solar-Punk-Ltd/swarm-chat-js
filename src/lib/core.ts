import { HexString } from '@solarpunkltd/gsoc/dist/types';
import { Mutex } from 'async-mutex';
import { ethers, Signature } from 'ethers';
import isEqual from 'lodash/isEqual';
import { v4 as uuidv4 } from 'uuid';

import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';
import { validateGsocMessage } from '../utils/validation';

import { EVENTS, SECOND } from './constants';
import { SwarmHistory } from './history';
import { ChatSettings, EthAddress, GsocMessage, GsocSubscribtion, User, UserMap } from './types';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter = new EventEmitter();
  private utils = new SwarmChatUtils();
  private history: SwarmHistory;

  private logger = new Logger();
  private errorHandler = new ErrorHandler(this.logger);
  private mutex = new Mutex();

  private bees;
  private messagesQueue = new Queue({ clearWaitTime: 200 });
  private gsocListenerQueue = new Queue({ clearWaitTime: 200 });

  private fetchMessageTimer: NodeJS.Timeout | null = null;
  private idleUserCleanupInterval: NodeJS.Timeout | null = null;

  private FETCH_MESSAGE_INTERVAL_TIME = 1000;
  private IDLE_USER_CLEANUP_INTERVAL_TIME = 5000;
  private READ_MESSAGE_TIMEOUT = 1500;

  private activeUsers: UserMap = {};
  private latestMessageSender: User | null = null;
  private userIndexCache: Record<string, number> = {};

  private gsocResourceId: HexString<number> | null = null;
  private gsocSubscribtion: GsocSubscribtion | null = null;

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
    this.history = new SwarmHistory(this.bees, this.gsocResourceId, this.topic, this.ownAddress);

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

  private async initOwnIndex() {
    const feedID = this.utils.generateUserOwnedFeedId(this.topic, this.ownAddress);

    const readerBee = this.utils.getReaderBee(this.bees);
    const feedTopicHex = readerBee.makeFeedTopic(feedID);

    const { latestIndex } = await this.utils.retryAwaitableAsync(() =>
      this.utils.getLatestFeedIndex(readerBee, feedTopicHex, this.ownAddress),
    );

    this.ownIndex = latestIndex;
  }

  /**
   * Initializes the user's own feed index by retrieving the latest index from Bee storage.
   * @returns Resolves when the self-index is successfully initialized.
   */
  private async init() {
    try {
      // TODO: rename event
      this.emitter.emit(EVENTS.LOADING_INIT_USERS, true);

      const [ownIndexResult, historyInitResult] = await Promise.allSettled([this.initOwnIndex(), this.history.init()]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      if (historyInitResult.status === 'rejected') {
        this.logger.warn(`historyInitResult failed: ${historyInitResult.reason}`);
      }

      this.emitter.emit(EVENTS.LOADING_INIT_USERS, false);
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.initSelfState');
    }
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

      this.logger.debug('CALLED listenToNewSubsribers');
      this.gsocSubscribtion = this.utils.subscribeToGsoc(
        bee.url,
        this.topic,
        this.gsocResourceId,
        (gsocMessage: string) => this.gsocListenerQueue.enqueue(() => this.processGsocMessage(gsocMessage)),
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.listenToNewSubscribers');
    }
  }

  /**
   * Sends a message to the chat by uploading it to a decentralized storage system and updating the feed index.
   * @param message The message content to send.
   * @returns Resolves when the message is successfully sent.
   * @throws Will emit a `MESSAGE_REQUEST_ERROR` event if an error occurs during the process.
   */
  public async sendMessage(message: string): Promise<void> {
    const release = await this.mutex.acquire();

    const messageObj = {
      id: uuidv4(),
      username: this.nickname,
      address: this.ownAddress,
      timestamp: Date.now(),
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_SENT, messageObj);

      const { bee, stamp } = this.utils.getWriterBee(this.bees);

      const feedID = this.utils.generateUserOwnedFeedId(this.topic, this.ownAddress);
      const feedTopicHex = bee.makeFeedTopic(feedID);
      const feedWriter = bee.makeFeedWriter('sequence', feedTopicHex, this.privateKey);

      const nextIndex = this.ownIndex === -1 ? 0 : this.ownIndex + 1;

      const msgData = await this.utils.retryAwaitableAsync(() =>
        this.utils.uploadObjectToBee(bee, { ...messageObj, index: this.ownIndex }, stamp),
      );
      if (!msgData) throw new Error('Uploaded message data is empty');

      await feedWriter.upload(stamp, msgData.reference, {
        index: nextIndex,
      });

      this.ownIndex = nextIndex;

      await this.broadcastUserMessage();
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Chat.sendMessage');
    } finally {
      release();
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

  /**
   * TODO: Add description
   */
  private async broadcastUserMessage() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const messageSender = await this.makeMessageSender();

      const { bee, stamp } = this.utils.getGsocBee(this.bees);

      const RETRY_COUNT = 5;
      const result = await this.utils.retryAwaitableAsync(
        () =>
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
        RETRY_COUNT,
      );

      if (!result?.payload.length) throw new Error('GSOC result payload is empty');
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastNewAppState');
    }
  }

  public orderMessages(messages: any[]) {
    return this.utils.orderMessages(messages);
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
    this.latestMessageSender = messageSender;
  }

  /**
   * Handles user registration through the GSOC system by processing incoming GSOC messages.
   * @param gsocMessage The GSOC message in JSON string format containing user data.
   */
  private processGsocMessage(message: string) {
    try {
      const parsedMessage: GsocMessage = JSON.parse(message);

      if (!validateGsocMessage(parsedMessage)) {
        this.logger.warn('Invalid GSOC message during processing');
        return;
      }

      // TODO new punishment algorithm, is it required?
      if (isEqual(this.latestMessageSender, parsedMessage.messageSender)) {
        return;
      }

      if (parsedMessage.messageSender) {
        this.updateActiveUsers(parsedMessage.messageSender);
        this.history.processHistoryEntry(this.activeUsers, parsedMessage.historyEntry);
      } else {
        this.history.setHistoryEntry(parsedMessage.historyEntry);
      }

      this.logger.debug('New GSOC message:', parsedMessage);
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.userRegistrationOnGsoc');
    }
  }

  private async readMessagesForAll() {
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
   * Reads a message for a specific user from the decentralized storage.
   * This function handles message retrieval and emits the message event upon success.
   * @param user - The user for whom the message is being read.
   * @param rawTopic - The topic associated with the user's chat.
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

      const bee = this.utils.getReaderBee(this.bees);

      const chatID = this.utils.generateUserOwnedFeedId(rawTopic, user.address);
      const topic = bee.makeFeedTopic(chatID);
      const feedReader = bee.makeFeedReader('sequence', topic, user.address, {
        timeout: this.READ_MESSAGE_TIMEOUT,
      });

      const recordPointer = await feedReader.download({ index: nextIndex });
      const data = await bee.downloadData(recordPointer.reference, {
        headers: {
          'Swarm-Redundancy-Level': '0',
        },
      });
      const messageData = JSON.parse(new TextDecoder().decode(data));

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, messageData);
      this.setUserIndexCache(user.address, nextIndex);
    } catch (error) {
      this.errorHandler.handleError(error, 'readMessage');
    } finally {
      // consider users available when at least one message tried to be read
      /*     if (this.ownAddress === user.address) {
        this.emitter.emit(EVENTS.LOADING_INIT_USERS, false);
      } */
    }
  }

  private stopListenToNewSubscribers() {
    this.logger.debug('CALLED stopListenToNewSubscribers');
    if (this.gsocSubscribtion) {
      this.logger.debug('CALLED stopListenToNewSubscribers close');
      this.gsocSubscribtion.close();
      this.gsocSubscribtion = null;
    }
  }

  private startMessagesFetchProcess() {
    if (this.fetchMessageTimer) {
      this.logger.warn('Messages fetch process is already running.');
      return;
    }
    this.fetchMessageTimer = setInterval(this.readMessagesForAll.bind(this), this.FETCH_MESSAGE_INTERVAL_TIME);
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
}
