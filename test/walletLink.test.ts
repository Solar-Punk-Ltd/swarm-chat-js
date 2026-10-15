import { PrivateKey } from '@ethersphere/bee-js';
import { signMessage } from '@ethersphere/core-sdk/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ChatMessageError,
  MAX_MESSAGE_BYTES,
  MAX_WALLET_LINK_CHARACTERS,
  MessageType,
  MessageVia,
  WALLET_LINK_TITLE,
  checkWalletLink,
  createChatMessage,
  parseChatMessage,
  signedBytes,
  verifyChatMessage,
  type ChatMessage,
  type ChatMessageDraft,
  type UnsignedChatMessage,
  type WalletLink,
} from '../src/message';
import { AT_SITE, BOUND_SITE, CHAT_BINDING, chatKeyFor, FORK_ACCOUNT, FORK_ACCOUNT_KEY } from './bindingVectors';
import {
  LINK_WALLET,
  LINK_WALLET_KEY,
  OTHER_ACCOUNT_WALLET_LINK,
  OTHER_LINK_ACCOUNT,
  WALLET_LINK,
  WALLET_LINK_FLIPPED_V,
} from './walletLinkVectors';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** personal_sign over `text` with `key`, spelled as the fork spells a signature. */
function personalSign(text: string, key: string): string {
  const body = encoder.encode(text);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const whole = new Uint8Array(prefix.length + body.length);
  whole.set(prefix);
  whole.set(body, prefix.length);
  const [r, s, v] = signMessage(whole, BigInt(`0x${key}`));
  const hex = (value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, '0');
  return `0x${hex(r, 32)}${hex(s, 32)}${hex(v, 1)}`;
}

/** A link of `msg` signed by both keys, as the fork would sign whatever text it was given. */
function signedLink(msg: string): WalletLink {
  return { msg, wsig: personalSign(msg, LINK_WALLET_KEY), asig: personalSign(msg, FORK_ACCOUNT_KEY) };
}

const lines = WALLET_LINK.msg.split('\n');
const withLine = (index: number, text: string) => lines.map((line, at) => (at === index ? text : line)).join('\n');

describe('the fork wallet link', () => {
  it('names the format in its first line', () => {
    expect(lines[0]).toBe(WALLET_LINK_TITLE);
  });

  it.each([
    ['its wallet signature in v 28', WALLET_LINK],
    ['its wallet signature in v 27', WALLET_LINK_FLIPPED_V],
  ])('passes for its account with %s, naming the wallet', (_label, link) => {
    expect(checkWalletLink(link, FORK_ACCOUNT)).toEqual({
      ok: true,
      wallet: LINK_WALLET,
      account: FORK_ACCOUNT,
      date: link.msg.split('\n')[3]!.slice('Date: '.length),
    });
  });

  it('carries the signatures personal_sign makes with each key', () => {
    expect(personalSign(WALLET_LINK.msg, LINK_WALLET_KEY)).toBe(WALLET_LINK.wsig);
    expect(personalSign(WALLET_LINK.msg, FORK_ACCOUNT_KEY)).toBe(WALLET_LINK.asig);
  });
});

describe('checkWalletLink refuses', () => {
  it('a message changed after signing', () => {
    const tampered = { ...WALLET_LINK, msg: WALLET_LINK.msg.replace('12:00:00', '12:00:01') };
    expect(checkWalletLink(tampered, FORK_ACCOUNT).ok).toBe(false);
  });

  it('a wallet signature another key made', () => {
    const link = { ...WALLET_LINK, wsig: personalSign(WALLET_LINK.msg, '55'.repeat(32)) };
    expect(checkWalletLink(link, FORK_ACCOUNT)).toEqual({
      ok: false,
      detail: 'the wallet signature does not recover the wallet the link names',
    });
  });

  it('an account signature another key made', () => {
    const link = { ...WALLET_LINK, asig: personalSign(WALLET_LINK.msg, '55'.repeat(32)) };
    expect(checkWalletLink(link, FORK_ACCOUNT)).toEqual({
      ok: false,
      detail: 'the account signature does not recover the account the link names',
    });
  });

  it('the two signatures swapped', () => {
    const link = { ...WALLET_LINK, wsig: WALLET_LINK.asig, asig: WALLET_LINK.wsig };
    expect(checkWalletLink(link, FORK_ACCOUNT).ok).toBe(false);
  });

  it("a valid link of another account than the binding's", () => {
    expect(checkWalletLink(OTHER_ACCOUNT_WALLET_LINK, OTHER_LINK_ACCOUNT).ok).toBe(true);
    expect(checkWalletLink(OTHER_ACCOUNT_WALLET_LINK, FORK_ACCOUNT)).toEqual({
      ok: false,
      detail: `the wallet link is for ${OTHER_LINK_ACCOUNT}, not the binding's account ${FORK_ACCOUNT}`,
    });
  });

  it.each([
    ['another version', withLine(0, 'Swarm ID wallet link v2')],
    ["the chat binding's title", withLine(0, 'Swarm ID chat binding v1')],
    ['a trailing newline', `${WALLET_LINK.msg}\n`],
    ['a missing line', lines.slice(0, 3).join('\n')],
    ['an extra line', `${WALLET_LINK.msg}\nNote: hi`],
    ['CRLF line ends', lines.join('\r\n')],
    ['the wallet line first', [lines[0], lines[2], lines[1], lines[3]].join('\n')],
    ['an account in upper case', withLine(1, `Account: 0x${FORK_ACCOUNT.slice(2).toUpperCase()}`)],
    ['a wallet in upper case', withLine(2, `Wallet: 0x${LINK_WALLET.slice(2).toUpperCase()}`)],
    ['a wallet without 0x', withLine(2, `Wallet: ${LINK_WALLET.slice(2)}`)],
    ['a date without milliseconds', withLine(3, 'Date: 2026-10-15T12:00:00Z')],
    ['a date that does not exist', withLine(3, 'Date: 2026-02-30T12:00:00.000Z')],
  ])('a message with %s, even signed by both keys', (_label, msg) => {
    expect(checkWalletLink(signedLink(msg), FORK_ACCOUNT).ok).toBe(false);
  });

  // A smart-contract wallet answers personal_sign with what its contract validates, often longer than 65 bytes, and
  // nothing in it recovers the wallet's address.
  it("a smart-contract wallet's signature that is not 65 bytes", () => {
    const link = { ...WALLET_LINK, wsig: `0x${'12'.repeat(32)}${'00'.repeat(96)}${'6492'.repeat(16)}` };
    expect(checkWalletLink(link, FORK_ACCOUNT)).toEqual({
      ok: false,
      detail: 'not a wallet link of a text and two 65 byte signatures',
    });
  });

  it('a signature spelled in upper case, so one link has one spelling inside the signed bytes', () => {
    const link = { ...WALLET_LINK, wsig: `0x${WALLET_LINK.wsig.slice(2).toUpperCase()}` };
    expect(checkWalletLink(link, FORK_ACCOUNT).ok).toBe(false);
  });

  it('a signature with v 0 or 1, or in its high s spelling', () => {
    const sig = WALLET_LINK.wsig;
    const v = parseInt(sig.slice(130), 16);
    const lowV = { ...WALLET_LINK, wsig: `${sig.slice(0, 130)}0${v - 27}` };
    expect(checkWalletLink(lowV, FORK_ACCOUNT).ok).toBe(false);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const highS = `${sig.slice(0, 66)}${(SECP256K1_ORDER - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
    expect(checkWalletLink({ ...WALLET_LINK, wsig: highS }, FORK_ACCOUNT).ok).toBe(false);
  });

  it('a link with a field it does not name, or one longer than the fork stores', () => {
    expect(checkWalletLink({ ...WALLET_LINK, note: 'x' } as WalletLink, FORK_ACCOUNT).ok).toBe(false);
    const long = { ...WALLET_LINK, msg: 'x'.repeat(MAX_WALLET_LINK_CHARACTERS + 1) };
    expect(checkWalletLink(long, FORK_ACCOUNT).ok).toBe(false);
  });
});

describe('a message carrying a wallet link', () => {
  let boundKey: string;

  beforeAll(async () => {
    boundKey = await chatKeyFor(BOUND_SITE);
  });

  const draft = (overrides: Partial<ChatMessageDraft> = {}): ChatMessageDraft => ({
    topic: 'chat-devcon-main',
    type: MessageType.TEXT,
    text: 'hello',
    name: 'tester',
    ts: 1760529600000,
    via: MessageVia.GATEWAY,
    idb: CHAT_BINDING,
    wl: WALLET_LINK,
    ...overrides,
  });

  /** Signs `unsigned` by hand, whatever it carries, the way a forger would reach the verifier. */
  function forged(unsigned: UnsignedChatMessage): ChatMessage {
    return { ...unsigned, sig: new PrivateKey(boundKey).sign(signedBytes(unsigned)).toHex() } as ChatMessage;
  }

  it('passes beside its binding, and the identity names the checked wallet', () => {
    const { message, bytes } = createChatMessage(boundKey, draft());
    const check = parseChatMessage(bytes, AT_SITE);
    expect(check).toEqual({
      ok: true,
      message,
      identity: { account: FORK_ACCOUNT, site: BOUND_SITE, date: '2026-10-14T12:00:00.000Z', wallet: LINK_WALLET },
    });
  });

  it('gives a bound message without one an identity with no wallet', () => {
    const { bytes } = createChatMessage(boundKey, draft({ wl: undefined }));
    const check = parseChatMessage(bytes, AT_SITE);
    expect(check.ok && check.identity).toEqual({
      account: FORK_ACCOUNT,
      site: BOUND_SITE,
      date: '2026-10-14T12:00:00.000Z',
    });
  });

  it('is written after the binding and before the signature', () => {
    const { bytes } = createChatMessage(boundKey, draft());
    expect(Object.keys(JSON.parse(decoder.decode(bytes)))).toEqual([
      'v',
      'topic',
      'id',
      'type',
      'target',
      'text',
      'name',
      'addr',
      'ts',
      'via',
      'own',
      'idb',
      'wl',
      'sig',
    ]);
  });

  it('is signed: its three fields end the signed bytes, and a message without one keeps the bytes it had', () => {
    const { message } = createChatMessage(boundKey, draft());
    const signed = JSON.parse(decoder.decode(signedBytes(message))) as unknown[];
    expect(signed.slice(-5)).toEqual([
      CHAT_BINDING.msg,
      CHAT_BINDING.sig,
      WALLET_LINK.msg,
      WALLET_LINK.wsig,
      WALLET_LINK.asig,
    ]);
    const { wl: _wl, ...withoutLink } = message;
    expect(JSON.parse(decoder.decode(signedBytes(withoutLink))) as unknown[]).toHaveLength(13);
  });

  it('is refused on its signature when it is taken off, or put on a message signed without it', () => {
    const { message } = createChatMessage(boundKey, draft());
    const { wl: _wl, ...stripped } = message;
    expect(verifyChatMessage(stripped, AT_SITE)).toMatchObject({ ok: false, reason: 'signature' });
    const { message: plain } = createChatMessage(boundKey, draft({ wl: undefined }));
    expect(verifyChatMessage({ ...plain, wl: WALLET_LINK }, AT_SITE)).toMatchObject({ ok: false, reason: 'signature' });
  });

  it('is refused on its shape without a binding, by the sender and by the verifier', () => {
    expect(() => createChatMessage(boundKey, draft({ idb: undefined }))).toThrow(/wallet link/);
    const { idb: _idb, sig: _sig, ...rest } = createChatMessage(boundKey, draft()).message;
    expect(verifyChatMessage(forged(rest), AT_SITE)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it("is refused as the binding when it is another account's", () => {
    expect(() => createChatMessage(boundKey, draft({ wl: OTHER_ACCOUNT_WALLET_LINK }))).toThrow(ChatMessageError);
    const { sig: _sig, ...unsigned } = createChatMessage(boundKey, draft({ wl: undefined })).message;
    const check = verifyChatMessage(forged({ ...unsigned, wl: OTHER_ACCOUNT_WALLET_LINK }), AT_SITE);
    expect(check).toEqual({
      ok: false,
      reason: 'binding',
      detail: `wallet link: the wallet link is for ${OTHER_LINK_ACCOUNT}, not the binding's account ${FORK_ACCOUNT}`,
    });
  });

  it('is refused as the binding when its text was changed after signing', () => {
    const tampered = { ...WALLET_LINK, msg: WALLET_LINK.msg.replace('12:00:00', '12:00:01') };
    const { sig: _sig, ...unsigned } = createChatMessage(boundKey, draft({ wl: undefined })).message;
    expect(verifyChatMessage(forged({ ...unsigned, wl: tampered }), AT_SITE)).toMatchObject({
      ok: false,
      reason: 'binding',
    });
  });

  it('counts toward the byte cap', () => {
    const without = createChatMessage(boundKey, draft({ wl: undefined })).bytes.byteLength;
    const withLink = createChatMessage(boundKey, draft()).bytes.byteLength;
    expect(withLink - without).toBe(encoder.encode(`,"wl":${JSON.stringify(WALLET_LINK)}`).byteLength);
  });

  it('holds a 500 character text of two byte characters with a binding and a wallet link, at every other cap', () => {
    const { bytes } = createChatMessage(boundKey, {
      topic: 't'.repeat(128),
      type: MessageType.THREAD,
      target: 'a1'.repeat(16),
      text: 'ü'.repeat(500),
      name: 'n'.repeat(20),
      ts: Number.MAX_SAFE_INTEGER,
      via: MessageVia.OWN_STAMP,
      own: true,
      idb: CHAT_BINDING,
      wl: WALLET_LINK,
    });
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('refuses a draft whose payload the wallet link takes over the byte cap', () => {
    // A control character is written as six bytes of JSON escape, so a text of them fills the payload in steps of six.
    const escapedBytes = 6;
    const oneCharacter = createChatMessage(boundKey, draft({ wl: undefined, text: 'a' })).bytes.byteLength;
    const count = Math.floor((MAX_MESSAGE_BYTES - (oneCharacter - 1)) / escapedBytes);
    const text = '\u0001'.repeat(count);
    expect(createChatMessage(boundKey, draft({ wl: undefined, text })).bytes.byteLength).toBeLessThanOrEqual(
      MAX_MESSAGE_BYTES,
    );
    expect(() => createChatMessage(boundKey, draft({ text }))).toThrow(/too-large/);
  });
});
