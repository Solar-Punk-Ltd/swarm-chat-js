import type { FeedStatus, SkipReason } from './follower.js';
import type { ChatMessage, FeedEntry, HistoryRow, MessageType } from './message/index.js';

export const EVENTS = {
  /** `true` when opening starts, `false` once the chat is open and being followed. */
  LOADING_INIT: 'loadingInit',
  /** `true` while "load older" reads a history file, then `false`. */
  LOADING_PREVIOUS_MESSAGES: 'loadingPreviousMessages',
  /** A message the chat feed shows, a MessageData. Also how the sender learns its message went out. */
  MESSAGE_RECEIVED: 'messageReceived',
  /** A message built, signed and about to be written, a MessageData with index -1. */
  MESSAGE_REQUEST_INITIATED: 'messageRequestInitiated',
  /** The first write of a message that the node accepted. It is still pending until MESSAGE_RECEIVED. */
  MESSAGE_REQUEST_UPLOADED: 'messageRequestUploaded',
  /**
   * A message whose resends ran out unseen while the reader was live. `retrySendMessage` sends it again. A
   * MESSAGE_RECEIVED for the same id may still follow, if the server published it late.
   */
  MESSAGE_REQUEST_ERROR: 'messageRequestError',
  /** Opening has failed three times in a row. It keeps trying, and a later LOADING_INIT `false` means it got through. */
  CRITICAL_ERROR: 'criticalError',
  /** The reader's state, a FeedStatus: live, reconnecting or stalled. */
  STATUS: 'status',
  /** A feed slot or history row not shown, a SkippedMessage. */
  MESSAGE_SKIPPED: 'messageSkipped',
  /** Any failure the chat recovers from on its own, for logging. */
  ERROR: 'error',
} as const;

export type ChatEvent = (typeof EVENTS)[keyof typeof EVENTS];

/** A message as the viewer shows it. The field names are 6.x's, so a viewer built on 6.x changes little. */
export interface MessageData {
  id: string;
  type: MessageType;
  /** The text, or the emoji of a reaction. */
  message: string;
  username: string;
  address: string;
  /** The server's receive time once published, the sender's clock while pending. What the viewer shows and sorts by. */
  timestamp: number;
  /** The message a thread reply or a reaction refers to. */
  targetMessageId?: string;
  chatTopic: string;
  signature: string;
  /** The message's place in the chat, its feed index, or -1 while it is pending. */
  index: number;
  /** The sender's own clock, which nothing checks. */
  sentAt: number;
}

export interface SkippedMessage {
  /** The feed index, or -1 for rows of a history file. */
  index: number;
  reason: SkipReason | 'history-row';
  detail: string;
}

export function pendingMessageData(message: ChatMessage): MessageData {
  return messageData(message, -1, message.ts);
}

export function publishedMessageData(entry: FeedEntry | HistoryRow): MessageData {
  return messageData(entry.msg, entry.seq, entry.at);
}

function messageData(message: ChatMessage, index: number, timestamp: number): MessageData {
  return {
    id: message.id,
    type: message.type,
    message: message.text,
    username: message.name,
    address: message.addr,
    timestamp,
    ...(message.target ? { targetMessageId: message.target } : {}),
    chatTopic: message.topic,
    signature: message.sig,
    index,
    sentAt: message.ts,
  };
}

export interface ChatEventPayloads {
  [EVENTS.LOADING_INIT]: boolean;
  [EVENTS.LOADING_PREVIOUS_MESSAGES]: boolean;
  [EVENTS.MESSAGE_RECEIVED]: MessageData;
  [EVENTS.MESSAGE_REQUEST_INITIATED]: MessageData;
  [EVENTS.MESSAGE_REQUEST_UPLOADED]: MessageData;
  [EVENTS.MESSAGE_REQUEST_ERROR]: MessageData;
  [EVENTS.CRITICAL_ERROR]: unknown;
  [EVENTS.STATUS]: FeedStatus;
  [EVENTS.MESSAGE_SKIPPED]: SkippedMessage;
  [EVENTS.ERROR]: unknown;
}

type Listener<T> = (data: T) => void;

/**
 * The chat's events. `on` and `off` are bound, so a caller may take them apart from the emitter. A listener that
 * throws is reported on the console and never stops the listeners after it or the chat behind it.
 */
export class ChatEmitter {
  private readonly listeners = new Map<string, Listener<never>[]>();

  on = <E extends ChatEvent>(event: E, listener: Listener<ChatEventPayloads[E]>): void => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener as Listener<never>]);
  };

  off = <E extends ChatEvent>(event: E, listener: Listener<ChatEventPayloads[E]>): void => {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== (listener as Listener<never>)),
    );
  };

  cleanAll = (): void => {
    this.listeners.clear();
  };

  emit<E extends ChatEvent>(event: E, data: ChatEventPayloads[E]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as Listener<ChatEventPayloads[E]>)(data);
      } catch (error) {
        console.error(`a listener for ${event} threw`, error);
      }
    }
  }
}
