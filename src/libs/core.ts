import { HexString } from '@solarpunkltd/gsoc/dist/types';
import { ethers, Signature } from 'ethers';
import isEqual from 'lodash/isEqual';
import { v4 as uuidv4 } from 'uuid';

import { sleep } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';

import { EVENTS, SECOND } from './constants';
import { AppState, BeeType, ChatSettings, EthAddress, GsocSubscribtion, UserWithIndex } from './types';
import { SwarmChatUtils } from './utils';

export class SwarmChat {
  private emitter = new EventEmitter();
  private utils = new SwarmChatUtils();

  private logger = new Logger();
  private errorHandler = new ErrorHandler(this.logger);

  private bees;
  private messagesQueue = new Queue({ clearWaitTime: 200 });
  private gsocListenerQueue = new Queue({ clearWaitTime: 200 });

  private fetchMessageTimer: NodeJS.Timeout | null = null;
  private idleUserCleanupInterval: NodeJS.Timeout | null = null;

  private FETCH_MESSAGE_INTERVAL_TIME = 1000;
  private IDLE_USER_CLEANUP_INTERVAL_TIME = 5000;
  private READ_MESSAGE_TIMEOUT = 1500;

  // local app states
  private events: any = {}; // WIP - empty for now
  private activeUsers: Record<string, UserWithIndex> = {};
  private allTimeUsers: Record<string, UserWithIndex> = {};
  private latestMessageSender: UserWithIndex | null = null;
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

    this.FETCH_MESSAGE_INTERVAL_TIME = settings.fetchMessageIntervalTime || this.FETCH_MESSAGE_INTERVAL_TIME;
    this.IDLE_USER_CLEANUP_INTERVAL_TIME = settings.idleUserCleanupIntervalTime || this.IDLE_USER_CLEANUP_INTERVAL_TIME;
    this.READ_MESSAGE_TIMEOUT = settings.readMessageTimeout || this.READ_MESSAGE_TIMEOUT;
  }

  public start() {
    this.initSelfState();
    //this.listenToNewSubscribers();
    //this.startMessagesFetchProcess();
    //this.startIdleUserCleanup();
  }

  public stop() {
    this.stopListenToNewSubscribers();
    this.stopMessagesFetchProcess();
    this.stopIdleUserCleanup();
    this.emitter.cleanAll();
  }

  public getEmitter() {
    return this.emitter;
  }

  /**
   * Initializes the user's own feed index by retrieving the latest index from Bee storage.
   * @returns Resolves when the self-index is successfully initialized.
   */
  public async initSelfState() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const feedID = this.utils.generateUserOwnedFeedId(this.topic, this.ownAddress);

      const readerBee = this.getReaderBee();
      const feedTopicHex = readerBee.makeFeedTopic(feedID);

      const { latestIndex } = await this.utils.retryAwaitableAsync(() =>
        this.utils.getLatestFeedIndex(readerBee, feedTopicHex, this.ownAddress),
      );
      this.ownIndex = latestIndex;

      // the main GSOC contains the latest state of the GSOC updates
      const mainGsocBee = this.getMainGsocBee();
      const initGsocData = await this.utils.fetchLatestGsocMessage(mainGsocBee.url, this.topic, this.gsocResourceId);
      this.logger.debug('initGsocData', initGsocData);
      this.setLocalAppStates(initGsocData);

      await this.broadcastNewAppState();
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.initSelfState');
    }
  }

  /**
   * Starts listening for new subscribers on the main GSOC node.
   * @throws Will throw an error if the GSOC Resource ID is not defined.
   */
  public listenToNewSubscribers() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      this.emitter.emit(EVENTS.LOADING_INIT_USERS, true);

      const bee = this.getMainGsocBee();

      this.gsocSubscribtion = this.utils.subscribeToGsoc(
        bee.url,
        this.topic,
        this.gsocResourceId,
        (gsocMessage: string) => this.gsocListenerQueue.enqueue(() => this.userRegistrationOnGsoc(gsocMessage)),
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
    const messageObj = {
      id: uuidv4(),
      username: this.nickname,
      address: this.ownAddress,
      timestamp: Date.now(),
      message,
    };

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_SENT, messageObj);

      const { bee, stamp } = this.getWriterBee();

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
      // do not allow a new message till the latest is read
      // TODO other solution
      await this.broadcastNewAppState();
      while (!this.isUserIndexRead(this.ownAddress, this.ownIndex).isIndexRead) {
        await sleep(200);
      }
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Chat.sendMessage');
    }
  }

  /**
   * TODO: Add description
   */
  async broadcastNewAppState() {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const wallet = new ethers.Wallet(this.privateKey);
      const address = wallet.address as EthAddress;

      if (address.toLowerCase() !== this.ownAddress.toLowerCase()) {
        throw new Error('The provided address does not match the address derived from the private key');
      }

      const timestamp = Date.now();
      const signature = (await wallet.signMessage(
        JSON.stringify({ username: this.nickname, address, timestamp }),
      )) as unknown as Signature;

      const newUser = {
        address,
        timestamp,
        signature,
        index: this.getOwnIndex(),
        username: this.nickname,
      };

      if (!this.utils.validateUserObject(newUser)) {
        throw new Error('User object validation failed');
      }

      const { bee, stamp } = this.getGsocBee();

      const result = await this.utils.sendMessageToGsoc(
        bee.url,
        stamp,
        this.topic,
        this.gsocResourceId,
        JSON.stringify({
          messageSender: newUser,
          activeUsers: this.activeUsers,
          allTimeUsers: this.allTimeUsers,
          events: this.events,
        }),
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
      if (now - user.timestamp > 30 * SECOND) {
        delete this.activeUsers[user.address];
      }
    }
  }

  private setLocalAppStates(appState: AppState) {
    if (!this.utils.validateLocalAppState(appState)) {
      this.logger.warn('Invalid app state set');
      return;
    }

    const { messageSender, activeUsers, allTimeUsers, events } = appState;
    this.events = events;
    this.activeUsers = activeUsers;
    this.allTimeUsers = allTimeUsers;
    this.latestMessageSender = messageSender;
  }

  // TODO - safe check for overwrite attack
  private updateLocalAppStates(appState: AppState) {
    if (!this.utils.validateLocalAppState(appState) || appState.messageSender === null) {
      this.logger.warn('Invalid app state update');
      return;
    }

    const { messageSender } = appState;
    // this.events = events; // TODO: update events
    this.activeUsers[messageSender.address] = messageSender;
    this.allTimeUsers[messageSender.address] = messageSender;
    this.latestMessageSender = messageSender;
  }

  /**
   * Handles user registration through the GSOC system by processing incoming GSOC messages.
   * @param gsocMessage The GSOC message in JSON string format containing user data.
   */
  private userRegistrationOnGsoc(gsocMessage: string) {
    try {
      // TODO: any
      let appState: AppState;
      try {
        appState = JSON.parse(gsocMessage);
      } catch (parseError) {
        this.logger.error('Failed to parse GSOC message:', parseError, gsocMessage);
        return;
      }

      // TODO validate appState
      // Do not process the same message twice
      if (isEqual(this.latestMessageSender, appState.messageSender)) {
        return;
      }

      this.updateLocalAppStates(appState);
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
  private async readMessage(user: UserWithIndex, rawTopic: string) {
    try {
      let nextIndex;
      const readCacheState = this.isUserIndexRead(user.address, user.index);
      if (readCacheState.isIndexRead) {
        return;
      } else {
        nextIndex = readCacheState.cachedIndex ? readCacheState.cachedIndex + 1 : user.index;
      }

      const bee = this.getReaderBee();

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
      if (this.ownAddress === user.address) {
        this.emitter.emit(EVENTS.LOADING_INIT_USERS, false);
      }
    }
  }

  private stopListenToNewSubscribers() {
    if (this.gsocSubscribtion) {
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

  private getMainGsocBee() {
    const { bee } = this.utils.selectBee(this.bees, BeeType.GSOC, true);
    if (!bee) {
      throw new Error('Could not get main GSOC bee');
    }
    return bee;
  }

  private getGsocBee() {
    const { bee, stamp } = this.utils.selectBee(this.bees, BeeType.GSOC);
    if (!bee) {
      throw new Error('Could not get GSOC bee');
    }
    if (!stamp) {
      throw new Error('Could not get valid gsoc stamp');
    }
    return { bee, stamp };
  }

  private getReaderBee() {
    const { bee } = this.utils.selectBee(this.bees, BeeType.READER);
    if (!bee) {
      throw new Error('Could not get reader bee');
    }
    return bee;
  }

  private getWriterBee() {
    const { bee, stamp } = this.utils.selectBee(this.bees, BeeType.WRITER);
    if (!bee) {
      throw new Error('Could not get writer bee');
    }
    if (!stamp) {
      throw new Error('Could not get valid writer stamp');
    }
    return { bee, stamp };
  }
}
