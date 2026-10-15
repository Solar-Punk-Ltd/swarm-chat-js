import { z } from 'zod';

import { isCanonicalDate, recoverPersonalSigner } from './personalSign.js';

/**
 * The Swarm ID wallet link: the statement, signed by an account's wallet and countersigned by the account's own key,
 * that the two belong to the same person, which lets a reader show the wallet's ENS name. The Swarm ID fork makes it
 * while the person has "Show my ENS name on sites" on, and its canonical description is `docs/Wallet-Link.md` in the
 * fork (solarpunk-id), with `verifyWalletLink` in its `lib/src/utils/wallet-link.ts`. This module reads it exactly as
 * that function does, without importing the fork: the same five lines, the second of them read exactly, and both
 * EIP-191 personal_sign signatures with v 27 or 28 and a low s. It looks nothing up: a reader takes the checked wallet to its own ENS lookup.
 */

/** The first line, which also versions the wallet link format. */
export const WALLET_LINK_TITLE = 'Swarm ID wallet link v1';

/** The second line, what the wallet's owner agrees to, which a wallet shows them before they sign. */
export const WALLET_LINK_STATEMENT =
  'I link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.';

/** The fork's own bound on a wallet link's text, which is 258 characters in the format it writes. */
export const MAX_WALLET_LINK_CHARACTERS = 320;

const ACCOUNT_PREFIX = 'Account: ';
const WALLET_PREFIX = 'Wallet: ';
const DATE_PREFIX = 'Date: ';
const LINE_SEPARATOR = '\n';
const LINE_COUNT = 5;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const SIGNATURE = z.string().regex(/^0x[0-9a-f]{130}$/, 'expected 0x and 130 lowercase hex characters');

/**
 * A wallet link as a message carries it: the fork's `{ message, walletSignature, accountSignature }` as `msg`, `wsig`
 * and `asig`. Each signature is spelled as the fork writes it, `0x` and 130 lowercase hex characters of r, s and v, so
 * one link has one spelling inside the signed bytes.
 */
export const walletLinkSchema = z.strictObject({
  msg: z.string().max(MAX_WALLET_LINK_CHARACTERS),
  wsig: SIGNATURE,
  asig: SIGNATURE,
});

export type WalletLink = z.infer<typeof walletLinkSchema>;

export type WalletLinkCheck =
  | {
      ok: true;
      /** The wallet both signatures were checked for, `0x` and 40 lowercase hex characters. */
      wallet: string;
      /** The account the link names, which is the one it was checked against. */
      account: string;
      /** When the account says it signed, ISO 8601 UTC. */
      date: string;
    }
  | { ok: false; detail: string };

function afterPrefix(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/**
 * Reads a wallet link for `account` (`0x` and 40 lowercase hex characters), the account a verified chat binding
 * named. Refuses every text but the five lines the fork writes, its statement included, a wallet signature that does not recover the wallet
 * the link names, an account signature that does not recover the account it names, and a link naming any other
 * account. Never throws.
 */
export function checkWalletLink(link: WalletLink, account: string): WalletLinkCheck {
  if (!walletLinkSchema.safeParse(link).success) {
    return { ok: false, detail: 'not a wallet link of a text and two 65 byte signatures' };
  }
  const lines = link.msg.split(LINE_SEPARATOR);
  if (lines.length !== LINE_COUNT || lines[0] !== WALLET_LINK_TITLE) {
    return { ok: false, detail: `not the ${LINE_COUNT} lines of a ${WALLET_LINK_TITLE}` };
  }
  if (lines[1] !== WALLET_LINK_STATEMENT) {
    return { ok: false, detail: `the wallet link's second line is not the ${WALLET_LINK_TITLE} statement` };
  }
  const named = afterPrefix(lines[2]!, ACCOUNT_PREFIX);
  const wallet = afterPrefix(lines[3]!, WALLET_PREFIX);
  const date = afterPrefix(lines[4]!, DATE_PREFIX);
  if (named === null || !ADDRESS_PATTERN.test(named)) {
    return { ok: false, detail: 'the wallet link does not name an account as 0x and 40 lowercase hex characters' };
  }
  if (wallet === null || !ADDRESS_PATTERN.test(wallet)) {
    return { ok: false, detail: 'the wallet link does not name a wallet as 0x and 40 lowercase hex characters' };
  }
  if (date === null || !isCanonicalDate(date)) {
    return { ok: false, detail: 'the wallet link date is not ISO 8601 UTC with milliseconds' };
  }
  if (named !== account) {
    return { ok: false, detail: `the wallet link is for ${named}, not the binding's account ${account}` };
  }
  if (recoverPersonalSigner(link.msg, link.wsig) !== wallet) {
    return { ok: false, detail: 'the wallet signature does not recover the wallet the link names' };
  }
  if (recoverPersonalSigner(link.msg, link.asig) !== named) {
    return { ok: false, detail: 'the account signature does not recover the account the link names' };
  }
  return { ok: true, wallet, account: named, date };
}
