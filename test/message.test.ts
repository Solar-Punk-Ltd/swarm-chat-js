import { PrivateKey } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import {
  ChatMessageError,
  MAX_MESSAGE_BYTES,
  MessageType,
  MessageVia,
  countCharacters,
  createChatMessage,
  encodeChatMessage,
  hasValidSignature,
  newMessageId,
  parseChatMessage,
  signedBytes,
  verifyChatMessage,
  type ChatMessage,
} from '../src/message';
import { BOUND_CHAT_ADDR, BOUND_SITE, CHAT_BINDING, chatKeyFor, FORK_ACCOUNT } from './bindingVectors';

// Test only. A key nobody holds funds with, fixed so the vectors below never change.
const TEST_KEY = '11'.repeat(32);
const TEST_ADDR = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Vector {
  label: string;
  message: ChatMessage;
  signed: string;
}

// Made with `new PrivateKey(key).sign(signed bytes)` and nothing else, as the contract prescribes. The bound vector's
// key is the fork's chat key for BOUND_SITE, derived from the fork's test account as `chatKeyFor` derives it.
const VECTORS: Vector[] = [
  {
    label: 'a text sent through the gateway',
    message: {
      v: 8,
      topic: 'chat-devcon-main',
      id: 'a1'.repeat(16),
      type: 'text',
      target: '',
      text: 'hello from the test vector',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140000000,
      via: 'gateway',
      own: false,
      sig: '1daf01a06e3ce691ba8dd6f6e949ae0ee96005288529ec112f4851dd18ed9c3d4832b4e6b0ddcda6eac97154f466eac291d14a6d049f1131edf8588c782858561c',
    },
    signed:
      '[8,"chat-devcon-main","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","text","","hello from the test vector","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140000000,"gateway",false,"",""]',
  },
  {
    label: 'a thread reply on its own stamp, kept in its own feed',
    message: {
      v: 8,
      topic: 'chat-devcon-main',
      id: 'b2'.repeat(16),
      type: 'thread',
      target: 'a1'.repeat(16),
      text: 'a reply, with ünïcödé',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140001000,
      via: 'own-stamp',
      own: true,
      sig: '2251fedc8ee7361939bc5b1dcec97940f10faf82ef3efd64170049740e709c7c5c70be9bd16a818ff628546e0681f6ed0ed8de77c6d0e76d16ead165dc66f3681b',
    },
    signed:
      '[8,"chat-devcon-main","b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2","thread","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","a reply, with ünïcödé","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140001000,"own-stamp",true,"",""]',
  },
  {
    label: 'a reaction',
    message: {
      v: 8,
      topic: 'chat-devcon-main',
      id: 'c3'.repeat(16),
      type: 'reaction',
      target: 'a1'.repeat(16),
      text: '👍',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140002000,
      via: 'gateway',
      own: false,
      sig: '3fb5837f0bde6860b090f3afac5b5600437e75ef61c3deff1211fa3aaa4d9ea959dcac831ea9ff8ad76d69b310a71338cf17886ad5a786508851b81c49c514e71c',
    },
    signed:
      '[8,"chat-devcon-main","c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3","reaction","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","👍","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140002000,"gateway",false,"",""]',
  },
  {
    label: 'a text by a signed-in sender',
    message: {
      v: 8,
      topic: 'chat-devcon-main',
      id: 'd4'.repeat(16),
      type: 'text',
      target: '',
      text: 'signed in with Swarm ID',
      name: 'tester',
      addr: BOUND_CHAT_ADDR,
      ts: 1759140003000,
      via: 'own-stamp',
      own: true,
      idb: CHAT_BINDING,
      sig: '6d1da0dca31dc883e090dae9a8ccf1edb88a5d38aa2bd6a9f380641349c2eddc316b545283da8f34952a5af71cf5b33fe87d6eb40bfe7b920d9651170be197a81c',
    },
    signed:
      '[8,"chat-devcon-main","d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4","text","","signed in with Swarm ID","tester","a531fcf12e72328748c12ba58b2b023c00e9a8f9",1759140003000,"own-stamp",true,"Swarm ID chat binding v1\\nSite: https://example.com\\nChat address: 0xa531fcf12e72328748c12ba58b2b023c00e9a8f9\\nDate: 2026-10-14T12:00:00.000Z","0x81b66b5a35aac1203c8c19883c40965e1eaee71ba57df28d3465cb8e03cf4263297bc64b2e5db5d815ae4ebb504f0a8c36ead8193bb13cd44138b2de44642c7d1c"]',
  },
];

const [TEXT_VECTOR, , , BOUND_VECTOR] = VECTORS as [Vector, Vector, Vector, Vector];

const BOUND_IDENTITY = { account: FORK_ACCOUNT, site: BOUND_SITE, date: '2026-10-14T12:00:00.000Z' };

function identityOf(message: ChatMessage) {
  return message.idb ? BOUND_IDENTITY : null;
}

async function keyOf(message: ChatMessage): Promise<string> {
  return message.idb ? chatKeyFor(BOUND_SITE) : TEST_KEY;
}

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

describe.each(VECTORS)('the vector of $label', ({ message, signed }) => {
  it('builds the signed bytes the contract names', () => {
    expect(decoder.decode(signedBytes(message))).toBe(signed);
  });

  it('is signed to the same signature by createChatMessage', async () => {
    const { message: made, bytes } = createChatMessage(await keyOf(message), {
      topic: message.topic,
      type: message.type,
      target: message.target,
      text: message.text,
      name: message.name,
      id: message.id,
      ts: message.ts,
      via: message.via,
      own: message.own,
      ...(message.idb ? { idb: message.idb } : {}),
    });
    expect(made).toEqual(message);
    expect(bytes).toEqual(encodeChatMessage(message));
  });

  it('emits its fields in the contract order', () => {
    const keys = Object.keys(JSON.parse(decoder.decode(encodeChatMessage(message))) as object);
    const order = ['v', 'topic', 'id', 'type', 'target', 'text', 'name', 'addr', 'ts', 'via', 'own', 'idb', 'sig'];
    expect(keys).toEqual(order.filter((key) => key !== 'idb' || message.idb));
  });

  it('passes the wire check', () => {
    expect(parseChatMessage(encodeChatMessage(message))).toEqual({
      ok: true,
      message,
      identity: identityOf(message),
    });
  });

  it('passes the object check, whatever order its fields arrived in', () => {
    const reversed = Object.fromEntries(Object.entries(message).reverse());
    expect(verifyChatMessage(reversed)).toEqual({ ok: true, message, identity: identityOf(message) });
  });

  // Each change keeps the shape valid, so only the signature can catch it.
  const signatureTampers: [string, Record<string, unknown>][] = [
    ['topic', { topic: `${message.topic}x` }],
    ['id', { id: 'e6'.repeat(16) }],
    ['text', { text: `${message.text}!` }],
    ['name', { name: 'someone' }],
    ['addr', { addr: '22'.repeat(20) }],
    ['ts', { ts: message.ts + 1 }],
    ['via', { via: message.via === MessageVia.GATEWAY ? MessageVia.OWN_STAMP : MessageVia.GATEWAY }],
    ['own', { own: !message.own }],
    ['sig', { sig: flipLastHex(message.sig.slice(0, 128)) + message.sig.slice(128) }],
  ];
  // A text message's type and target cannot change without breaking its shape, which the next block covers.
  if (message.type !== MessageType.TEXT) {
    signatureTampers.push(
      ['target', { target: 'e5'.repeat(16) }],
      ['type', { type: message.type === MessageType.THREAD ? MessageType.REACTION : MessageType.THREAD }],
    );
  }
  if (message.idb) {
    const { msg, sig } = message.idb;
    signatureTampers.push(
      ['idb left out', { idb: undefined }],
      ['idb.msg', { idb: { msg: msg.replace('12:00:00', '12:00:01'), sig } }],
      ['idb.sig', { idb: { msg, sig: flipLastHex(sig.slice(0, 130)) + sig.slice(130) } }],
    );
  } else {
    signatureTampers.push(['idb added', { idb: CHAT_BINDING }]);
  }

  it.each(signatureTampers)('is refused on its signature when %s changes', (_field, change) => {
    expect(verifyChatMessage(tampered(message, change))).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('is refused on its shape when v changes', () => {
    expect(verifyChatMessage(tampered(message, { v: 7 }))).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('a version 7 message', () => {
  // The first vector of the 7.3.0 suite, exactly as 7.x signed and sent it.
  const v7 = {
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
  };

  it('is refused on its shape, on the wire and as an object', () => {
    expect(parseChatMessage(encoder.encode(JSON.stringify(v7)))).toMatchObject({ ok: false, reason: 'shape' });
    expect(verifyChatMessage(v7)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('is refused on its shape with v raised to 8, since it lacks via and own', () => {
    expect(verifyChatMessage({ ...v7, v: 8 })).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('the text vector with its type changed', () => {
  it('is refused on its shape, since a thread reply needs a target', () => {
    expect(verifyChatMessage(tampered(TEXT_VECTOR.message, { type: 'thread' }))).toMatchObject({
      ok: false,
      reason: 'shape',
    });
  });
});

describe('the shape', () => {
  const valid = TEXT_VECTOR.message;
  const { msg, sig } = CHAT_BINDING;

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
    ['an unknown via', { via: 'free' }],
    ['no via', { via: undefined }],
    ['own as a string', { own: 'false' }],
    ['no own', { own: undefined }],
    ['a binding with a field nobody signed', { idb: { msg, sig, extra: 1 } }],
    ['a binding signature without 0x', { idb: { msg, sig: sig.slice(2) } }],
    ['a binding signature in capitals', { idb: { msg, sig: `0x${sig.slice(2).toUpperCase()}` } }],
    ['a binding signature of 64 bytes', { idb: { msg, sig: sig.slice(0, -2) } }],
    ['a binding text of 513 characters', { idb: { msg: 'm'.repeat(513), sig } }],
    ['a binding with no signature', { idb: { msg } }],
    ['a short signature', { sig: valid.sig.slice(2) }],
    ['a field nobody signed', { admin: true }],
  ])('refuses %s', (_case, change) => {
    expect(verifyChatMessage(tampered(valid, change))).toMatchObject({ ok: false, reason: 'shape' });
  });

  it.each([null, 'hello', 7, [], {}])('refuses %j', (value) => {
    expect(verifyChatMessage(value)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('accepts a text and a name at exactly their caps, counted in code points', () => {
    const { message } = createChatMessage(TEST_KEY, {
      topic: 't'.repeat(128),
      type: MessageType.TEXT,
      text: '😀'.repeat(250) + 'x'.repeat(250),
      name: '😀'.repeat(20),
      via: MessageVia.GATEWAY,
    });
    expect(verifyChatMessage(message)).toEqual({ ok: true, message, identity: null });
  });
});

describe('countCharacters', () => {
  it('counts an emoji outside the basic plane once', () => {
    expect(countCharacters('👍')).toBe(1);
    expect('👍'.length).toBe(2);
  });
});

describe('the byte cap', () => {
  it('is 3072 bytes', () => {
    expect(MAX_MESSAGE_BYTES).toBe(3072);
  });

  it('holds a 500 character text of two byte characters with a binding, at every other cap', async () => {
    const { bytes } = createChatMessage(await chatKeyFor(BOUND_SITE), {
      topic: 't'.repeat(128),
      type: MessageType.THREAD,
      target: 'a1'.repeat(16),
      text: 'ü'.repeat(500),
      name: 'n'.repeat(20),
      ts: Number.MAX_SAFE_INTEGER,
      via: MessageVia.OWN_STAMP,
      own: true,
      idb: CHAT_BINDING,
    });
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe('the wire check', () => {
  const message = TEXT_VECTOR.message;

  it('refuses a payload over the byte cap before reading it', () => {
    const payload = new Uint8Array(MAX_MESSAGE_BYTES + 1).fill(0x20);
    expect(parseChatMessage(payload)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('accepts a payload of exactly the byte cap, padded with JSON whitespace', () => {
    const bytes = encodeChatMessage(message);
    const payload = new Uint8Array(MAX_MESSAGE_BYTES).fill(0x20);
    payload.set(bytes);
    expect(parseChatMessage(payload)).toEqual({ ok: true, message, identity: null });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(parseChatMessage(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ ok: false, reason: 'not-utf8' });
  });

  it('refuses text that is not JSON', () => {
    expect(parseChatMessage(encoder.encode('{"v":8'))).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('refuses the empty payload', () => {
    expect(parseChatMessage(new Uint8Array())).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('hands the origin to the binding check', () => {
    const payload = encodeChatMessage(BOUND_VECTOR.message);
    expect(parseChatMessage(payload, { origin: 'https://other.example' })).toMatchObject({
      ok: false,
      reason: 'binding',
    });
  });
});

describe('the signature', () => {
  const message = TEXT_VECTOR.message;

  it('is refused when it was made over any other bytes, such as the JSON object instead of the array', () => {
    const { sig: _sig, ...unsigned } = message;
    const sig = new PrivateKey(TEST_KEY).sign(encoder.encode(JSON.stringify(unsigned))).toHex();
    expect(hasValidSignature({ ...message, sig })).toBe(false);
  });

  it('is refused when it was made over the version 7 fields alone', () => {
    const v7Fields = (JSON.parse(TEXT_VECTOR.signed) as unknown[]).slice(0, 9);
    const sig = new PrivateKey(TEST_KEY).sign(encoder.encode(JSON.stringify(v7Fields))).toHex();
    expect(hasValidSignature({ ...message, sig })).toBe(false);
  });

  it('is refused, not thrown, when its r is out of range', () => {
    expect(hasValidSignature({ ...message, sig: '0'.repeat(130) })).toBe(false);
  });
});

describe('createChatMessage', () => {
  it('fills the address from the key, a fresh id, the time, and own as false', () => {
    const before = Date.now();
    const { message } = createChatMessage(TEST_KEY, {
      topic: 'chat-x',
      type: MessageType.TEXT,
      text: 'hi',
      name: 'me',
      via: MessageVia.GATEWAY,
    });
    expect(message.addr).toBe(TEST_ADDR);
    expect(message.id).toMatch(/^[0-9a-f]{32}$/);
    expect(message.ts).toBeGreaterThanOrEqual(before);
    expect(message.target).toBe('');
    expect(message.own).toBe(false);
    expect('idb' in message).toBe(false);
    expect(hasValidSignature(message)).toBe(true);
  });

  it('refuses a draft with no via rather than choosing one', () => {
    const draft = { topic: 'chat-x', type: MessageType.TEXT, text: 'hi', name: 'me' };
    expect(() => createChatMessage(TEST_KEY, draft as Parameters<typeof createChatMessage>[1])).toThrow(
      ChatMessageError,
    );
  });

  it('refuses a field outside its cap before signing', () => {
    expect(() =>
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.TEXT,
        text: 'x'.repeat(501),
        name: 'me',
        via: MessageVia.GATEWAY,
      }),
    ).toThrow(ChatMessageError);
  });

  it('refuses a reaction with no target', () => {
    try {
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.REACTION,
        text: '👍',
        name: 'me',
        via: MessageVia.GATEWAY,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChatMessageError);
      expect((error as ChatMessageError).reason).toBe('shape');
    }
  });

  it('refuses a message whose fields fit but whose payload is over the byte cap', async () => {
    // Every field at its cap in four byte characters, with a binding, is over 3,072 bytes.
    try {
      createChatMessage(await chatKeyFor(BOUND_SITE), {
        topic: '😀'.repeat(128),
        type: MessageType.TEXT,
        text: '😀'.repeat(500),
        name: '😀'.repeat(20),
        via: MessageVia.OWN_STAMP,
        idb: CHAT_BINDING,
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
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.TEXT,
        text: controls,
        name: 'me',
        via: MessageVia.GATEWAY,
      });
    } catch (error) {
      expect((error as ChatMessageError).reason).toBe('too-large');
      return;
    }
    throw new Error('expected the escaped payload to exceed the cap');
  });

  it('refuses, before signing, a binding that names another chat address', () => {
    try {
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.TEXT,
        text: 'hi',
        name: 'me',
        via: MessageVia.OWN_STAMP,
        idb: CHAT_BINDING,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChatMessageError);
      expect((error as ChatMessageError).reason).toBe('binding');
    }
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
