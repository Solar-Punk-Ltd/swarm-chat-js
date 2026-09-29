import { Bee, PrivateKey } from '@ethersphere/bee-js';

import { ChatEmitter, EVENTS, pendingMessageData, publishedMessageData, type MessageData } from './events.js';
import { FeedFollower, FeedStatus, type FollowerSettings } from './follower.js';
import { ChatHistory } from './history.js';
import { MessageType, type FeedEntry, type HistoryRow } from './message/index.js';
import { DEFAULT_SENDER_SETTINGS, Sender, type GsocWrite, type SenderSettings } from './sender.js';
import { beeChatSource, beeGsocWrite, GATEWAY_STAMPS_ITSELF, type ChatSource, type SwarmTimeouts } from './swarm.js';

export interface ChatSettings {
  user: {
    /** Signs every message. A viewer that only reads may pass any key, since nothing is sent without a nickname. */
    privateKey: string;
    /** The name shown on every message, 1 to 20 characters. */
    nickname: string;
  };
  infra: {
    /** The Bee node or gateway every read and write goes through. */
    beeUrl: string;
    /** The batch the inbox writes are stamped with. Left out for a gateway that stamps writes itself. */
    stamp?: string;
    /** The inbox's identifier string, one for every chat, as the server listens on it. */
    gsocTopic: string;
    /** The mined key every sender signs inbox writes with, which puts them in the server node's neighbourhood. */
    gsocResourceId: string;
    /** The chat's topic, which every message carries and the server's feed is named by. */
    chatTopic: string;
    /** The server's feed owner address. */
    chatAddress: string;
    /** How often the reader polls at the live edge, 1,000 ms by default. */
    pollingInterval?: number;
    /**
     * The head lookup and a history file download, 15,000 ms by default. An idle Bee answers the head lookup of a
     * 1,000 message chat in about five seconds, so this is three times that. A lookup slower than this is a loaded
     * gateway, and the chat is then read from slot 0 rather than waiting on it.
     */
    feedReadTimeout?: number;
    /** One inbox write, 10,000 ms by default. */
    gsocWriteTimeout?: number;
    /** One feed slot read, 5,000 ms by default. */
    socReadTimeout?: number;
  };
}

/** What a test hands in instead of the network, and the tuning a test shortens. */
export interface ChatParts {
  source: ChatSource;
  write: GsocWrite;
  follower: Partial<FollowerSettings>;
  sender: Partial<SenderSettings>;
  /** The waits between opening attempts, the last repeated. */
  openRetryMs: readonly number[];
}

const OPEN_RETRY_MS = [1_000, 2_000, 4_000, 8_000];
const OPEN_FAILURES_BEFORE_CRITICAL = 3;

function withoutPrefix(hex: string): string {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
}

/**
 * One chat: opens it from its newest history file, follows its feed, and sends messages to the server's inbox. Its
 * events carry everything a viewer shows, and `start` and `stop` may be called in any order and any number of times.
 */
export class SwarmChat {
  private readonly emitter = new ChatEmitter();
  private readonly key: PrivateKey;
  private readonly topic: string;
  private readonly nickname: string;
  private readonly source: ChatSource;
  private readonly write: GsocWrite;
  private readonly senderSettings: SenderSettings;
  private readonly openRetryMs: readonly number[];
  private readonly follower: FeedFollower;
  private readonly history: ChatHistory;
  private sender: Sender;
  private readonly seen = new Set<number>();
  private status: FeedStatus | null = null;
  private generation = 0;
  private running = false;
  private starting: Promise<void> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeOpen: (() => void) | null = null;

  constructor(settings: ChatSettings, parts: Partial<ChatParts> = {}) {
    const { user, infra } = settings;
    this.key = new PrivateKey(withoutPrefix(user.privateKey));
    this.topic = infra.chatTopic;
    this.nickname = user.nickname;
    this.openRetryMs = parts.openRetryMs ?? OPEN_RETRY_MS;
    this.senderSettings = { ...DEFAULT_SENDER_SETTINGS, ...parts.sender };

    const timeouts: SwarmTimeouts = {
      slotReadMs: infra.socReadTimeout ?? 5_000,
      feedReadMs: infra.feedReadTimeout ?? 15_000,
      writeMs: infra.gsocWriteTimeout ?? 10_000,
    };
    const needsBee = !parts.source || !parts.write;
    const bee = needsBee ? new Bee(infra.beeUrl) : null;
    this.source = parts.source ?? beeChatSource(bee!, withoutPrefix(infra.chatAddress), infra.chatTopic, timeouts);
    this.write =
      parts.write ??
      beeGsocWrite(
        bee!,
        infra.stamp ? withoutPrefix(infra.stamp) : GATEWAY_STAMPS_ITSELF,
        withoutPrefix(infra.gsocResourceId),
        infra.gsocTopic,
        timeouts,
      );

    this.follower = new FeedFollower(
      this.source,
      this.topic,
      {
        entry: (entry) => this.show(entry),
        skipped: (index, reason, detail) => this.emitter.emit(EVENTS.MESSAGE_SKIPPED, { index, reason, detail }),
        status: (status) => this.setStatus(status),
        error: (error) => this.emitter.emit(EVENTS.ERROR, error),
      },
      { pollIntervalMs: infra.pollingInterval ?? 1_000, ...parts.follower },
    );
    this.history = new ChatHistory(this.source, this.topic, {
      skipped: (count) =>
        this.emitter.emit(EVENTS.MESSAGE_SKIPPED, {
          index: -1,
          reason: 'history-row',
          detail: `${count} rows of a history file`,
        }),
      error: (error) => this.emitter.emit(EVENTS.ERROR, error),
    });
    this.sender = this.makeSender();
  }

  getEmitter(): ChatEmitter {
    return this.emitter;
  }

  /** The reader's state, or null before the chat has been read. */
  getStatus(): FeedStatus | null {
    return this.status;
  }

  /** This key's address, the `address` of every message it sends. */
  getAddress(): string {
    return this.key.publicKey().address().toHex();
  }

  /**
   * Opens the chat and starts following it. Resolves once it is open, or once `stop` is called first. Opening is
   * retried with backoff for as long as the chat runs: every failure is an ERROR event, and three in a row a
   * CRITICAL_ERROR.
   */
  start(): Promise<void> {
    if (this.running) {
      return this.starting ?? Promise.resolve();
    }
    this.running = true;
    this.generation++;
    this.seen.clear();
    this.sender = this.makeSender();
    const starting = this.open(this.generation).finally(() => {
      if (this.starting === starting) {
        this.starting = null;
      }
    });
    this.starting = starting;
    return starting;
  }

  /** Stops every poll, resend and retry. Listeners stay, so a later `start` reports to them again. */
  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.wakeOpen?.();
    this.follower.stop();
    this.sender.stop();
  }

  /**
   * Sends a text or a thread reply, or taps a reaction. A text and a reply resolve to the pending message, which
   * MESSAGE_RECEIVED later shows as published. A reaction resolves to null: taps inside a second cancel in pairs,
   * and only an odd count is sent. Rejects with a ChatMessageError, sending nothing, for a message the server would
   * refuse, such as one with no nickname.
   */
  async sendMessage(text: string, type: MessageType, targetMessageId?: string): Promise<MessageData | null> {
    if (type === MessageType.REACTION) {
      if (!targetMessageId) {
        throw new Error('a reaction names the message it reacts to');
      }
      this.sender.react(this.topic, targetMessageId, text);
      return null;
    }
    const message = this.sender.send({ topic: this.topic, type, target: targetMessageId ?? '', text });
    return pendingMessageData(message);
  }

  /** Sends a failed or pending message again, with its identical bytes. Returns whether it was still held. */
  retrySendMessage(message: MessageData | string): boolean {
    return this.sender.retry(typeof message === 'string' ? message : message.id);
  }

  /** Loads the history file before the oldest one shown, and shows its messages. */
  async fetchPreviousMessages(): Promise<MessageData[]> {
    this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);
    try {
      const generation = this.generation;
      const rows = await this.history.loadOlder();
      return generation === this.generation ? this.showRows(rows) : [];
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  hasPreviousMessages(): boolean {
    return this.history.hasOlder();
  }

  /** Published messages in chat order, then pending ones by the sender's clock. */
  orderMessages<T extends Pick<MessageData, 'index' | 'timestamp'>>(messages: T[]): T[] {
    return [...messages].sort((a, b) => {
      if (a.index >= 0 && b.index >= 0) {
        return a.index - b.index;
      }
      if (a.index >= 0 || b.index >= 0) {
        return a.index >= 0 ? -1 : 1;
      }
      return a.timestamp - b.timestamp;
    });
  }

  private async open(generation: number): Promise<void> {
    this.emitter.emit(EVENTS.LOADING_INIT, true);
    let failures = 0;
    while (generation === this.generation) {
      try {
        const opening = await this.history.open();
        if (generation !== this.generation) {
          return;
        }
        this.showRows(opening.rows);
        this.follower.start(opening.startAt);
        this.emitter.emit(EVENTS.LOADING_INIT, false);
        return;
      } catch (error) {
        if (generation !== this.generation) {
          return;
        }
        failures++;
        this.emitter.emit(EVENTS.ERROR, error);
        this.setStatus(FeedStatus.RECONNECTING);
        if (failures === OPEN_FAILURES_BEFORE_CRITICAL) {
          this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
        }
        await this.waitToOpen(this.openRetryMs[Math.min(failures, this.openRetryMs.length) - 1] ?? 8_000);
      }
    }
  }

  private waitToOpen(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeOpen = () => {
        this.wakeOpen = null;
        resolve();
      };
      this.openTimer = setTimeout(() => {
        this.openTimer = null;
        this.wakeOpen?.();
      }, ms);
    });
  }

  private makeSender(): Sender {
    return new Sender(
      this.key,
      this.nickname,
      this.write,
      {
        pending: (message) => this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, pendingMessageData(message)),
        written: (message) => this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, pendingMessageData(message)),
        failed: (message, error) => {
          this.emitter.emit(EVENTS.ERROR, error);
          this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, pendingMessageData(message));
        },
        confirmed: () => {},
      },
      this.senderSettings,
    );
  }

  private show(entry: FeedEntry): void {
    if (this.seen.has(entry.seq)) {
      return;
    }
    this.seen.add(entry.seq);
    this.sender.confirm(entry.msg);
    this.emitter.emit(EVENTS.MESSAGE_RECEIVED, publishedMessageData(entry));
  }

  private showRows(rows: HistoryRow[]): MessageData[] {
    const shown: MessageData[] = [];
    for (const row of rows) {
      if (this.seen.has(row.seq)) {
        continue;
      }
      this.seen.add(row.seq);
      this.sender.confirm(row.msg);
      const data = publishedMessageData(row);
      shown.push(data);
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, data);
    }
    return shown;
  }

  private setStatus(status: FeedStatus): void {
    if (status !== this.status) {
      this.status = status;
      this.emitter.emit(EVENTS.STATUS, status);
    }
  }
}
