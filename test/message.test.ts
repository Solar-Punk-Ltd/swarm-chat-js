import { PrivateKey } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import {
  ChatMessageError,
  MAX_MESSAGE_BYTES,
  MessageType,
  checkChatMessage,
  countCharacters,
  createChatMessage,
  encodeChatMessage,
  hasValidSignature,
  newMessageId,
  parseChatMessage,
  signedBytes,
  type ChatMessage,
} from '../src/message';

// Test only. A key nobody holds funds with, fixed so the vectors below never change.
const TEST_KEY = '11'.repeat(32);
const TEST_ADDR = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Vector {
  message: ChatMessage;
  signed: string;
}

// Made with `new PrivateKey(TEST_KEY).sign(signed bytes)` and nothing else, as the contract prescribes.
const VECTORS: Vector[] = [
  {
    message: {
      v: 7,
      topic: 'chat-devcon-main',
      id: 'a1'.repeat(16),
      type: 'text',
      target: '',
      text: 'hello from the test vector',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140000000,
      sig: '346434b32d82cf1527ed5fcc1f756f9161452008c9de2cf47d883c011d04fba33d00416c445e714dfcf0e739e0bff4afe3cc4342d67a6b667966e2588e1634861b',
    },
    signed:
      '[7,"chat-devcon-main","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","text","","hello from the test vector","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140000000]',
  },
  {
    message: {
      v: 7,
      topic: 'chat-devcon-main',
      id: 'b2'.repeat(16),
      type: 'thread',
      target: 'a1'.repeat(16),
      text: 'a reply, with ünïcödé',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140001000,
      sig: 'f48f712291bfc51b86d590dc9f7cc806cf22de0c5acfef9bbd719eb012105f9f4c5ed116afabd51cf5fca5b5e84e3389261f5b2cdcc5c52f3993897086821a361b',
    },
    signed:
      '[7,"chat-devcon-main","b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2","thread","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","a reply, with ünïcödé","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140001000]',
  },
  {
    message: {
      v: 7,
      topic: 'chat-devcon-main',
      id: 'c3'.repeat(16),
      type: 'reaction',
      target: 'a1'.repeat(16),
      text: '👍',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140002000,
      sig: '71ce0a205e806cd6a53fedfb08e778ceb162d2af07f871dc9232b6372bfcfd857722af2444017a3c4218c889ba2ef483c37d06fda144a9ad2d8a688d3c506b421c',
    },
    signed:
      '[7,"chat-devcon-main","c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3","reaction","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","👍","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140002000]',
  },
];

function tampered(message: ChatMessage, change: Record<string, unknown>): unknown {
  return { ...message, ...change };
}

function flipLastHex(hex: string): string {
  const last = hex.at(-1) === '0' ? '1' : '0';
  return hex.slice(0, -1) + last;
}

describe('the test key', () => {
  it('owns the address the vectors carry', () => {
    expect(new PrivateKey(TEST_KEY).publicKey().address().toHex()).toBe(TEST_ADDR);
  });
});

describe.each(VECTORS)('vector $message.type', ({ message, signed }) => {
  it('builds the signed bytes the contract names', () => {
    expect(decoder.decode(signedBytes(message))).toBe(signed);
  });

  it('is signed to the same signature by createChatMessage', () => {
    const { message: made, bytes } = createChatMessage(TEST_KEY, {
      topic: message.topic,
      type: message.type,
      target: message.target,
      text: message.text,
      name: message.name,
      id: message.id,
      ts: message.ts,
    });
    expect(made).toEqual(message);
    expect(bytes).toEqual(encodeChatMessage(message));
  });

  it('passes the wire check', () => {
    expect(parseChatMessage(encodeChatMessage(message))).toEqual({ ok: true, message });
  });

  it('passes the object check, whatever order its fields arrived in', () => {
    const reversed = Object.fromEntries(Object.entries(message).reverse());
    expect(checkChatMessage(reversed)).toEqual({ ok: true, message });
  });

  // Each change keeps the shape valid, so only the signature can catch it.
  const signatureTampers: [string, Record<string, unknown>][] = [
    ['topic', { topic: `${message.topic}x` }],
    ['id', { id: 'd4'.repeat(16) }],
    ['text', { text: `${message.text}!` }],
    ['name', { name: 'someone' }],
    ['addr', { addr: '22'.repeat(20) }],
    ['ts', { ts: message.ts + 1 }],
    ['sig', { sig: flipLastHex(message.sig.slice(0, 128)) + message.sig.slice(128) }],
  ];
  // A text message's type and target cannot change without breaking its shape, which the next block covers.
  if (message.type !== MessageType.Text) {
    signatureTampers.push(
      ['target', { target: 'e5'.repeat(16) }],
      ['type', { type: message.type === MessageType.Thread ? MessageType.Reaction : MessageType.Thread }],
    );
  }

  it.each(signatureTampers)('is refused on its signature when %s changes', (_field, change) => {
    expect(checkChatMessage(tampered(message, change))).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('is refused on its shape when v changes', () => {
    expect(checkChatMessage(tampered(message, { v: 6 }))).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('the text vector with its type changed', () => {
  it('is refused on its shape, since a thread reply needs a target', () => {
    const [text] = VECTORS;
    expect(checkChatMessage(tampered(text!.message, { type: 'thread' }))).toMatchObject({
      ok: false,
      reason: 'shape',
    });
  });
});

describe('the shape', () => {
  const [{ message: valid }] = VECTORS as [Vector];

  it.each<[string, Record<string, unknown>]>([
    ['an empty topic', { topic: '' }],
    ['a topic of 129 characters', { topic: 't'.repeat(129) }],
    ['an id in capitals', { id: 'A1'.repeat(16) }],
    ['a short id', { id: 'a1'.repeat(15) }],
    ['an unknown type', { type: 'poll' }],
    ['a text message with a target', { target: 'a1'.repeat(16) }],
    ['an empty text', { text: '' }],
    ['a text of 501 characters', { text: 'x'.repeat(501) }],
    ['an empty name', { name: '' }],
    ['a name of 21 characters', { name: 'n'.repeat(21) }],
    ['an address with 0x', { addr: `0x${TEST_ADDR.slice(2)}` }],
    ['an address in capitals', { addr: TEST_ADDR.toUpperCase() }],
    ['a fractional ts', { ts: 1.5 }],
    ['a negative ts', { ts: -1 }],
    ['a ts as a string', { ts: '1759140000000' }],
    ['a short signature', { sig: valid.sig.slice(2) }],
    ['a field nobody signed', { admin: true }],
  ])('refuses %s', (_case, change) => {
    expect(checkChatMessage(tampered(valid, change))).toMatchObject({ ok: false, reason: 'shape' });
  });

  it.each([null, 'hello', 7, [], {}])('refuses %j', (value) => {
    expect(checkChatMessage(value)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('accepts a text and a name at exactly their caps, counted in code points', () => {
    const { message } = createChatMessage(TEST_KEY, {
      topic: 't'.repeat(128),
      type: MessageType.Text,
      text: '😀'.repeat(250) + 'x'.repeat(250),
      name: '😀'.repeat(20),
    });
    expect(checkChatMessage(message)).toEqual({ ok: true, message });
  });
});

describe('countCharacters', () => {
  it('counts an emoji outside the basic plane once', () => {
    expect(countCharacters('👍')).toBe(1);
    expect('👍'.length).toBe(2);
  });
});

describe('the wire check', () => {
  const [{ message }] = VECTORS as [Vector];

  it('refuses a payload over the byte cap before reading it', () => {
    const payload = new Uint8Array(MAX_MESSAGE_BYTES + 1).fill(0x20);
    expect(parseChatMessage(payload)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('accepts a payload of exactly the byte cap, padded with JSON whitespace', () => {
    const bytes = encodeChatMessage(message);
    const payload = new Uint8Array(MAX_MESSAGE_BYTES).fill(0x20);
    payload.set(bytes);
    expect(parseChatMessage(payload)).toEqual({ ok: true, message });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(parseChatMessage(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ ok: false, reason: 'not-utf8' });
  });

  it('refuses text that is not JSON', () => {
    expect(parseChatMessage(encoder.encode('{"v":7'))).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('refuses the empty payload', () => {
    expect(parseChatMessage(new Uint8Array())).toMatchObject({ ok: false, reason: 'not-json' });
  });
});

describe('the signature', () => {
  const [{ message }] = VECTORS as [Vector];

  it('is refused when it was made over any other bytes, such as the JSON object instead of the array', () => {
    const { sig: _sig, ...unsigned } = message;
    const sig = new PrivateKey(TEST_KEY).sign(encoder.encode(JSON.stringify(unsigned))).toHex();
    expect(hasValidSignature({ ...message, sig })).toBe(false);
  });

  it('is refused, not thrown, when its r is out of range', () => {
    expect(hasValidSignature({ ...message, sig: '0'.repeat(130) })).toBe(false);
  });
});

describe('createChatMessage', () => {
  it('fills the address from the key, a fresh id and the time', () => {
    const before = Date.now();
    const { message } = createChatMessage(TEST_KEY, {
      topic: 'chat-x',
      type: MessageType.Text,
      text: 'hi',
      name: 'me',
    });
    expect(message.addr).toBe(TEST_ADDR);
    expect(message.id).toMatch(/^[0-9a-f]{32}$/);
    expect(message.ts).toBeGreaterThanOrEqual(before);
    expect(message.target).toBe('');
    expect(hasValidSignature(message)).toBe(true);
  });

  it('refuses a field outside its cap before signing', () => {
    expect(() =>
      createChatMessage(TEST_KEY, { topic: 'chat-x', type: MessageType.Text, text: 'x'.repeat(501), name: 'me' }),
    ).toThrow(ChatMessageError);
  });

  it('refuses a reaction with no target', () => {
    try {
      createChatMessage(TEST_KEY, { topic: 'chat-x', type: MessageType.Reaction, text: '👍', name: 'me' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChatMessageError);
      expect((error as ChatMessageError).reason).toBe('shape');
    }
  });

  it('refuses a message whose fields fit but whose payload is over the byte cap', () => {
    // 500 characters of four UTF-8 bytes each, with JSON escaping none of them, is 2,000 bytes of text alone.
    try {
      createChatMessage(TEST_KEY, {
        topic: 't'.repeat(128),
        type: MessageType.Text,
        text: '😀'.repeat(500),
        name: 'me',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChatMessageError);
      expect((error as ChatMessageError).reason).toBe('too-large');
    }
  });

  it('counts JSON escaping against the byte cap, as the server measures it', () => {
    // A control character is one character, one byte of UTF-8 and six bytes once JSON escapes it as \u0001.
    const controls = '\u0001'.repeat(500);
    try {
      createChatMessage(TEST_KEY, { topic: 'chat-x', type: MessageType.Text, text: controls, name: 'me' });
    } catch (error) {
      expect((error as ChatMessageError).reason).toBe('too-large');
      return;
    }
    throw new Error('expected the escaped payload to exceed the cap');
  });
});

describe('newMessageId', () => {
  it('makes 32 lowercase hex characters, different each time', () => {
    const ids = new Set(Array.from({ length: 100 }, newMessageId));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
