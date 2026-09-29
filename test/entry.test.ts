import { describe, expect, it } from 'vitest';

import { createChatMessage, MessageType, parseFeedEntry, parseHistoryFile, type ChatMessage } from '../src/message';

// Test only.
const TEST_KEY = '11'.repeat(32);
const TOPIC = 'chat-test';
const REF = 'ab'.repeat(32);

const encoder = new TextEncoder();

function message(text: string, topic = TOPIC): ChatMessage {
  return createChatMessage(TEST_KEY, { topic, type: MessageType.TEXT, text, name: 'tester' }).message;
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

describe('parseFeedEntry', () => {
  const msg = message('hello');
  const entry = { v: 7, seq: 4, at: 1759140000000, msg, history: { ref: REF, toSeq: 2 } };

  it('reads an entry at its own index', () => {
    expect(parseFeedEntry(bytes(entry), 4, TOPIC)).toEqual({ ok: true, value: entry });
  });

  it('reads an entry with no history yet', () => {
    expect(parseFeedEntry(bytes({ ...entry, history: null }), 4, TOPIC)).toMatchObject({ ok: true });
  });

  it('accepts an encrypted reference of 128 hex characters', () => {
    const link = { ref: 'cd'.repeat(64), toSeq: 2 };
    expect(parseFeedEntry(bytes({ ...entry, history: link }), 4, TOPIC)).toMatchObject({ ok: true });
  });

  it('refuses an entry whose seq is not its index', () => {
    expect(parseFeedEntry(bytes(entry), 5, TOPIC)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('refuses an entry whose message belongs to another chat', () => {
    expect(parseFeedEntry(bytes({ ...entry, msg: message('hi', 'chat-other') }), 4, TOPIC)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
  });

  it.each<[string, unknown]>([
    ['another version', { ...entry, v: 6 }],
    ['a negative seq', { ...entry, seq: -1 }],
    ['a message of the wrong shape', { ...entry, msg: { ...msg, id: 'x' } }],
    ['a history link with a short ref', { ...entry, history: { ref: 'ab', toSeq: 2 } }],
    ['an unknown field', { ...entry, extra: 1 }],
    ['a 6.2.8 entry', { message: { id: 'x' }, messageStateRefs: null }],
  ])('refuses %s', (_case, value) => {
    expect(parseFeedEntry(bytes(value), 4, TOPIC)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('refuses bytes that are not UTF-8, and text that is not JSON', () => {
    expect(parseFeedEntry(new Uint8Array([0xff]), 0, TOPIC)).toMatchObject({ ok: false, reason: 'not-utf8' });
    expect(parseFeedEntry(encoder.encode('{'), 0, TOPIC)).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('does not check the signature, which the server checked', () => {
    const forged = { ...msg, text: 'changed after signing' };
    expect(parseFeedEntry(bytes({ ...entry, msg: forged }), 4, TOPIC)).toMatchObject({ ok: true });
  });
});

describe('parseHistoryFile', () => {
  const rows = [0, 1, 2].map((seq) => ({ seq, at: 1759140000000 + seq, msg: message(`message ${seq}`) }));
  const file = { v: 7, topic: TOPIC, fromSeq: 0, toSeq: 2, messages: rows, prev: null };
  const link = { ref: REF, toSeq: 2 };

  it('reads the file its link names', () => {
    expect(parseHistoryFile(bytes(file), TOPIC, link)).toEqual({
      ok: true,
      value: { topic: TOPIC, fromSeq: 0, toSeq: 2, rows, prev: null, skipped: 0 },
    });
  });

  it('keeps a link to the file before it', () => {
    const prev = { ref: 'ef'.repeat(32), toSeq: 999 };
    const later = { ...file, fromSeq: 1000, toSeq: 1002, messages: [], prev };
    const check = parseHistoryFile(bytes(later), TOPIC, { ref: REF, toSeq: 1002 });
    expect(check.ok && check.value.prev).toEqual(prev);
  });

  it('leaves out and counts a bad row instead of refusing the file', () => {
    const messages = [
      rows[0],
      { ...rows[1], msg: { id: 'broken' } },
      { ...rows[2], seq: 7 },
      { seq: 1, at: 1, msg: message('elsewhere', 'chat-other') },
      rows[2],
    ];
    const check = parseHistoryFile(bytes({ ...file, messages }), TOPIC, link);
    expect(check.ok && check.value.rows).toEqual([rows[0], rows[2]]);
    expect(check.ok && check.value.skipped).toBe(3);
  });

  it('refuses a file that is not the one its link names', () => {
    expect(parseHistoryFile(bytes(file), TOPIC, { ref: REF, toSeq: 3 })).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
    expect(parseHistoryFile(bytes(file), 'chat-other', link)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('refuses a file whose range runs backwards', () => {
    expect(parseHistoryFile(bytes({ ...file, fromSeq: 3 }), TOPIC, link)).toMatchObject({ ok: false, reason: 'shape' });
  });
});
