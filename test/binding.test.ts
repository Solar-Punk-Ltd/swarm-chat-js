import { PrivateKey } from '@ethersphere/bee-js';
import { publicKeyToAddress, recoverPublicKey, signMessage } from '@ethersphere/core-sdk/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CHAT_BINDING_TITLE,
  MessageType,
  MessageVia,
  signedBytes,
  verifyChatMessage,
  type ChatBinding,
  type ChatMessage,
  type UnsignedChatMessage,
} from '../src/message';
import {
  BOUND_CHAT_ADDR,
  BOUND_SITE,
  CHAT_BINDING,
  CHAT_BINDING_V27,
  chatKeyFor,
  FORK_ACCOUNT,
  FORK_ACCOUNT_KEY,
  LOCAL_CHAT_ADDR,
  LOCAL_SITE,
  LOCAL_SITE_BINDING,
  OTHER_CHAT_ADDR,
  OTHER_SITE,
  OTHER_SITE_BINDING,
} from './bindingVectors';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const encoder = new TextEncoder();

let boundKey: string;
let localKey: string;

beforeAll(async () => {
  boundKey = await chatKeyFor(BOUND_SITE);
  localKey = await chatKeyFor(LOCAL_SITE);
});

/**
 * Signs a message carrying `idb` with `key`, whatever the binding says, the way a forger would. createChatMessage
 * refuses a binding that does not name its key, so these are built by hand to reach the verifier.
 */
function signedWith(key: string, idb: ChatBinding | undefined): ChatMessage {
  const unsigned: UnsignedChatMessage = {
    v: 8,
    topic: 'chat-devcon-main',
    id: 'f7'.repeat(16),
    type: MessageType.TEXT,
    target: '',
    text: 'hello',
    name: 'tester',
    addr: new PrivateKey(key).publicKey().address().toHex(),
    ts: 1759140004000,
    via: MessageVia.OWN_STAMP,
    own: false,
    ...(idb ? { idb } : {}),
  };
  return { ...unsigned, sig: new PrivateKey(key).sign(signedBytes(unsigned)).toHex() };
}

function withLines(lines: string[]): ChatBinding {
  return { msg: lines.join('\n'), sig: CHAT_BINDING.sig };
}

const BOUND_LINES = CHAT_BINDING.msg.split('\n');

describe('the fork-compatible binding vector', () => {
  /** EIP-191 personal_sign, as the fork's `personalMessageHash` builds it: the prefix, the byte length, the text. */
  function personalMessage(text: string): Uint8Array {
    const body = encoder.encode(text);
    const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
    const whole = new Uint8Array(prefix.length + body.length);
    whole.set(prefix);
    whole.set(body, prefix.length);
    return whole;
  }

  it('is the signature personal_sign makes over the four lines with the account key', () => {
    const [r, s, v] = signMessage(personalMessage(CHAT_BINDING.msg), BigInt(`0x${FORK_ACCOUNT_KEY}`));
    const hex = (value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, '0');
    expect(`0x${hex(r, 32)}${hex(s, 32)}${hex(v, 1)}`).toBe(CHAT_BINDING.sig);
  });

  it.each([
    ['28', CHAT_BINDING],
    ['27', CHAT_BINDING_V27],
  ])('recovers the account the way the fork recovers it, with v %s and a low s', (v, binding) => {
    const sig = binding.sig.slice(2);
    const r = BigInt(`0x${sig.slice(0, 64)}`);
    const s = BigInt(`0x${sig.slice(64, 128)}`);
    expect(parseInt(sig.slice(128), 16)).toBe(Number(v));
    expect(s <= SECP256K1_ORDER / 2n).toBe(true);
    const point = recoverPublicKey(personalMessage(binding.msg), r, s, BigInt(v) as 27n | 28n);
    const account = Array.from(publicKeyToAddress(point), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(`0x${account}`).toBe(FORK_ACCOUNT);
  });

  it('names the chat address of the key the fork derives for the site', () => {
    expect(new PrivateKey(boundKey).publicKey().address().toHex()).toBe(BOUND_CHAT_ADDR);
    expect(BOUND_LINES).toEqual([
      CHAT_BINDING_TITLE,
      `Site: ${BOUND_SITE}`,
      `Chat address: 0x${BOUND_CHAT_ADDR}`,
      'Date: 2026-10-14T12:00:00.000Z',
    ]);
  });

  it.each([
    ['28', CHAT_BINDING, '2026-10-14T12:00:00.000Z'],
    ['27', CHAT_BINDING_V27, '2026-10-14T12:04:00.000Z'],
  ])('verifies here as the fork verified it, with v %s', (_v, binding, date) => {
    const message = signedWith(boundKey, binding);
    expect(verifyChatMessage(message, { origin: BOUND_SITE })).toEqual({
      ok: true,
      message,
      identity: { account: FORK_ACCOUNT, site: BOUND_SITE, date },
    });
  });
});

describe('a message with a binding', () => {
  it('is refused, never shown as a guest, when the binding names another chat address', () => {
    expect(OTHER_CHAT_ADDR).not.toBe(BOUND_CHAT_ADDR);
    expect(verifyChatMessage(signedWith(boundKey, OTHER_SITE_BINDING))).toMatchObject({
      ok: false,
      reason: 'binding',
    });
  });

  it('is refused when an origin is given and the binding is for another site', () => {
    const message = signedWith(boundKey, CHAT_BINDING);
    expect(verifyChatMessage(message, { origin: OTHER_SITE })).toMatchObject({ ok: false, reason: 'binding' });
    expect(verifyChatMessage(message, { origin: `${BOUND_SITE}/` })).toMatchObject({ ok: false, reason: 'binding' });
  });

  it('is accepted for any site when no origin is given, and says which site it was', () => {
    expect(verifyChatMessage(signedWith(boundKey, CHAT_BINDING))).toMatchObject({
      ok: true,
      identity: { site: BOUND_SITE },
    });
  });

  it('is refused for a local http site unless local http is allowed, as the fork refuses it', () => {
    expect(new PrivateKey(localKey).publicKey().address().toHex()).toBe(LOCAL_CHAT_ADDR);
    const message = signedWith(localKey, LOCAL_SITE_BINDING);
    expect(verifyChatMessage(message)).toMatchObject({ ok: false, reason: 'binding' });
    expect(verifyChatMessage(message, { allowLocalHttp: true, origin: LOCAL_SITE })).toMatchObject({
      ok: true,
      identity: { account: FORK_ACCOUNT, site: LOCAL_SITE },
    });
  });

  it('is refused when its signature has a high s, the second spelling of the same signature', () => {
    const sig = CHAT_BINDING.sig.slice(2);
    const s = BigInt(`0x${sig.slice(64, 128)}`);
    const highS = (SECP256K1_ORDER - s).toString(16).padStart(64, '0');
    const flippedV = sig.slice(128) === '1b' ? '1c' : '1b';
    const binding = { msg: CHAT_BINDING.msg, sig: `0x${sig.slice(0, 64)}${highS}${flippedV}` };
    expect(verifyChatMessage(signedWith(boundKey, binding))).toMatchObject({ ok: false, reason: 'binding' });
  });

  it.each(['00', '01', '1d', 'ff'])('is refused when its recovery byte is %s', (v) => {
    const binding = { msg: CHAT_BINDING.msg, sig: `${CHAT_BINDING.sig.slice(0, -2)}${v}` };
    expect(verifyChatMessage(signedWith(boundKey, binding))).toMatchObject({ ok: false, reason: 'binding' });
  });

  it('is refused, not thrown, when its r and s are zero', () => {
    const binding = { msg: CHAT_BINDING.msg, sig: `0x${'0'.repeat(128)}1b` };
    expect(verifyChatMessage(signedWith(boundKey, binding))).toMatchObject({ ok: false, reason: 'binding' });
  });

  const [title, siteLine, chatLine, dateLine] = BOUND_LINES as [string, string, string, string];

  it.each<[string, ChatBinding]>([
    ['three lines', withLines([title, siteLine, chatLine])],
    ['a trailing newline', withLines([title, siteLine, chatLine, dateLine, ''])],
    ['another title', withLines(['Swarm ID chat binding v2', siteLine, chatLine, dateLine])],
    ['lines out of order', withLines([title, chatLine, siteLine, dateLine])],
    ['a site with a path', withLines([title, `${siteLine}/chat`, chatLine, dateLine])],
    ['a site with a trailing slash', withLines([title, `${siteLine}/`, chatLine, dateLine])],
    ['a site in capitals', withLines([title, 'Site: https://EXAMPLE.com', chatLine, dateLine])],
    ['a site with the default port', withLines([title, `${siteLine}:443`, chatLine, dateLine])],
    ['a site over plain http', withLines([title, 'Site: http://example.com', chatLine, dateLine])],
    ['a chat address without 0x', withLines([title, siteLine, `Chat address: ${BOUND_CHAT_ADDR}`, dateLine])],
    [
      'a chat address in capitals',
      withLines([title, siteLine, `Chat address: 0x${BOUND_CHAT_ADDR.toUpperCase()}`, dateLine]),
    ],
    ['a date without milliseconds', withLines([title, siteLine, chatLine, 'Date: 2026-10-14T12:00:00Z'])],
    ['a date that does not exist', withLines([title, siteLine, chatLine, 'Date: 2026-02-30T12:00:00.000Z'])],
    ['a Windows line ending', { msg: BOUND_LINES.join('\r\n'), sig: CHAT_BINDING.sig }],
  ])('is refused when the binding text has %s', (_case, binding) => {
    expect(verifyChatMessage(signedWith(boundKey, binding))).toMatchObject({ ok: false, reason: 'binding' });
  });
});

describe('a message without a binding', () => {
  it('is accepted as a guest, with no identity, whatever origin is given', () => {
    const message = signedWith(boundKey, undefined);
    expect(verifyChatMessage(message, { origin: OTHER_SITE })).toEqual({ ok: true, message, identity: null });
  });
});
