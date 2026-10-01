import { BeeResponseError, Identifier, PrivateKey, Topic, type Bee, type BeeRequestOptions } from '@ethersphere/bee-js';

import { DEFAULT_NOTE_SLOT_MS, noteIdentifier } from './message/index.js';
import type { GsocWrite } from './sender.js';

/** Everything the reader asks of Swarm, so the reader can be driven by a fake in tests. */
export interface ChatSource {
  /**
   * The payload at one feed index, or null when Bee answered 404. Rejects with an UnreadableSlotError when a chunk was
   * served that fails its own check, and with anything else when the gateway failed.
   */
  readSlot(index: number): Promise<Uint8Array | null>;
  /**
   * Bee's head lookup: the newest index it found and its payload, or null when it answered that nothing is there.
   * Rejects with a HeadLookupTimeoutError when it ran out of time, and with anything else when the gateway failed.
   */
  readHead(): Promise<{ index: number; payload: Uint8Array } | null>;
  /** A history file's bytes. Rejects when it cannot be read. */
  readFile(reference: string): Promise<Uint8Array>;
  /**
   * The payload of time slot `slot`'s note, or null when Bee answered that it is not there. Sorts its failures as
   * `readSlot` does. A source without it follows the chat by polling the next slot, as before notes existed.
   */
  readNote?(slot: number): Promise<Uint8Array | null>;
}

/** Bee's head lookup did not answer within its timeout, which on a long chat or a busy gateway is ordinary. */
export class HeadLookupTimeoutError extends Error {
  constructor(options: { cause: unknown }) {
    super('the feed head lookup did not answer in time', options);
    this.name = 'HeadLookupTimeoutError';
  }
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
 * Whether Bee said the chunk is not there. A 404 means no peer gave it within Bee's retry budget, which at the live
 * edge is the ordinary "not written yet" and elsewhere a slow read. A Bee 2.6 cluster answers 500 on `GET /chunks` for
 * a slot never written, measured on the test bed, so a 500 counts too, as bee-js's own `isRetrievable` counts it.
 * Neither ever means the chat has ended, and a read that is wrong about "not there" is asked again on the next poll.
 * Every other failure, a timeout, an abort, a refused connection or a 502, 503 or 504, is the gateway failing.
 */
export function isAbsent(error: unknown): boolean {
  return error instanceof BeeResponseError && (error.status === 404 || error.status === 500);
}

/**
 * One slot read, sorted into what it means: the payload, null for a slot that is not there, an UnreadableSlotError for
 * a chunk served that fails its own check, and a rejection for the gateway failing. Shared by the Bee reader and the
 * tests' fake, so both sort failures the same way.
 */
export async function readSlotThrough(index: number, read: () => Promise<Uint8Array>): Promise<Uint8Array | null> {
  try {
    return await read();
  } catch (error) {
    if (isAbsent(error)) {
      return null;
    }
    // bee-js turns every transport failure, an abort included, into a BeeResponseError. Anything else was thrown
    // while reading a response that arrived.
    if (error instanceof BeeResponseError) {
      throw error;
    }
    throw new UnreadableSlotError(index, { cause: error });
  }
}

/**
 * Reads a chat feed through bee-js's feed reader with an explicit index, which reads `GET /chunks/{address}` and
 * answers 404 only when the chunk could not be found, where `/soc/{owner}/{id}` answers 404 for any failure at all.
 * Notes are read through bee-js's single owner chunk reader, which reads the same `GET /chunks/{address}` and checks
 * the chunk is the owner's.
 */
export function beeChatSource(
  bee: Bee,
  owner: string,
  chatTopic: string,
  timeouts: SwarmTimeouts,
  noteSlotMs = DEFAULT_NOTE_SLOT_MS,
): ChatSource {
  const topic = Topic.fromString(chatTopic);
  const reader = (timeoutMs: number) => bee.feed.makeReader(topic, owner, within(timeoutMs));

  return {
    readNote: (slot) =>
      readSlotThrough(slot, async () => {
        const chunk = await bee.soc
          .makeReader(owner, within(timeouts.slotReadMs))
          .download(noteIdentifier(chatTopic, noteSlotMs, slot));
        return chunk.payload.toUint8Array();
      }),
    readSlot: (index) =>
      readSlotThrough(index, async () =>
        (await reader(timeouts.slotReadMs).downloadPayload({ index })).payload.toUint8Array(),
      ),
    async readHead() {
      const options = within(timeouts.feedReadMs);
      try {
        const { payload, feedIndex } = await bee.feed.makeReader(topic, owner, options).downloadPayload();
        return { index: Number(feedIndex.toBigInt()), payload: payload.toUint8Array() };
      } catch (error) {
        if (isAbsent(error)) {
          return null;
        }
        // bee-js's error for an abort carries no status, so the signal is what says the lookup ran out of time.
        if (options.signal?.aborted) {
          throw new HeadLookupTimeoutError({ cause: error });
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
