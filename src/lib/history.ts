import { Mutex } from 'async-mutex';
import mergeWith from 'lodash/fp/mergeWith';

import { mergeUnique } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';
import { validateChatHistory, validateGsocMessage } from '../utils/validation';
import { waitForBroadcast } from '../utils/waitForBroadcast';

import { EVENTS } from './constants';
import {
  ChatEvent,
  ChatHistory,
  ChatHistoryEntry,
  GsocMessage,
  InitializedBees,
  MessageEntry,
  UserHistoryMap,
  UserMap,
  UserMessageEntry,
} from './types';
import { SwarmChatUtils } from './utils';

/**
 * Responsible for maintaining the chat history and updating it based on incoming GSOC messages.
 */
export class SwarmHistory {
  private emitter: EventEmitter;
  private utils = new SwarmChatUtils();

  private mutex = new Mutex();
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private messagesQueue = new Queue({ clearWaitTime: 200 });

  private historyEntry: ChatHistoryEntry;
  private history: ChatHistory = {
    allTimeUsers: {},
  };

  private bees: InitializedBees;
  private gsocResourceId: string;
  private topic: string;
  private ownAddress: string;

  private processedUpdaterRefs = new Set();
  private loadedMessagesCache: Set<string> = new Set();
  private updaterEntryBuffer: ChatHistoryEntry[] = [];

  private historyUpdateTimer: NodeJS.Timeout | null = null;
  private HISTORY_UPDATE_INTERVAL_TIME = 5000;
  private MAX_LOADED_MESSAGES_CACHE_SIZE = 10;

  constructor(params: {
    bees: InitializedBees;
    emitter: EventEmitter;
    gsocResourceId: string;
    topic: string;
    ownAddress: string;
  }) {
    this.bees = params.bees;
    this.gsocResourceId = params.gsocResourceId;
    this.emitter = params.emitter;
    this.topic = params.topic;
    this.ownAddress = params.ownAddress;
  }

  /**
   * Sets the last known history entry from the last known GSOC message or initializes a new one if none is found.
   * Upon succesful entry retrieval, fetches the history data and loads the latest 10 messages.
   */
  public async init() {
    const entry = await this.fetchLatestHistoryEntry();

    if (!this.historyEntry && !entry) {
      this.initializeDefaultEntry();
      return;
    }

    if (entry?.ref) {
      this.setHistoryEntry(entry);

      const history = await this.fetchHistory(entry);
      this.history = history || this.history;
      this.trimHistory();

      await this.fetchPreviousMessages({
        preDownloadHistory: false,
      });
    }
  }

  public startHistoryUpdateProcess() {
    if (this.historyUpdateTimer) {
      this.logger.warn('History update process is already running.');
      return;
    }
    this.historyUpdateTimer = setInterval(this.createHistoryEntry.bind(this), this.HISTORY_UPDATE_INTERVAL_TIME);
  }

  public stopHistoryUpdateProcess() {
    if (this.historyUpdateTimer) {
      clearInterval(this.historyUpdateTimer);
      this.historyUpdateTimer = null;
    }
  }

  public getHistoryEntryWithNewUpdater(activeUsers: UserMap): ChatHistoryEntry {
    return {
      ...this.historyEntry,
      updater: this.chooseNewUpdater(activeUsers),
    };
  }

  public setHistoryEntry(historyEntry: ChatHistoryEntry): void {
    this.historyEntry = historyEntry;
  }

  /**
   * Updates the local history based on the incoming new GSOC message.
   * If the updater is the current user, the message is added to an entry buffer for later processing.
   * Shares a mutex with the history update process, to ensure that the buffer, updaterEntryBuffer, is updated correctly.
   * @param activeUsers The currently active users in the chat.
   * @param updaterEntry The current history updater entry.
   */
  public async processHistoryUpdaterEntry(activeUsers: UserMap, updaterEntry: ChatHistoryEntry) {
    const release = await this.mutex.acquire();

    try {
      this.updateLocalHistory(activeUsers);

      if (updaterEntry.updater === this.ownAddress) {
        this.updaterEntryBuffer.push(updaterEntry);
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.processHistoryUpdaterEntry');
    } finally {
      release();
    }
  }

  /**
   * Fetches the latest 10 messages from the chat history and reads then emits them to the MESSAGE_RECEIVED event.
   * Shares a mutex with the history update process, to ensure that the history is not updated while fetching messages.
   * @param options Options for fetching the previous messages.
   */
  public async fetchPreviousMessages(options: { preDownloadHistory: boolean }) {
    const release = await this.mutex.acquire();

    try {
      const latestHistory = options.preDownloadHistory ? await this.fetchHistory(this.historyEntry) : null;

      const { allTimeUsers } = latestHistory ? this.mergeChatHistory(latestHistory, this.history) : this.history;

      const latestMessages = this.selectLatestMessages(allTimeUsers);

      if (latestMessages.length > 0) {
        await this.readAllMessageEntry(latestMessages);
      }
    } finally {
      release();
    }
  }

  /**
   * Creates a new history entry based on the current chat history and broadcasts it to the GSOC.
   * Relies on a shared buffer, updateEntryBuffer to handle updates if messages are received in quick succession.
   * Also it tries to always select best available entry for update.
   * Waits for the broadcast to be successful before cleaning up the buffer and marking the updater as processed.
   */
  private async createHistoryEntry() {
    const release = await this.mutex.acquire();

    try {
      const latestUpdaterEntry = this.selectBestEntryForUpdate([...this.updaterEntryBuffer]);
      if (!latestUpdaterEntry || this.processedUpdaterRefs.has(latestUpdaterEntry.ref)) {
        this.cleanupUpdaterEntryBuffer(latestUpdaterEntry?.id);
        return;
      }

      const latestKnownHistory = latestUpdaterEntry.ref ? await this.fetchHistory(this.historyEntry) : null;
      const newHistory = latestKnownHistory ? this.mergeChatHistory(latestKnownHistory, this.history) : this.history;
      const newHistoryRef = await this.uploadHistory(newHistory);

      const newEntry = this.createNewHistoryEntry(newHistoryRef);
      await this.waitForHistoryEntryBroadcast(newEntry);

      this.cleanupUpdaterEntryBuffer(latestUpdaterEntry.id);
      this.processedUpdaterRefs.add(latestUpdaterEntry.ref);
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.updateHistory');
    } finally {
      release();
    }
  }

  private async waitForHistoryEntryBroadcast(newEntry: ChatHistoryEntry): Promise<void> {
    return waitForBroadcast<number>({
      condition: () => this.historyEntry.ref === newEntry.ref,
      broadcast: () => this.broadcastHistoryEntry(newEntry),
    });
  }

  /**
   * Broadcasts the new history entry to the GSOC. This is a history entry message.
   * NOTE: probably a separate GSOC node should be used.
   * @param historyEntry The new history entry to broadcast.
   */
  private async broadcastHistoryEntry(historyEntry: ChatHistoryEntry) {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      await this.utils.retryAwaitableAsync(() =>
        this.utils.sendMessageToGsoc(
          this.bees,
          this.topic,
          this.gsocResourceId!,
          JSON.stringify({
            historyEntry,
          }),
        ),
      );

      this.logger.debug('NEW history entry broadcast CALLED');
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastNewAppState');
    }
  }

  private async uploadHistory(newChatHistory: ChatHistory): Promise<string> {
    const { bee, stamp } = this.utils.getWriterBee(this.bees);
    const historyRef = await this.utils.uploadObjectToBee(bee, newChatHistory, stamp);

    if (!historyRef) {
      throw new Error('History reference is null');
    }

    return historyRef.reference.toString();
  }

  private async fetchHistory(historyEntry?: ChatHistoryEntry): Promise<ChatHistory | null> {
    const latestHistoryEntry = historyEntry || (await this.fetchLatestHistoryEntry());
    if (!latestHistoryEntry) return null;

    const bee = this.utils.getReaderBee(this.bees);
    const historyData = (await this.utils.downloadObjectFromBee(bee, latestHistoryEntry.ref)) as ChatHistory;

    if (!validateChatHistory(historyData)) {
      this.logger.warn('Could not fetch remote history: invalid history data');
      return null;
    }

    return historyData;
  }

  private async fetchLatestHistoryEntry(): Promise<ChatHistoryEntry | null> {
    if (!this.gsocResourceId) {
      throw new Error('GSOC Resource ID is not defined');
    }

    try {
      const message: GsocMessage = await this.utils.fetchLatestGsocMessage(this.bees, this.topic, this.gsocResourceId);

      this.logger.debug('Init GSOC message:', message);

      if (!validateGsocMessage(message)) {
        this.logger.warn('Invalid GSOC message during latest history entry fetch');
        return null;
      }

      return message.historyEntry;
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.fetchLatestHistoryEntry');
      return null;
    }
  }

  private async readAllMessageEntry(latestMessages: UserMessageEntry[]) {
    latestMessages.forEach((userEntry) => {
      this.messagesQueue.enqueue(() => this.readMessage(userEntry, this.topic));
    });
    await this.messagesQueue.waitForProcessing();
  }

  private async readMessage(userEntry: UserMessageEntry, topic: string) {
    try {
      const messageData = await this.utils.fetchUserFeedDataByIndex({
        topicBase: topic,
        bees: this.bees,
        userAddress: userEntry.address,
        index: userEntry.entry.index,
      });

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, messageData);
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.readMessage');
    }
  }

  private updateLocalHistory(activeUsers: UserMap) {
    const currentAllTimeUsers: UserHistoryMap = {};

    Object.entries(activeUsers).forEach(([address, user]) => {
      currentAllTimeUsers[address] = {
        events: [], // WIP
        messageEntries: [{ index: user.index, timestamp: user.timestamp }],
      };
    });

    this.history = {
      allTimeUsers: this.mergeUserHistory(currentAllTimeUsers, this.history.allTimeUsers),
    };

    this.logger.debug('updateLocalHistory - ', JSON.stringify(this.history));
  }

  private mergeChatHistory(remoteHistory: ChatHistory, localHistory: ChatHistory): ChatHistory {
    return {
      allTimeUsers: this.mergeUserHistory(remoteHistory.allTimeUsers, localHistory.allTimeUsers),
    };
  }

  private mergeUserHistory(remoteUsers: UserHistoryMap, localUsers: UserHistoryMap): UserHistoryMap {
    return mergeWith(
      (remoteUser, localUser) => {
        if (!remoteUser) return localUser;
        if (!localUser) return remoteUser;

        const mergedEvents = mergeUnique(
          remoteUser.events,
          localUser.events,
          (event: ChatEvent) => `${event.type}-${event.timestamp}`,
          (a, b) => a.timestamp - b.timestamp,
        );

        const mergedMessageEntries = mergeUnique(
          remoteUser.messageEntries,
          localUser.messageEntries,
          (entry: MessageEntry) => entry.index,
          (a, b) => a.timestamp - b.timestamp,
        );

        return {
          events: mergedEvents,
          messageEntries: mergedMessageEntries,
        };
      },
      remoteUsers,
      localUsers,
    );
  }

  /**
   * Trims the history if it exceeds the specified size in MB.
   * Currently aproximately 2MB ~40000 records is the limit.
   * It trims the oldest 10000 messages.
   * TODO events WIP
   * @param maxSizeMB The maximum size of the history in MB.
   * @param trimBatch The number of messages to trim.
   */
  private trimHistory(maxSizeMB = 2, trimBatch = 10000) {
    try {
      const jsonString = JSON.stringify(this.history);
      const sizeInBytes = new Blob([jsonString]).size;
      const sizeInMB = sizeInBytes / (1024 * 1024);

      if (sizeInMB <= maxSizeMB) {
        return;
      }

      const allMessages: UserMessageEntry[] = [];

      for (const user in this.history.allTimeUsers) {
        const messages = this.history.allTimeUsers[user].messageEntries;
        messages.forEach((entry) => {
          allMessages.push({ address: user, entry });
        });
      }

      allMessages.sort((a, b) => a.entry.timestamp - b.entry.timestamp);

      const messagesToKeep = allMessages.slice(trimBatch);

      const newHistory: ChatHistory = { allTimeUsers: {} };

      for (const { address, entry } of messagesToKeep) {
        if (!newHistory.allTimeUsers[address]) {
          newHistory.allTimeUsers[address] = { events: [], messageEntries: [] };
        }
        newHistory.allTimeUsers[address].messageEntries.push(entry);
      }

      this.history = newHistory;
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.trimHistory');
    }
  }

  /**
   * Selects a new updater from the active users.
   * If there are no active users, the current user is selected.
   * NOTE: better selection logic?
   * @param activeUsers The currently active users in the chat.
   * @return The address of the new updater.
   */
  private chooseNewUpdater(activeUsers: UserMap): string {
    const users = Object.values(activeUsers);

    if (users.length === 0) return this.ownAddress;

    let randomIndex: number;

    if (window.crypto && window.crypto.getRandomValues) {
      const randomValues = new Uint32Array(1);
      window.crypto.getRandomValues(randomValues);
      randomIndex = randomValues[0] % users.length;
    } else {
      // Fallback
      randomIndex = Math.floor(Math.random() * users.length);
    }

    return users[randomIndex].address;
  }

  /**
   * Selects the latest 10 messages (MAX_LOADED_MESSAGES_CACHE_SIZE)
   * Loaded messages are cached to avoid duplicates.
   * @param userHistories The user histories to select the messages from.
   * @return The selected messages.
   */
  private selectLatestMessages(userHistories: UserHistoryMap): UserMessageEntry[] {
    const allEntries: UserMessageEntry[] = [];

    for (const [address, history] of Object.entries(userHistories)) {
      for (const entry of history.messageEntries) {
        allEntries.push({ address: address, entry });
      }
    }

    allEntries.sort((a, b) => b.entry.timestamp - a.entry.timestamp);

    const selected: UserMessageEntry[] = [];
    for (const { address, entry } of allEntries) {
      const cacheKey = `${address}:${entry.index}`;

      if (!this.loadedMessagesCache.has(cacheKey)) {
        selected.push({ address, entry });
        this.loadedMessagesCache.add(cacheKey);

        if (selected.length === this.MAX_LOADED_MESSAGES_CACHE_SIZE) {
          break;
        }
      }
    }

    return selected;
  }

  /**
   * If there are multiple possible update entries, the one with the highest id is selected.
   * If the ids are the same, the one with the highest timestamp is selected.
   * @param entryBuffer The buffer of possible updater entries.
   */
  private selectBestEntryForUpdate(entryBuffer: ChatHistoryEntry[]): ChatHistoryEntry | null {
    return entryBuffer
      .filter((entry) => entry.updater === this.ownAddress)
      .reduce((bestEntry, currentEntry) => {
        if (!bestEntry) return currentEntry;
        if (currentEntry.id > bestEntry.id) return currentEntry;
        if (currentEntry.id === bestEntry.id && currentEntry.timestamp > bestEntry.timestamp) return currentEntry;
        return bestEntry;
      }, null as ChatHistoryEntry | null);
  }

  private cleanupUpdaterEntryBuffer(entryId?: number) {
    if (entryId !== undefined) {
      this.updaterEntryBuffer = this.updaterEntryBuffer.filter((entry) => entry.id !== entryId);
    }
  }

  private createNewHistoryEntry(historyRef: string): ChatHistoryEntry {
    return {
      id: this.historyEntry.id + 1,
      ref: historyRef,
      updater: this.ownAddress,
      timestamp: Date.now(),
    };
  }

  private initializeDefaultEntry() {
    this.historyEntry = {
      id: 0,
      ref: '',
      updater: this.ownAddress,
      timestamp: Date.now(),
    };
  }
}
