import type { PrivateKey } from '@ethersphere/bee-js';

import { createChatMessage, MessageType, type ChatMessage, type ChatMessageDraft } from './message/index.js';

/** Writes one payload to the chat's GSOC address. Rejects when the write did not reach the node. */
export type GsocWrite = (payload: Uint8Array) => Promise<void>;

export interface SenderSettings {
  /** How long a written message may go unseen on the chat feed before its identical bytes are written again. */
  resendAfterMs: number;
  /** Resends after the first write, before the message is failed. */
  maxResends: number;
  /** Taps on one reaction inside this window become one net toggle. */
  reactionWindowMs: number;
}

export const DEFAULT_SENDER_SETTINGS: SenderSettings = {
  resendAfterMs: 10_000,
  maxResends: 5,
  reactionWindowMs: 1_000,
};

export interface SenderEvents {
  /** Built and signed, and about to be written. */
  pending(message: ChatMessage): void;
  /** The first write that the node accepted. */
  written(message: ChatMessage): void;
  /** Every resend used up, or a write refused in a way a resend cannot mend. `retry` sends it again. */
  failed(message: ChatMessage, error: unknown): void;
  /** Read back from the chat feed. */
  confirmed(message: ChatMessage): void;
}

interface Outgoing {
  message: ChatMessage;
  bytes: Uint8Array;
  writes: number;
  written: boolean;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastError: unknown;
}

interface ReactionTaps {
  taps: number;
  timer: ReturnType<typeof setTimeout>;
}

export type SendDraft = Omit<ChatMessageDraft, 'name' | 'ts' | 'id'>;

/**
 * Sends signed messages as GSOC writes and keeps each one pending until the chat feed shows it. A pending message is
 * written again with the identical bytes, so the server can tell a resend from a new message by its id.
 */
export class Sender {
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly reactions = new Map<string, ReactionTaps>();
  private stopped = false;

  constructor(
    private readonly key: PrivateKey,
    private readonly name: string,
    private readonly write: GsocWrite,
    private readonly events: SenderEvents,
    private readonly settings: SenderSettings = DEFAULT_SENDER_SETTINGS,
  ) {}

  get address(): string {
    return this.key.publicKey().address().toHex();
  }

  /** Builds, signs and writes a message. Throws a ChatMessageError, and writes nothing, for one the server would refuse. */
  send(draft: SendDraft): ChatMessage {
    const { message, bytes } = createChatMessage(this.key, { ...draft, name: this.name });
    const outgoing: Outgoing = {
      message,
      bytes,
      writes: 0,
      written: false,
      inFlight: false,
      timer: null,
      lastError: null,
    };
    this.outgoing.set(message.id, outgoing);
    this.events.pending(message);
    this.attempt(outgoing);
    return message;
  }

  /**
   * One tap on a reaction. A reaction sent again takes it back, so taps inside one window cancel in pairs and only an
   * odd count sends anything, once, when the window closes.
   */
  react(topic: string, target: string, emoji: string): void {
    const key = JSON.stringify([topic, target, emoji]);
    const open = this.reactions.get(key);
    if (open) {
      open.taps++;
      return;
    }
    const timer = setTimeout(() => {
      const closed = this.reactions.get(key);
      this.reactions.delete(key);
      if (closed && closed.taps % 2 === 1 && !this.stopped) {
        this.send({ topic, type: MessageType.REACTION, target, text: emoji });
      }
    }, this.settings.reactionWindowMs);
    this.reactions.set(key, { taps: 1, timer });
  }

  /** Called for every message the chat feed shows. Ends the wait for one this sender wrote. */
  confirm(message: ChatMessage): void {
    if (message.addr !== this.address) {
      return;
    }
    const outgoing = this.outgoing.get(message.id);
    if (!outgoing) {
      return;
    }
    this.clearTimer(outgoing);
    this.outgoing.delete(message.id);
    this.events.confirmed(outgoing.message);
  }

  /** Writes a failed or still pending message again, with the same bytes, and starts its resends over. */
  retry(id: string): boolean {
    const outgoing = this.outgoing.get(id);
    if (!outgoing || this.stopped) {
      return false;
    }
    this.clearTimer(outgoing);
    outgoing.writes = 0;
    if (!outgoing.inFlight) {
      this.attempt(outgoing);
    }
    return true;
  }

  isPending(id: string): boolean {
    return this.outgoing.has(id);
  }

  /** Cancels every resend and every open reaction window. Messages still pending stay unconfirmed. */
  stop(): void {
    this.stopped = true;
    for (const outgoing of this.outgoing.values()) {
      this.clearTimer(outgoing);
    }
    for (const { timer } of this.reactions.values()) {
      clearTimeout(timer);
    }
    this.reactions.clear();
  }

  private attempt(outgoing: Outgoing): void {
    if (this.stopped || !this.outgoing.has(outgoing.message.id)) {
      return;
    }
    outgoing.writes++;
    outgoing.inFlight = true;
    this.write(outgoing.bytes).then(
      () => {
        outgoing.inFlight = false;
        if (!outgoing.written && this.outgoing.has(outgoing.message.id)) {
          outgoing.written = true;
          this.events.written(outgoing.message);
        }
        this.scheduleNext(outgoing);
      },
      (error: unknown) => {
        outgoing.inFlight = false;
        outgoing.lastError = error;
        this.scheduleNext(outgoing);
      },
    );
  }

  private scheduleNext(outgoing: Outgoing): void {
    if (this.stopped || !this.outgoing.has(outgoing.message.id)) {
      return;
    }
    outgoing.timer = setTimeout(() => {
      outgoing.timer = null;
      if (outgoing.writes > this.settings.maxResends) {
        this.events.failed(outgoing.message, outgoing.lastError ?? new Error('never seen on the chat feed'));
        return;
      }
      this.attempt(outgoing);
    }, this.settings.resendAfterMs);
  }

  private clearTimer(outgoing: Outgoing): void {
    if (outgoing.timer) {
      clearTimeout(outgoing.timer);
      outgoing.timer = null;
    }
  }
}
