import { publicKeyToAddress, recoverPublicKey } from '@ethersphere/core-sdk/crypto';
import { z } from 'zod';

/**
 * The Swarm ID chat binding: the account's statement, signed with its own key, that a chat address on one site is its
 * own. The Swarm ID fork (solarpunk-id, `lib/src/utils/chat-binding.ts`) makes it, and this module reads it exactly as
 * the fork's `verifyChatBinding` does, without importing the fork: the same four lines, the same clean site origin,
 * the same EIP-191 personal_sign recovery with v 27 or 28 and a low s.
 */

/** The first line, which also versions the binding format. */
export const CHAT_BINDING_TITLE = 'Swarm ID chat binding v1';

/** The fork's own bound on a binding's text. */
export const MAX_BINDING_CHARACTERS = 512;

const SITE_PREFIX = 'Site: ';
const CHAT_ADDRESS_PREFIX = 'Chat address: ';
const DATE_PREFIX = 'Date: ';
const LINE_SEPARATOR = '\n';
const LINE_COUNT = 4;

const PERSONAL_MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';
const RECOVERY_IDS = new Set([27, 28]);
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

const CHAT_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
/** `Date.prototype.toISOString` exactly: UTC, milliseconds and a `Z`. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** DNS labels in punycode joined by single dots, which keeps out `*`, `_` and empty labels a URL parser lets through. */
const DNS_HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A binding as a message carries it. `sig` is spelled as the fork writes it, `0x` and 130 lowercase hex characters
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
}

export interface BindingOptions {
  /** The origin the reader runs on. When given, a binding for any other site is refused. */
  origin?: string;
  /** Accept a binding for `http://localhost`, `http://127.0.0.1` or `http://[::1]`, as only a development build signs. */
  allowLocalHttp?: boolean;
}

export type BindingCheck = { ok: true; identity: ChatIdentity } | { ok: false; detail: string };

const encoder = new TextEncoder();

/** Whether `value` is a bare origin in the one spelling a browser reports, as the fork's `isCleanSiteOrigin` asks. */
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

function isCanonicalDate(text: string): boolean {
  if (!ISO_UTC_PATTERN.test(text)) {
    return false;
  }
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}

function afterPrefix(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

/** The bytes whose keccak256 personal_sign signs: the prefix, the text's UTF-8 length in decimal, then the text. */
function personalMessage(text: string): Uint8Array {
  const body = encoder.encode(text);
  const prefix = encoder.encode(`${PERSONAL_MESSAGE_PREFIX}${body.length}`);
  const whole = new Uint8Array(prefix.length + body.length);
  whole.set(prefix);
  whole.set(body, prefix.length);
  return whole;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The account that made `sig` over `text`, or null for a signature the fork would refuse or nothing recovers from. */
function recoverAccount(text: string, sig: string): string | null {
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130), 16);
  if (!RECOVERY_IDS.has(v) || r === 0n || r >= SECP256K1_ORDER || s === 0n || s > SECP256K1_HALF_ORDER) {
    return null;
  }
  try {
    const point = recoverPublicKey(personalMessage(text), r, s, BigInt(v) as 27n | 28n);
    return `0x${toHex(publicKeyToAddress(point))}`;
  } catch {
    return null;
  }
}

/**
 * Reads a binding for the chat address `addr` (40 lowercase hex characters, no `0x`). Refuses every text but the four
 * lines the fork writes, a binding for another chat address, one for another site than `origin` when that is given,
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
  const account = recoverAccount(binding.msg, binding.sig);
  if (account === null) {
    return { ok: false, detail: 'the binding signature recovers no account' };
  }
  return { ok: true, identity: { account, site, date } };
}
