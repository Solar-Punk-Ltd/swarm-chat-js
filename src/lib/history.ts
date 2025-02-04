import { Mutex } from 'async-mutex';
import mergeWith from 'lodash/fp/mergeWith';

import { mergeUnique } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { Queue } from '../utils/queue';
import { validateChatHistory, validateGsocMessage, validateHistoryEntry } from '../utils/validation';

import { EVENTS } from './constants';
import {
  ChatEvent,
  ChatHistory,
  ChatHistoryEntry,
  EthAddress,
  GsocMessage,
  InitializedBees,
  MessageEntry,
  UserHistoryMap,
  UserMap,
  UserMessageEntry,
} from './types';
import { SwarmChatUtils } from './utils';

export class SwarmHistory {
  private utils = new SwarmChatUtils();
  private emitter: EventEmitter;

  private logger = new Logger();
  private errorHandler = new ErrorHandler(this.logger);
  private mutex = new Mutex();

  private messagesQueue = new Queue({ clearWaitTime: 200 });

  private bees;
  private gsocResourceId: string;
  private topic: string;
  private ownAddress: string;

  private processedRefs = new Set();
  private loadedMessagesCache: Set<string> = new Set();

  private historyEntry: ChatHistoryEntry;
  private entryBuffer: ChatHistoryEntry[] = [];
  private history: ChatHistory = {
    allTimeUsers: {},
  };

  private historyUpdateTimer: NodeJS.Timeout | null = null;
  private HISTORY_UPDATE_INTERVAL_TIME = 5000;
  private MAX_LOADED_MESSAGES_CACHE_SIZE = 10;

  constructor(bees: InitializedBees, emitter: EventEmitter, gsocResourceId: string, topic: string, ownAddress: string) {
    this.bees = bees;
    this.gsocResourceId = gsocResourceId;
    this.emitter = emitter;
    this.topic = topic;
    this.ownAddress = ownAddress;
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

  private async uploadHistory(newChatHistory: ChatHistory): Promise<string> {
    const { bee, stamp } = this.utils.getWriterBee(this.bees);
    const historyRef = await this.utils.uploadObjectToBee(bee, newChatHistory, stamp);

    if (!historyRef) {
      throw new Error('History reference is null');
    }

    return historyRef.reference;
  }

  public async fetchHistory(historyEntry: ChatHistoryEntry): Promise<ChatHistory | null> {
    if (!validateHistoryEntry(historyEntry)) {
      this.logger.warn('Could not fetch remote history: invalid history entry');
      return null;
    }

    const bee = this.utils.getReaderBee(this.bees);
    const historyData = await this.utils.downloadObjectFromBee(bee, this.historyEntry.ref);

    if (!validateChatHistory(historyData)) {
      this.logger.warn('Could not fetch remote history: invalid history data');
      return null;
    }

    return historyData;
  }

  private async createHistoryEntry() {
    const release = await this.mutex.acquire();

    try {
      const latestEntry = this.selectBestEntry([...this.entryBuffer]);
      if (!latestEntry || this.processedRefs.has(latestEntry.ref)) {
        this.cleanupEntryBuffer(latestEntry?.id);
        return;
      }

      // TODO limit the size of the history
      const remoteHistory = latestEntry.ref ? await this.fetchHistory(this.historyEntry) : null;
      const newHistory = remoteHistory ? this.mergeChatHistory(remoteHistory, this.history) : this.history;
      const historyRef = await this.uploadHistory(newHistory);

      const newEntry = this.createNewHistoryEntry(historyRef);
      await this.broadcastHistoryEntry(newEntry);

      this.cleanupEntryBuffer(latestEntry.id);
      this.processedRefs.add(latestEntry.ref);
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.updateHistory');
    } finally {
      release();
    }
  }

  private cleanupEntryBuffer(entryId?: number) {
    if (entryId !== undefined) {
      this.entryBuffer = this.entryBuffer.filter((entry) => entry.id !== entryId);
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

  private selectBestEntry(entryBuffer: ChatHistoryEntry[]): ChatHistoryEntry | null {
    return entryBuffer
      .filter((entry) => entry.updater === this.ownAddress)
      .reduce((bestEntry, currentEntry) => {
        if (!bestEntry) return currentEntry;
        if (currentEntry.id > bestEntry.id) return currentEntry;
        if (currentEntry.id === bestEntry.id && currentEntry.timestamp > bestEntry.timestamp) return currentEntry;
        return bestEntry;
      }, null as ChatHistoryEntry | null);
  }

  public async processHistoryEntry(activeUsers: UserMap, entry: ChatHistoryEntry) {
    const release = await this.mutex.acquire();

    try {
      this.updateLocalHistory(activeUsers);

      if (entry.updater === this.ownAddress) {
        this.entryBuffer.push(entry);
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.processHistoryEntry');
    } finally {
      release();
    }
  }

  /**
   * TODO: Add description
   */
  private async broadcastHistoryEntry(historyEntry: ChatHistoryEntry) {
    try {
      if (!this.gsocResourceId) {
        throw new Error('GSOC Resource ID is not defined');
      }

      const { bee, stamp } = this.utils.getGsocBee(this.bees);

      const result = await this.utils.retryAwaitableAsync(() =>
        this.utils.sendMessageToGsoc(
          bee.url,
          this.topic,
          stamp,
          this.gsocResourceId!,
          JSON.stringify({
            historyEntry,
          }),
        ),
      );

      if (!result?.payload.length) throw new Error('GSOC result payload is empty');
    } catch (error) {
      this.errorHandler.handleError(error, 'Chat.broadcastNewAppState');
    }
  }

  /**
   * Selects the latest 10 unique messages across all users based on timestamp.
   * Avoids selecting messages that were previously cached.
   * @param userHistories - Map of user histories.
   * @returns - An array of the latest 10 unique messages, ordered from latest to oldest.
   */
  private selectLatestMessages(userHistories: UserHistoryMap): UserMessageEntry[] {
    const allEntries: UserMessageEntry[] = [];

    for (const [address, history] of Object.entries(userHistories)) {
      for (const entry of history.messageEntries) {
        allEntries.push({ address: address as EthAddress, entry });
      }
    }

    allEntries.sort((a, b) => b.entry.timestamp - a.entry.timestamp);

    const selected: UserMessageEntry[] = [];

    for (const { address, entry } of allEntries) {
      const cacheKey = `${address}:${entry.index}`;

      if (!this.loadedMessagesCache.has(cacheKey)) {
        selected.push({ address, entry });
        this.loadedMessagesCache.add(cacheKey);

        if (selected.length === this.MAX_LOADED_MESSAGES_CACHE_SIZE) break;
      }
    }

    // Keep cache size limited
    while (this.loadedMessagesCache.size > this.MAX_LOADED_MESSAGES_CACHE_SIZE) {
      const oldestInCache = [...this.loadedMessagesCache][0];
      this.loadedMessagesCache.delete(oldestInCache);
    }

    return selected;
  }

  private async fetchLatestHistoryEntry(): Promise<ChatHistoryEntry | null> {
    if (!this.gsocResourceId) {
      throw new Error('GSOC Resource ID is not defined');
    }

    // the main GSOC contains the latest state of the GSOC updates
    const mainGsocBee = this.utils.getMainGsocBee(this.bees);
    const message = await this.utils.fetchLatestGsocMessage(mainGsocBee.url, this.topic, this.gsocResourceId);
    const parsedMessage: GsocMessage = JSON.parse(message);

    this.logger.debug('Init GSOC message:', parsedMessage);

    if (!validateGsocMessage(parsedMessage)) {
      this.logger.warn('Invalid GSOC message during latest history entry fetch');
      return null;
    }

    return parsedMessage.historyEntry;
  }

  public async fetchPreviousMessages(options: { preDownload: boolean }) {
    const release = await this.mutex.acquire();

    try {
      let history: ChatHistory | null = null;
      if (options.preDownload && this.historyEntry.ref) {
        const bee = this.utils.getReaderBee(this.bees);
        history = await this.utils.downloadObjectFromBee(bee, this.historyEntry.ref);
      }

      if (history && !validateChatHistory(history)) {
        this.logger.warn('Could not fetch previous messages: invalid history data');
        return null;
      }

      const { allTimeUsers } = history ? this.mergeChatHistory(history, this.history) : this.history;

      const latestMessages = this.selectLatestMessages(allTimeUsers);

      await this.readAllMessageEntry(latestMessages);
    } finally {
      release();
    }
  }

  private async readAllMessageEntry(latestMessages: UserMessageEntry[]) {
    latestMessages.forEach((userEntry) => {
      this.messagesQueue.enqueue(() => this.readMessage(userEntry, this.topic));
    });
    await this.messagesQueue.waitForProcessing();
  }

  private async readMessage(userEntry: UserMessageEntry, rawTopic: string) {
    try {
      const messageData = await this.utils.fetchUserFeedDataByIndex({
        rawTopic,
        bees: this.bees,
        userAddress: userEntry.address,
        index: userEntry.entry.index,
      });

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, messageData);
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.readMessage');
    }
  }

  public updateLocalHistory(activeUsers: UserMap) {
    const currentAllTimeUsers: UserHistoryMap = {};

    Object.entries(activeUsers).forEach(([address, user]) => {
      currentAllTimeUsers[address] = {
        events: [], // TODO
        messageEntries: [{ index: user.index, timestamp: user.timestamp }],
      };
    });

    this.history = {
      allTimeUsers: this.mergeUserHistory(currentAllTimeUsers, this.history.allTimeUsers),
    };

    this.logger.debug('updateLocalHistory - ', JSON.stringify(this.history));
  }

  // TODO events
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
          allMessages.push({ address: user as EthAddress, entry });
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
    }
  }

  private initializeDefaultEntry() {
    this.historyEntry = {
      id: 0,
      ref: '',
      updater: this.ownAddress,
      timestamp: Date.now(),
    };
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
}
