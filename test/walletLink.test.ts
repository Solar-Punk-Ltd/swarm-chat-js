import { signMessage } from '@ethersphere/core-sdk/crypto';
import { describe, expect, it } from 'vitest';

import { MAX_WALLET_LINK_CHARACTERS, WALLET_LINK_TITLE, checkWalletLink, type WalletLink } from '../src/message';
import { FORK_ACCOUNT, FORK_ACCOUNT_KEY } from './bindingVectors';
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
