import { PrivateKey, Signature } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import {
  ChatMessageError,
  MAX_MESSAGE_BYTES,
  MessageType,
  MessageVia,
  countCharacters,
  displayNameProblem,
  createChatMessage,
  encodeChatMessage,
  hasValidSignature,
  newMessageId,
  parseChatMessage,
  signedBytes,
  verifyChatMessage,
  type ChatMessage,
} from '../src/message';
import { AT_SITE, BOUND_CHAT_ADDR, BOUND_SITE, CHAT_BINDING, chatKeyFor, FORK_ACCOUNT } from './bindingVectors';

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
// key is Swarm ID's chat key for BOUND_SITE, derived from Swarm ID's test account as `chatKeyFor` derives it.
const VECTORS: Vector[] = [
  {
    label: 'a text sent through the gateway',
    message: {
      v: 9,
      topic: 'chat-devcon-main',
      id: 'a1'.repeat(16),
      type: 'text',
      target: '',
      text: 'hello from the test vector',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140000000,
      via: 'gateway',
      sig: 'f158cb273d7f78787df066e839ce173fed6da4e9619fd1c4a5658869b4db28c32fc74c8bd9b140973b7cc0e1db1ea8ba1eb469fe772b5f68073c1d9d5ae8fbcd1b',
    },
    signed:
      '[9,"chat-devcon-main","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","text","","hello from the test vector","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140000000,"gateway","",""]',
  },
  {
    label: 'a thread reply on its own stamp',
    message: {
      v: 9,
      topic: 'chat-devcon-main',
      id: 'b2'.repeat(16),
      type: 'thread',
      target: 'a1'.repeat(16),
      text: 'a reply, with ünïcödé',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140001000,
      via: 'own-stamp',
      sig: '93a6355ca9bc167f6786c6bfa1ba79ca1ba885c30e19120a6d591f84d49561235e9f1a0aeef5e3c6c8b6b15ab25592b8915a8a134a3cdc55529ac1d907cee5291b',
    },
    signed:
      '[9,"chat-devcon-main","b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2","thread","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","a reply, with ünïcödé","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140001000,"own-stamp","",""]',
  },
  {
    label: 'a reaction',
    message: {
      v: 9,
      topic: 'chat-devcon-main',
      id: 'c3'.repeat(16),
      type: 'reaction',
      target: 'a1'.repeat(16),
      text: '👍',
      name: 'tester',
      addr: TEST_ADDR,
      ts: 1759140002000,
      via: 'gateway',
      sig: '6b827f90a64d8b4bb90d566683cbdec376669a6c69da9703a5500c20709f409c71469d22d5e04c72fc17afb5758da5ae89b94c00de39959847b443fbe34164f31b',
    },
    signed:
      '[9,"chat-devcon-main","c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3","reaction","a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1","👍","tester","19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",1759140002000,"gateway","",""]',
  },
  {
    label: 'a text by a signed-in sender',
    message: {
      v: 9,
      topic: 'chat-devcon-main',
      id: 'd4'.repeat(16),
      type: 'text',
      target: '',
      text: 'signed in with Swarm ID',
      name: 'tester',
      addr: BOUND_CHAT_ADDR,
      ts: 1759140003000,
      via: 'own-stamp',
      idb: CHAT_BINDING,
      sig: 'a75128a07db639a16fe5ec8defb4176f0d86f893c190c110318a22c1e5ad91be26bb8af2e0b4eb9f5805d921d92c28725d49f6027618c7814cf3a5434568068e1c',
    },
    signed:
      '[9,"chat-devcon-main","d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4","text","","signed in with Swarm ID","tester","c6b7cb635534a22fbc368643cc40355545f666dc",1759140003000,"own-stamp","Swarm ID chat binding v1\\nSite: https://example.com\\nChat address: 0xc6b7cb635534a22fbc368643cc40355545f666dc\\nDate: 2026-10-14T12:00:00.000Z","0xee2151a66fcdb0852b1bff2a03578aff9556f893e4c6d2aef2d484b4ada153804a7b1c97f40eac18fbd5f75674c918c48a761800e8122b7eae7af45393d9a24d1b"]',
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
      ...(message.idb ? { idb: message.idb } : {}),
    });
    expect(made).toEqual(message);
    expect(bytes).toEqual(encodeChatMessage(message));
  });

  it('emits its fields in the contract order', () => {
    const keys = Object.keys(JSON.parse(decoder.decode(encodeChatMessage(message))) as object);
    const order = ['v', 'topic', 'id', 'type', 'target', 'text', 'name', 'addr', 'ts', 'via', 'idb', 'sig'];
    expect(keys).toEqual(order.filter((key) => key !== 'idb' || message.idb));
  });

  it('passes the wire check', () => {
    expect(parseChatMessage(encodeChatMessage(message), AT_SITE)).toEqual({
      ok: true,
      message,
      identity: identityOf(message),
    });
  });

  it('passes the object check, whatever order its fields arrived in', () => {
    const reversed = Object.fromEntries(Object.entries(message).reverse());
    expect(verifyChatMessage(reversed, AT_SITE)).toEqual({ ok: true, message, identity: identityOf(message) });
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
    expect(verifyChatMessage(tampered(message, change), AT_SITE)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('is refused on its shape when v changes', () => {
    expect(verifyChatMessage(tampered(message, { v: 7 }), AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
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
    expect(parseChatMessage(encoder.encode(JSON.stringify(v7)), AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
    expect(verifyChatMessage(v7, AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('is refused on its shape with v raised to 9, since it lacks via', () => {
    expect(verifyChatMessage({ ...v7, v: 9 }, AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('a version 8 message without own', () => {
  // The first vector at version 8, as the 9.0 work signed it before the version moved, its signature valid.
  const v8 = {
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
    sig: 'f143f81be739f3e17f4c941680423b552fe52dcd264ea834cbd578c3a818c7011e20d08f2cd394348a8cb055a608cbe767c36129bd9e46364a5d82facf0fafc11c',
  };

  it('is refused on its version, on the wire and as an object', () => {
    expect(parseChatMessage(encoder.encode(JSON.stringify(v8)), AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
    expect(verifyChatMessage(v8, AT_SITE)).toMatchObject({
      ok: false,
      reason: 'shape',
      detail: expect.stringMatching(/^v:/),
    });
  });

  it('is refused on its signature with only v raised to 9', () => {
    expect(verifyChatMessage({ ...v8, v: 9 }, AT_SITE)).toMatchObject({ ok: false, reason: 'signature' });
  });
});

describe('a message as 8.1 signed it, with own', () => {
  // The first vector of the 8.1.0 suite, exactly as 8.1 signed and sent it, its signature valid over its own bytes.
  const signedBy81 = {
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
  };

  it('is refused on its shape, on the wire and as an object', () => {
    expect(parseChatMessage(encoder.encode(JSON.stringify(signedBy81)), AT_SITE)).toMatchObject({
      ok: false,
      reason: 'shape',
    });
    expect(verifyChatMessage(signedBy81, AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('the text vector with its type changed', () => {
  it('is refused on its shape, since a thread reply needs a target', () => {
    expect(verifyChatMessage(tampered(TEXT_VECTOR.message, { type: 'thread' }), AT_SITE)).toMatchObject({
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
    ['a name with a right-to-left override', { name: 'evil\u202egnp.exe' }],
    ['a name with a left-to-right isolate', { name: '\u2066admin' }],
    ['a name with a zero width space', { name: 'ad\u200bmin' }],
    ['a name with a byte order mark', { name: '\ufeffadmin' }],
    ['a name with a newline', { name: 'line\nbreak' }],
    ['a name with a NUL', { name: 'nul\u0000' }],
    ['a name with a DEL', { name: 'del\u007f' }],
    ['a name with a left-to-right mark', { name: 'ad\u200emin' }],
    ['a name with a word joiner', { name: 'ad\u2060min' }],
    ['a name with a soft hyphen', { name: 'ad\u00admin' }],
    ['a name ending in .eth', { name: 'alice.eth' }],
    ['a fullwidth name ending in .eth', { name: '\uff36\uff29\uff34\uff21\uff2c\uff29\uff2b\uff0e\uff25\uff34\uff28' }],
    ['an address with 0x', { addr: `0x${TEST_ADDR.slice(2)}` }],
    ['an address in capitals', { addr: TEST_ADDR.toUpperCase() }],
    ['a fractional ts', { ts: 1.5 }],
    ['a negative ts', { ts: -1 }],
    ['a ts as a string', { ts: '1759140000000' }],
    ['an unknown via', { via: 'free' }],
    ['no via', { via: undefined }],
    ['the own field 8.1 signed', { own: false }],
    ['a binding with a field nobody signed', { idb: { msg, sig, extra: 1 } }],
    ['a binding signature without 0x', { idb: { msg, sig: sig.slice(2) } }],
    ['a binding signature in capitals', { idb: { msg, sig: `0x${sig.slice(2).toUpperCase()}` } }],
    ['a binding signature of 64 bytes', { idb: { msg, sig: sig.slice(0, -2) } }],
    ['a binding text of 513 characters', { idb: { msg: 'm'.repeat(513), sig } }],
    ['a binding with no signature', { idb: { msg } }],
    ['a short signature', { sig: valid.sig.slice(2) }],
    ['a field nobody signed', { admin: true }],
  ])('refuses %s', (_case, change) => {
    expect(verifyChatMessage(tampered(valid, change), AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it.each([null, 'hello', 7, [], {}])('refuses %j', (value) => {
    expect(verifyChatMessage(value, AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('accepts a text and a name at exactly their caps, counted in code points', () => {
    const { message } = createChatMessage(TEST_KEY, {
      topic: 't'.repeat(128),
      type: MessageType.TEXT,
      text: '😀'.repeat(250) + 'x'.repeat(250),
      name: '😀'.repeat(20),
      via: MessageVia.GATEWAY,
    });
    expect(verifyChatMessage(message, AT_SITE)).toEqual({ ok: true, message, identity: null });
  });
});

describe('the name', () => {
  it.each(['Zoë', 'Đorđe', 'Ζωή', 'Алиса', '李雷', 'سارا', 'אורי', 'नमस्ते', 'ok 👍🏽'])('accepts %s', (name) => {
    const { message } = createChatMessage(TEST_KEY, {
      topic: 'chat-x',
      type: MessageType.TEXT,
      text: 'hi',
      name,
      via: MessageVia.GATEWAY,
    });
    expect(verifyChatMessage(message, AT_SITE)).toMatchObject({ ok: true });
  });

  it.each([
    ['a family emoji joined by zero width joiners', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'],
    ['a Persian name with a zero width non-joiner', 'می\u200cخواهم'],
    ['a Devanagari conjunct with a zero width joiner', 'क्\u200dष'],
  ])('accepts %s', (_, name) => {
    const { message } = createChatMessage(TEST_KEY, {
      topic: 'chat-x',
      type: MessageType.TEXT,
      text: 'hi',
      name,
      via: MessageVia.GATEWAY,
    });
    expect(verifyChatMessage(message, AT_SITE)).toMatchObject({ ok: true });
  });

  it('refuses a format character before signing', () => {
    expect(() =>
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.TEXT,
        text: 'hi',
        name: 'evil\u202egnp.exe',
        via: MessageVia.GATEWAY,
      }),
    ).toThrow(ChatMessageError);
  });
});

describe('displayNameProblem', () => {
  it.each([
    'Zoë',
    'ok 👍🏽',
    'می\u200cخواهم',
    '\u{1F468}\u200d\u{1F469}',
    'a'.repeat(20),
    '👍'.repeat(20),
    'love \u2764\ufe0f',
    'Kenneth',
    'Seth',
    'Ethan',
    'J.Ethan',
  ])('finds no problem with %s', (name) => {
    expect(displayNameProblem(name)).toBeNull();
  });

  it.each([
    ['an empty name', '', 'length'],
    ['21 characters', 'a'.repeat(21), 'length'],
    ['21 emoji', '👍'.repeat(21), 'length'],
    ['a right-to-left override', 'evil\u202egnp.exe', 'invisible'],
    ['a zero width space', 'a\u200bb', 'invisible'],
    ['a control character', 'a\u0007b', 'invisible'],
    ['an ENS name', 'alice.eth', 'ens-like'],
    ['an uppercase ENS name', 'Alice.ETH', 'ens-like'],
    ['an ENS name with a trailing space', 'alice.eth ', 'ens-like'],
    ['a fullwidth ENS name', '\uff36\uff29\uff34\uff21\uff2c\uff29\uff2b\uff0e\uff25\uff34\uff28', 'ens-like'],
    ['an ENS name with the one dot leader', 'alice\u2024eth', 'ens-like'],
    ['an ENS name with the small full stop', 'alice\ufe52eth', 'ens-like'],
    ['an ENS name with the ideographic full stop', 'alice\u3002eth', 'ens-like'],
    ['an ENS name with the halfwidth ideographic full stop', 'alice\uff61eth', 'ens-like'],
    ['an ENS name ending in a joiner', 'alice.eth\u200d', 'ens-like'],
    ['an ENS name with a non-joiner inside', 'alice.e\u200cth', 'ens-like'],
    ['the bare suffix', '.eth', 'ens-like'],
    ['an ENS name with a trailing dot', 'alice.eth.', 'ens-like'],
    ['an ENS name with several trailing dots', 'alice.eth...', 'ens-like'],
    ['an ENS name with a trailing ideographic full stop', 'alice.eth\u3002', 'ens-like'],
    ['an ENS name with a Cyrillic e', 'alice.\u0435th', 'ens-like'],
    ['an ENS name with a Cyrillic capital E', 'alice.\u0415TH', 'ens-like'],
    ['an ENS name with a Cyrillic capital T', 'alice.e\u0422h', 'ens-like'],
    ['an ENS name with a Cyrillic shha', 'alice.et\u04bb', 'ens-like'],
    ['an ENS name with an Armenian ho', 'alice.et\u0570', 'ens-like'],
    ['an ENS name with Greek capitals', 'alice.\u0395\u03a4\u0397', 'ens-like'],
    ['an ENS name with several confusable letters', 'alice.\u0435\u0422\u04bb.', 'ens-like'],
    ['a braille blank', 'a\u2800b', 'invisible'],
    ['a Hangul choseong filler', 'a\u115fb', 'invisible'],
    ['a Hangul jungseong filler', 'a\u1160b', 'invisible'],
    ['a Hangul filler', 'a\u3164b', 'invisible'],
    ['a halfwidth Hangul filler', 'a\uffa0b', 'invisible'],
    ['a combining grapheme joiner', 'a\u034fb', 'invisible'],
    ['a Khmer inherent aq', 'a\u17b4b', 'invisible'],
    ['a Khmer inherent aa', 'a\u17b5b', 'invisible'],
    ['an ENS name ending in a braille blank', 'alice.eth\u2800', 'invisible'],
    ['an ENS name ending in a Hangul filler', 'alice.eth\u3164', 'invisible'],
    ['an ENS name ending in a Hangul jungseong filler', 'alice.eth\u1160', 'invisible'],
    ['an ENS name ending in a Hangul choseong filler', 'alice.eth\u115f', 'invisible'],
    ['an ENS name ending in a combining grapheme joiner', 'alice.eth\u034f', 'invisible'],
    ['an ENS name ending in a Khmer inherent aq', 'alice.eth\u17b4', 'invisible'],
    ['an ENS name ending in variation selector 16', 'alice.eth\ufe0f', 'ens-like'],
    ['an ENS name with variation selector 16 inside', 'alice.e\ufe0fth', 'ens-like'],
    ['an ENS name ending in a Mongolian variation selector', 'alice.eth\u180b', 'ens-like'],
    ['an ENS name ending in variation selector 17', 'alice.eth\u{e0100}', 'ens-like'],
    ['an ENS name ending in a combining dot below', 'alice.et\u0068\u0323', 'ens-like'],
    ['an ENS name ending in a precomposed h with dot below', 'alice.et\u1e25', 'ens-like'],
    ['an ENS name ending in a no-break space', 'alice.eth\u00a0', 'ens-like'],
    ['an ENS name ending in an ogham space', 'alice.eth\u1680', 'ens-like'],
    ['an ENS name ending in an ideographic space', 'alice.eth\u3000', 'ens-like'],
    ['an Arabic-Indic zero for the dot', 'alice\u0660eth', 'ens-like'],
    ['an extended Arabic-Indic zero for the dot', 'alice\u06f0eth', 'ens-like'],
    ['a Syriac supralinear full stop for the dot', 'alice\u0701eth', 'ens-like'],
    ['a Syriac sublinear full stop for the dot', 'alice\u0702eth', 'ens-like'],
    ['a Lisu tone mark for the dot', 'alice\ua4f8eth', 'ens-like'],
    ['a Vai full stop for the dot', 'alice\ua60eeth', 'ens-like'],
    ['a Kharoshthi dot for the dot', 'alice\u{10a50}eth', 'ens-like'],
    ['a musical augmentation dot for the dot', 'alice\u{1d16d}eth', 'ens-like'],
    ['a dot that is not the last label', 'J.Eth', 'ens-like'],
    ['a Meetei Mayek lum iyek for the dot', 'alice\uabeceth', 'ens-like'],
    ['an Indic Siyaq one half for the dot', 'alice\u{1ecae}eth', 'ens-like'],
    ['an ENS name ending in a Syriac full stop', 'alice.eth\u0701', 'ens-like'],
    ['an ENS name with a Cyrillic en for the h', 'alice.et\u043d', 'ens-like'],
    ['an ENS name with a Cyrillic te for the t', 'alice.e\u0442h', 'ens-like'],
  ])('says %s is a %s problem', (_, name, problem) => {
    expect(displayNameProblem(name)).toBe(problem);
  });

  it.each([
    'eth',
    'ethan',
    'alice.ethereum',
    'alice.eth!',
    'alice.eth.x',
    'alice.\u0435tx',
    'a.b.',
    'Beth',
    'Dr. Seth',
    'E.T.H.',
    'misha.\u0435\u0442\u0445',
    'alice.xyz',
    'alice eth',
    'alice-eth',
    'alice_eth',
    'alice\u00b7eth',
    'alice.eth\u00b7',
    'alice\ua78feth',
  ])('lets %s through', (name) => {
    expect(displayNameProblem(name)).toBeNull();
  });

  it('refuses an ENS-like name before signing', () => {
    expect(() =>
      createChatMessage(TEST_KEY, {
        topic: 'chat-x',
        type: MessageType.TEXT,
        text: 'hi',
        name: 'Alice.ETH',
        via: MessageVia.GATEWAY,
      }),
    ).toThrow(ChatMessageError);
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
      idb: CHAT_BINDING,
    });
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe('the wire check', () => {
  const message = TEXT_VECTOR.message;

  it('refuses a payload over the byte cap before reading it', () => {
    const payload = new Uint8Array(MAX_MESSAGE_BYTES + 1).fill(0x20);
    expect(parseChatMessage(payload, AT_SITE)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('accepts a payload of exactly the byte cap, padded with JSON whitespace', () => {
    const bytes = encodeChatMessage(message);
    const payload = new Uint8Array(MAX_MESSAGE_BYTES).fill(0x20);
    payload.set(bytes);
    expect(parseChatMessage(payload, AT_SITE)).toEqual({ ok: true, message, identity: null });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(parseChatMessage(new Uint8Array([0x7b, 0xff, 0x7d]), AT_SITE)).toMatchObject({
      ok: false,
      reason: 'not-utf8',
    });
  });

  it('refuses text that is not JSON', () => {
    expect(parseChatMessage(encoder.encode('{"v":9'), AT_SITE)).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('refuses the empty payload', () => {
    expect(parseChatMessage(new Uint8Array(), AT_SITE)).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('hands the origin to the binding check', () => {
    const payload = encodeChatMessage(BOUND_VECTOR.message);
    expect(parseChatMessage(payload, { origins: ['https://other.example'] })).toMatchObject({
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

  it('is refused in its high s spelling, which recovers the same signer, so one message has one signature', () => {
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${message.sig.slice(64, 128)}`);
    const highS = (order - s).toString(16).padStart(64, '0');
    const flippedV = message.sig.slice(128) === '1b' ? '1c' : '1b';
    const sig = `${message.sig.slice(0, 64)}${highS}${flippedV}`;
    const signer = new Signature(sig).recoverPublicKey(signedBytes(message)).address().toHex();
    expect(signer).toBe(message.addr);
    expect(hasValidSignature({ ...message, sig })).toBe(false);
    expect(verifyChatMessage({ ...message, sig }, AT_SITE)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('is refused with a recovery byte other than 27 or 28, which bee-js reads as 28 and so recovers the signer', () => {
    // The bound vector is the one whose recovery byte is 28.
    const signedAt28 = BOUND_VECTOR.message;
    expect(signedAt28.sig.slice(128)).toBe('1c');
    const sig = `${signedAt28.sig.slice(0, 128)}1d`;
    expect(new Signature(sig).recoverPublicKey(signedBytes(signedAt28)).address().toHex()).toBe(signedAt28.addr);
    expect(hasValidSignature({ ...signedAt28, sig })).toBe(false);
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
      type: MessageType.TEXT,
      text: 'hi',
      name: 'me',
      via: MessageVia.GATEWAY,
    });
    expect(message.addr).toBe(TEST_ADDR);
    expect(message.id).toMatch(/^[0-9a-f]{32}$/);
    expect(message.ts).toBeGreaterThanOrEqual(before);
    expect(message.target).toBe('');
    expect('own' in message).toBe(false);
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
