import { Bytes, EthAddress } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTE_SLOT_MS,
  encodeSlotNote,
  noteAddress,
  noteIdentifier,
  noteIdentifierText,
  noteSlotEnd,
  noteSlotOf,
  parseSlotNote,
} from '../src/message';

const TOPIC = 'chat-test';
const OWNER = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

const encoder = new TextEncoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

describe('slot arithmetic', () => {
  it('cuts wall-clock time into slots of slotMs, slot s covering [s * slotMs, (s + 1) * slotMs)', () => {
    expect(DEFAULT_NOTE_SLOT_MS).toBe(2000);
    expect(noteSlotOf(0, 2000)).toBe(0);
    expect(noteSlotOf(1999, 2000)).toBe(0);
    expect(noteSlotOf(2000, 2000)).toBe(1);
    expect(noteSlotOf(1759140001234, 2000)).toBe(879570000);
    expect(noteSlotEnd(879570000, 2000)).toBe(1759140002000);
  });

  it('refuses a slot length that is not a positive whole number of milliseconds', () => {
    expect(() => noteSlotOf(1000, 0)).toThrow();
    expect(() => noteSlotOf(1000, 1.5)).toThrow();
  });
});

describe('the note address', () => {
  it('names the note "<topic>/note/<slotMs>/<slot>"', () => {
    expect(noteIdentifierText(TOPIC, 2000, 5)).toBe('chat-test/note/2000/5');
  });

  it('is keccak256 of that text, pinned by the first bytes of a fixed vector', () => {
    const identifier = noteIdentifier(TOPIC, 2000, 5);
    expect(identifier.toHex()).toBe(Bytes.keccak256(encoder.encode('chat-test/note/2000/5')).toHex());
    expect(identifier.toHex().startsWith('e53e499ce1d643f2')).toBe(true);
  });

  it('is the single owner chunk address of that identifier under the feed owner', () => {
    const identifier = noteIdentifier(TOPIC, 2000, 5);
    const expected = Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), new EthAddress(OWNER).toUint8Array()));
    expect(noteAddress(TOPIC, 2000, 5, OWNER).toHex()).toBe(expected.toHex());
    expect(noteAddress(TOPIC, 2000, 5, `0x${OWNER}`).toHex().startsWith('2e658376b70de7e6')).toBe(true);
  });

  it('differs by chat, by slot length and by slot', () => {
    const base = noteIdentifier(TOPIC, 2000, 5).toHex();
    expect(noteIdentifier('other-chat', 2000, 5).toHex()).not.toBe(base);
    expect(noteIdentifier(TOPIC, 1000, 5).toHex()).not.toBe(base);
    expect(noteIdentifier(TOPIC, 2000, 6).toHex()).not.toBe(base);
  });
});

describe('the note payload', () => {
  it('encodes exactly {"v":1,"newest":N,"writtenAt":T}', () => {
    const text = new TextDecoder().decode(encodeSlotNote({ newest: 41, writtenAt: 1759140002003 }));
    expect(text).toBe('{"v":1,"newest":41,"writtenAt":1759140002003}');
  });

  it('reads back what it encodes', () => {
    const note = { newest: 7, writtenAt: 1759140002003 };
    expect(parseSlotNote(encodeSlotNote(note))).toEqual({ v: 1, ...note });
  });

  it('reads a note of a chat that has nothing written yet, newest -1', () => {
    expect(parseSlotNote(bytes({ v: 1, newest: -1, writtenAt: 1 }))).toEqual({ v: 1, newest: -1, writtenAt: 1 });
  });

  it.each([
    ['another version', { v: 2, newest: 1, writtenAt: 1 }],
    ['an extra field', { v: 1, newest: 1, writtenAt: 1, extra: true }],
    ['a missing field', { v: 1, newest: 1 }],
    ['a fractional newest', { v: 1, newest: 1.5, writtenAt: 1 }],
    ['a newest below -1', { v: 1, newest: -2, writtenAt: 1 }],
    ['a negative writtenAt', { v: 1, newest: 1, writtenAt: -1 }],
    ['a string newest', { v: 1, newest: '1', writtenAt: 1 }],
  ])('treats a note with %s as absent', (_, value) => {
    expect(parseSlotNote(bytes(value))).toBeNull();
  });

  it('treats bytes that are not UTF-8 JSON as absent', () => {
    expect(parseSlotNote(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseSlotNote(encoder.encode('not json'))).toBeNull();
  });
});
