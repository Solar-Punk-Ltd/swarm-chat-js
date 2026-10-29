import { z } from 'zod';

import { isCanonicalDate, recoverPersonalSigner } from './personalSign.js';

/**
 * The Swarm ID chat binding: the account's statement, signed with its own key, that a chat address on one site is its
 * own. The Swarm ID fork (solarpunk-id, `lib/src/utils/chat-binding.ts`) makes it, and this module reads it exactly as
 * Swarm ID's `verifyChatBinding` does, without importing Swarm ID: the same four lines, the same clean site origin,
 * the same EIP-191 personal_sign recovery with v 27 or 28 and a low s.
 */

/** The first line, which also versions the binding format. */
export const CHAT_BINDING_TITLE = 'Swarm ID chat binding v1';

/** Swarm ID's own bound on a binding's text. */
export const MAX_BINDING_CHARACTERS = 512;

const SITE_PREFIX = 'Site: ';
const CHAT_ADDRESS_PREFIX = 'Chat address: ';
const DATE_PREFIX = 'Date: ';
const LINE_SEPARATOR = '\n';
const LINE_COUNT = 4;

const CHAT_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
/** DNS labels in punycode joined by single dots, which keeps out `*`, `_` and empty labels a URL parser lets through. */
const DNS_HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A binding as a message carries it. `sig` is spelled as Swarm ID writes it, `0x` and 130 lowercase hex characters
 * of r, s and v, so one binding has one spelling inside the signed bytes.
 */
export const chatBindingSchema = z.strictObject({
  msg: z.string().max(MAX_BINDING_CHARACTERS),
  sig: z.string().regex(/^0x[0-9a-f]{130}$/, 'expected 0x and 130 lowercase hex characters'),
});

export type ChatBinding = z.infer<typeof chatBindingSchema>;

/** Who a verified binding says the sender is. */
export interface ChatIdentity {
  /** The Swarm ID account that signed the binding, `0x` and 40 lowercase hex characters. */
  account: string;
  /** The site the binding was signed for, a bare origin. */
  site: string;
  /** When the account says it signed, ISO 8601 UTC. */
  date: string;
  /**
   * The wallet the message's Swarm ID wallet link names, `0x` and 40 lowercase hex characters, present only when the
   * message carries a link both the wallet and this account signed. A reader looks its ENS name up itself, and the
   * Swarm ID's `resolveVerifiedEnsName` does that with both the reverse and the forward record.
   */
  wallet?: string;
}

export interface BindingOptions {
  /** The origin the reader runs on. When given, a binding for any other site is refused. */
  origin?: string;
  /** Accept a binding for `http://localhost`, `http://127.0.0.1` or `http://[::1]`, as only a development build signs. */
  allowLocalHttp?: boolean;
}

export type BindingCheck = { ok: true; identity: ChatIdentity } | { ok: false; detail: string };

/** Whether `value` is a bare origin in the one spelling a browser reports, as Swarm ID's `isCleanSiteOrigin` asks. */
function isCleanSiteOrigin(value: string, allowLocalHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:';
  const localHttp = allowLocalHttp && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !localHttp) {
    return false;
  }
  if (!localHttp && !DNS_HOST_PATTERN.test(url.hostname)) {
    return false;
  }
  return url.host !== '' && url.username === '' && url.password === '' && url.origin === value;
}

function afterPrefix(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/**
 * Reads a binding for the chat address `addr` (40 lowercase hex characters, no `0x`). Refuses every text but the four
 * lines Swarm ID writes, a binding for another chat address, one for another site than `origin` when that is given,
 * and a signature nothing recovers an account from. Never throws.
 */
export function checkChatBinding(binding: ChatBinding, addr: string, options: BindingOptions = {}): BindingCheck {
  if (!chatBindingSchema.safeParse(binding).success) {
    return { ok: false, detail: 'not a binding of a text and a 65 byte signature' };
  }
  const lines = binding.msg.split(LINE_SEPARATOR);
  if (lines.length !== LINE_COUNT || lines[0] !== CHAT_BINDING_TITLE) {
    return { ok: false, detail: `not the ${LINE_COUNT} lines of a ${CHAT_BINDING_TITLE}` };
  }
  const site = afterPrefix(lines[1]!, SITE_PREFIX);
  const chatAddress = afterPrefix(lines[2]!, CHAT_ADDRESS_PREFIX);
  const date = afterPrefix(lines[3]!, DATE_PREFIX);
  if (site === null || !isCleanSiteOrigin(site, options.allowLocalHttp === true)) {
    return { ok: false, detail: 'the binding does not name a clean site origin' };
  }
  if (chatAddress === null || !CHAT_ADDRESS_PATTERN.test(chatAddress)) {
    return { ok: false, detail: 'the binding does not name a chat address as 0x and 40 lowercase hex characters' };
  }
  if (date === null || !isCanonicalDate(date)) {
    return { ok: false, detail: 'the binding date is not ISO 8601 UTC with milliseconds' };
  }
  if (chatAddress !== `0x${addr}`) {
    return { ok: false, detail: 'the binding is for another chat address than addr' };
  }
  if (options.origin !== undefined && site !== options.origin) {
    return { ok: false, detail: `the binding is for ${site}, not ${options.origin}` };
  }
  const account = recoverPersonalSigner(binding.msg, binding.sig);
  if (account === null) {
    return { ok: false, detail: 'the binding signature recovers no account' };
  }
  return { ok: true, identity: { account, site, date } };
}
