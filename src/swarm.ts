import { BeeResponseError, Identifier, PrivateKey, Topic, type Bee, type BeeRequestOptions } from '@ethersphere/bee-js';

import type { GsocWrite } from './sender.js';

/** Everything the reader asks of Swarm, so the reader can be driven by a fake in tests. */
export interface ChatSource {
  /**
   * The payload at one feed index, or null when Bee answered 404. Rejects with an UnreadableSlotError when a chunk was
   * served that fails its own check, and with anything else when the gateway failed.
   */
  readSlot(index: number): Promise<Uint8Array | null>;
  /** Bee's head lookup: the newest index it found and its payload, or null when it answered 404. */
  readHead(): Promise<{ index: number; payload: Uint8Array } | null>;
  /** A history file's bytes. Rejects when it cannot be read. */
  readFile(reference: string): Promise<Uint8Array>;
}

/**
 * A slot the gateway served whose chunk failed its own check, such as a signature that is not the owner's. A fact
 * about that one slot and not about the gateway, so it never holds the reader back from the slots after it.
 */
export class UnreadableSlotError extends Error {
  constructor(
    readonly index: number,
    options: { cause: unknown },
  ) {
    super(`feed slot ${index} was served but could not be read`, options);
    this.name = 'UnreadableSlotError';
  }
}

export interface SwarmTimeouts {
  /** A read of one feed slot. */
  slotReadMs: number;
  /** The head lookup and a history file download, which are slower by nature. */
  feedReadMs: number;
  /** One GSOC write. */
  writeMs: number;
}

/**
 * A 404 from Bee means no peer gave the chunk within Bee's retry budget, which at the live edge is the ordinary
 * "not written yet" and elsewhere a slow read. It never means the chat has ended. Every other failure is the gateway.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof BeeResponseError && error.status === 404;
}

/**
 * Reads a chat feed through bee-js's feed reader with an explicit index, which reads `GET /chunks/{address}` and
 * answers 404 only when the chunk could not be found, where `/soc/{owner}/{id}` answers 404 for any failure at all.
 */
export function beeChatSource(bee: Bee, owner: string, chatTopic: string, timeouts: SwarmTimeouts): ChatSource {
  const topic = Topic.fromString(chatTopic);
  const reader = (timeoutMs: number) => bee.feed.makeReader(topic, owner, within(timeoutMs));

  return {
    async readSlot(index) {
      try {
        const { payload } = await reader(timeouts.slotReadMs).downloadPayload({ index });
        return payload.toUint8Array();
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        // bee-js turns every transport failure, an abort included, into a BeeResponseError. Anything else was thrown
        // while reading a response that arrived.
        if (error instanceof BeeResponseError) {
          throw error;
        }
        throw new UnreadableSlotError(index, { cause: error });
      }
    },
    async readHead() {
      try {
        const { payload, feedIndex } = await reader(timeouts.feedReadMs).downloadPayload();
        return { index: Number(feedIndex.toBigInt()), payload: payload.toUint8Array() };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async readFile(reference) {
      const bytes = await bee.data.download(reference, undefined, within(timeouts.feedReadMs));
      return bytes.toUint8Array();
    },
  };
}

/**
 * Request options that end a request after `timeoutMs`. bee-js 13.1.0 accepts a `timeout` option and never applies
 * it, since its fetch honours only a signal, so a fresh signal goes with every request.
 */
function within(timeoutMs: number): BeeRequestOptions {
  return { signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * A batch id for a gateway that stamps what is written through it and ignores the one it is sent. Bee refuses a
 * write with no batch id at all, so something well formed has to go. The value 6.x sent, kept so a gateway that
 * recognises it keeps doing so.
 */
export const GATEWAY_STAMPS_ITSELF = '0123456789abcdef'.repeat(4);

/**
 * Writes to the chat's inbox: one GSOC address shared by every chat, signed with the mined key every sender holds.
 * Never deferred and never tagged, so each write is pushed at once and two different messages never collide.
 */
export function beeGsocWrite(
  bee: Bee,
  stamp: string,
  gsocKey: string,
  gsocTopic: string,
  timeouts: SwarmTimeouts,
): GsocWrite {
  const signer = new PrivateKey(gsocKey);
  const identifier = Identifier.fromString(gsocTopic);
  return async (payload) => {
    await bee.messaging.gsocSend(stamp, signer, identifier, payload, { deferred: false }, within(timeouts.writeMs));
  };
}
