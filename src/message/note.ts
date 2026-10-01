import { Bytes, EthAddress, Identifier, Reference } from '@ethersphere/bee-js';
import { z } from 'zod';

/**
 * Slot notes: the chat server's announcement, after a stretch of wall-clock time in which messages landed, of the
 * newest feed slot it has written. A reader asks for a note only once its time slot is over, and asks for a feed slot
 * only once a note has named it, so it never asks Bee for an address that is not written yet. Bee answers a chunk it
 * could not find by skipping every peer it asked for that address for a minute, which is what made new messages
 * arrive about forty seconds late while readers polled the next slot.
 *
 * Time slot `s` covers `[s * slotMs, (s + 1) * slotMs)` in Unix milliseconds. Its note is a single owner chunk signed
 * by the chat feed's key, at the identifier keccak256(`<topic>/note/<slotMs>/<s>`).
 */

export const NOTE_VERSION = 1;

export const DEFAULT_NOTE_SLOT_MS = 2_000;

export const DEFAULT_NOTE_HEARTBEAT_MS = 30_000;

/** A note is far below one chunk, so it is a single owner chunk with its payload inline. */
export const MAX_NOTE_BYTES = 256;

export const slotNoteSchema = z.strictObject({
  v: z.literal(NOTE_VERSION),
  /** The highest feed slot written when the note was written, -1 for a chat with nothing written yet. */
  newest: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  /** The server's clock when it wrote the note, in Unix milliseconds. */
  writtenAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type SlotNote = z.infer<typeof slotNoteSchema>;

function checkSlotMs(slotMs: number): void {
  if (!Number.isInteger(slotMs) || slotMs <= 0) {
    throw new RangeError(`a note slot is a positive whole number of milliseconds, not ${slotMs}`);
  }
}

/** The time slot that holds the instant `timeMs`. */
export function noteSlotOf(timeMs: number, slotMs: number): number {
  checkSlotMs(slotMs);
  return Math.floor(timeMs / slotMs);
}

/** The instant time slot `slot` ends, which is the first instant of the next one. */
export function noteSlotEnd(slot: number, slotMs: number): number {
  checkSlotMs(slotMs);
  return (slot + 1) * slotMs;
}

export function noteIdentifierText(topic: string, slotMs: number, slot: number): string {
  return `${topic}/note/${slotMs}/${slot}`;
}

export function noteIdentifier(topic: string, slotMs: number, slot: number): Identifier {
  return Identifier.fromString(noteIdentifierText(topic, slotMs, slot));
}

/**
 * Where a note lives, the address `GET /chunks/<address>` reads it from: keccak256 of the identifier and the owner,
 * the single owner chunk rule.
 */
export function noteAddress(topic: string, slotMs: number, slot: number, owner: string): Reference {
  const identifier = noteIdentifier(topic, slotMs, slot);
  return new Reference(Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), new EthAddress(owner).toUint8Array())));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The payload, with its fields in this order, so two encodings of one note are the same bytes. */
export function encodeSlotNote(note: Omit<SlotNote, 'v'>): Uint8Array {
  const ordered: SlotNote = { v: NOTE_VERSION, newest: note.newest, writtenAt: note.writtenAt };
  return encoder.encode(JSON.stringify(ordered));
}

/** A note, or null for anything that fails the strict check, which a reader treats as no note at all. */
export function parseSlotNote(payload: Uint8Array): SlotNote | null {
  if (payload.length > MAX_NOTE_BYTES) {
    return null;
  }
  try {
    const parsed = slotNoteSchema.safeParse(JSON.parse(decoder.decode(payload)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
