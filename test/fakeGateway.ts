import {
  createChatMessage,
  encodeSlotNote,
  MessageType,
  type ChatMessage,
  type FeedEntry,
  type HistoryLink,
} from '../src/message';
import { BeeResponseError } from '@ethersphere/bee-js';

import { HeadLookupTimeoutError, readSlotThrough, type ChatSource } from '../src/swarm';

// Test only.
export const TEST_KEY = '11'.repeat(32);
export const TOPIC = 'chat-test';

const encoder = new TextEncoder();

export function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function testMessage(text: string, topic = TOPIC): ChatMessage {
  return createChatMessage(TEST_KEY, { topic, type: MessageType.TEXT, text, name: 'tester', ts: 1759140000000 })
    .message;
}

export function entryAt(seq: number, history: HistoryLink | null = null, text = `message ${seq}`): FeedEntry {
  return { v: 7, seq, at: 1759140000000 + seq, msg: testMessage(text), history };
}

/**
 * A chat feed and its history files in memory, served the way Bee answers: a slot not written, or one no peer gave in
 * time, is null (Bee's 404), and `down` makes every read reject as a gateway that does not answer.
 */
export class FakeGateway implements ChatSource {
  readonly slots = new Map<number, Uint8Array>();
  readonly files = new Map<string, Uint8Array>();
  /** Slots that exist but are refused, as a slot no peer gives out. */
  readonly hidden = new Set<number>();
  /** Slots served with a chunk that fails its own check. */
  readonly corrupt = new Set<number>();
  /** Every slot answered 200 with something that is not a chunk, as a proxy serving the web app for unknown paths. */
  servesPages = false;
  /** What the head lookup answers, when it should not be the newest slot. */
  head: { index: number } | 'not-found' | 'fail' | 'timeout' | null = null;
  down = false;
  readonly slotReads: number[] = [];
  headReads = 0;
  fileReads: string[] = [];
  /** Notes by time slot, as the server writes them. */
  readonly notes = new Map<number, Uint8Array>();
  /** Every note read, by time slot, and the clock when it was asked. */
  readonly noteReads: { slot: number; at: number }[] = [];
  /** Note reads that reject as a gateway that does not answer, while `down` stays false. */
  notesDown = false;

  writeNote(slot: number, newest: number, writtenAt = Date.now()): this {
    this.notes.set(slot, encodeSlotNote({ newest, writtenAt }));
    return this;
  }

  readNote(slot: number): Promise<Uint8Array | null> {
    this.noteReads.push({ slot, at: Date.now() });
    return readSlotThrough(slot, async () => {
      if (this.down || this.notesDown) {
        throw new BeeResponseError('GET', `/chunks/note-${slot}`, 'fetch failed');
      }
      const payload = this.notes.get(slot);
      if (!payload) {
        const status = FakeGateway.absentStatus;
        throw new BeeResponseError('GET', `/chunks/note-${slot}`, 'Not Found', undefined, status, String(status));
      }
      return payload;
    });
  }

  write(entry: FeedEntry): this {
    this.slots.set(entry.seq, bytes(entry));
    return this;
  }

  writeRaw(index: number, payload: Uint8Array): this {
    this.slots.set(index, payload);
    return this;
  }

  /**
   * What Bee answers for a slot that is not there. Bee 2.8 answers 404 on `GET /chunks`, and a Bee 2.6 cluster
   * answers 500, measured on the bed, so the follower's tests run under both.
   */
  static absentStatus: 404 | 500 = 404;

  /** Answers the way bee-js does, and sorts the answer through the same function the Bee reader uses. */
  readSlot(index: number): Promise<Uint8Array | null> {
    this.slotReads.push(index);
    return readSlotThrough(index, async () => {
      if (this.down) {
        throw new BeeResponseError('GET', `/chunks/${index}`, 'fetch failed');
      }
      if (this.servesPages || this.corrupt.has(index)) {
        throw new Error('invalid signature');
      }
      const payload = this.hidden.has(index) ? undefined : this.slots.get(index);
      if (!payload) {
        const status = FakeGateway.absentStatus;
        throw new BeeResponseError('GET', `/chunks/${index}`, 'Not Found', undefined, status, String(status));
      }
      return payload;
    });
  }

  async readHead(): Promise<{ index: number; payload: Uint8Array } | null> {
    this.headReads++;
    if (this.down || this.head === 'fail') {
      throw new Error('gateway down');
    }
    if (this.head === 'not-found') {
      return null;
    }
    if (this.head === 'timeout') {
      throw new HeadLookupTimeoutError({ cause: new Error('aborted') });
    }
    const index = this.head?.index ?? Math.max(-1, ...this.slots.keys());
    const payload = this.slots.get(index);
    return payload ? { index, payload } : null;
  }

  async readFile(reference: string): Promise<Uint8Array> {
    this.fileReads.push(reference);
    const file = this.files.get(reference);
    if (this.down || !file) {
      throw new Error(`cannot read ${reference}`);
    }
    return file;
  }
}
