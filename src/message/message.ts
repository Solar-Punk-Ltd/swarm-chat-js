import { PrivateKey, Signature } from '@ethersphere/bee-js';
import { z } from 'zod';

import { chatBindingSchema, checkChatBinding, type ChatBinding, type ChatIdentity } from './binding.js';
import { isCanonicalSignature } from './canonicalSignature.js';
import { checkWalletLink, walletLinkSchema, type WalletLink } from './walletLink.js';

/**
 * The chat message of version 9: what a browser sends as a GSOC payload, what the server verifies before it
 * publishes, and what every feed entry carries back as `msg`. This module is the only place its bytes are built,
 * signed, checked and read, and the server imports it from here rather than keeping a copy. A message of any other
 * version fails the shape check.
 */

export const MESSAGE_VERSION = 9;

/**
 * Measured on the UTF-8 of the whole JSON object, on top of the per-field caps, wallet link included. Large enough for
 * a 500 character text of two byte characters with a Swarm ID binding and a wallet link, at every other cap, which
 * comes to 2,376 bytes.
 */
export const MAX_MESSAGE_BYTES = 3072;

export const MAX_TOPIC_CHARACTERS = 128;
export const MAX_TEXT_CHARACTERS = 500;
export const MAX_NAME_CHARACTERS = 20;

export const MessageType = {
  TEXT: 'text',
  THREAD: 'thread',
  REACTION: 'reaction',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Who paid for the inbox write: the gateway's stamp, or the sender's own. */
export const MessageVia = {
  GATEWAY: 'gateway',
  OWN_STAMP: 'own-stamp',
} as const;

export type MessageVia = (typeof MessageVia)[keyof typeof MessageVia];

/**
 * Characters are counted as Unicode code points, never as UTF-16 units, so an emoji outside the basic plane counts
 * once. A composer that shows a count uses this function, so it and the check agree.
 */
export function countCharacters(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

function lowercaseHex(length: number) {
  return z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `expected ${length} lowercase hex characters`);
}

function characters(min: number, max: number) {
  return z.string().refine((value) => {
    const count = countCharacters(value);
    return count >= min && count <= max;
  }, `expected ${min} to ${max} characters`);
}

/**
 * Format and control code points draw nothing of their own yet change what is around them: a right-to-left override
 * shows `evil\u202egnp.exe` as `evilexe.png`, and a zero width space makes two names that look the same differ. A
 * name is how readers tell senders apart, so it carries neither. The zero width non-joiner U+200C and joiner U+200D
 * are the two exceptions: Persian and the Indic scripts spell words with them, and a joined emoji such as a family is
 * built from them, while neither can reorder text.
 */
const INVISIBLE_CODE_POINT = /(?![\u200c\u200d])[\p{Cf}\p{Cc}]/u;

function displayName(min: number, max: number) {
  return characters(min, max).refine(
    (value) => !INVISIBLE_CODE_POINT.test(value),
    'expected no format or control characters',
  );
}

/** Why a name is refused: `length` is outside 1 to {@link MAX_NAME_CHARACTERS} characters, `invisible` holds a format or control character. */
export type DisplayNameProblem = 'length' | 'invisible';

/**
 * Whether `name` is one a message may carry, as the message check reads it, and why not when it is not. A composer
 * calls this on the name as it will be sent, so it and the check agree.
 */
export function displayNameProblem(name: string): DisplayNameProblem | null {
  const length = countCharacters(name);
  if (length < 1 || length > MAX_NAME_CHARACTERS) {
    return 'length';
  }
  return INVISIBLE_CODE_POINT.test(name) ? 'invisible' : null;
}

const messageId = lowercaseHex(32);

export const chatMessageSchema = z
  .strictObject({
    v: z.literal(MESSAGE_VERSION),
    topic: characters(1, MAX_TOPIC_CHARACTERS),
    id: messageId,
    type: z.enum([MessageType.TEXT, MessageType.THREAD, MessageType.REACTION]),
    target: z.union([z.literal(''), messageId]),
    text: characters(1, MAX_TEXT_CHARACTERS),
    name: displayName(1, MAX_NAME_CHARACTERS),
    addr: lowercaseHex(40),
    ts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    via: z.enum([MessageVia.GATEWAY, MessageVia.OWN_STAMP]),
    /** The sender's Swarm ID chat binding, present only for a signed-in sender. */
    idb: chatBindingSchema.optional(),
    /** The sender's Swarm ID wallet link, present only beside a binding, for a sender who shows an ENS name. */
    wl: walletLinkSchema.optional(),
    sig: lowercaseHex(130),
  })
  .refine((message) => (message.type === MessageType.TEXT) === (message.target === ''), {
    message: 'a text message has no target, a thread reply or a reaction names one',
    path: ['target'],
  })
  .refine((message) => message.wl === undefined || message.idb !== undefined, {
    message: 'a wallet link is carried only beside a chat binding, whose account it names',
    path: ['wl'],
  });

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export type UnsignedChatMessage = Omit<ChatMessage, 'sig'>;

export type ChatMessageRefusal = 'too-large' | 'not-utf8' | 'not-json' | 'shape' | 'signature' | 'binding';

/** `identity` is null for a guest, a message with no binding. */
export type ChatMessageCheck =
  | { ok: true; message: ChatMessage; identity: ChatIdentity | null }
  | { ok: false; reason: ChatMessageRefusal; detail: string };

/**
 * `origin` is the site the chat runs on, a bare origin such as `https://example.com`, and is required: a binding for
 * any other site is refused, so a binding signed for one site never passes in another site's chat.
 */
export interface VerifyOptions {
  origin: string;
  /** Accept a binding for `http://localhost`, `http://127.0.0.1` or `http://[::1]`, as only a development build signs. */
  allowLocalHttp?: boolean;
}

export class ChatMessageError extends Error {
  constructor(
    readonly reason: ChatMessageRefusal,
    detail: string,
  ) {
    super(`chat message refused (${reason}): ${detail}`);
    this.name = 'ChatMessageError';
  }
}

const encoder = new TextEncoder();

/** The two recovery bytes a signature may end in, as hex. */
const RECOVERY_27 = '1b';
const RECOVERY_28 = '1c';
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The exact bytes a sender signs and a verifier recovers the signer from. Their order is the contract. */
export function signedBytes(message: UnsignedChatMessage): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      message.v,
      message.topic,
      message.id,
      message.type,
      message.target,
      message.text,
      message.name,
      message.addr,
      message.ts,
      message.via,
      message.idb?.msg ?? '',
      message.idb?.sig ?? '',
      // Appended only when there is one, so every message without a link keeps the bytes it was signed over.
      ...(message.wl ? [message.wl.msg, message.wl.wsig, message.wl.asig] : []),
    ]),
  );
}

/** The payload bytes, with the fields in the contract's order so two senders of one message send one payload. */
export function encodeChatMessage(message: ChatMessage): Uint8Array {
  const ordered: ChatMessage = {
    v: message.v,
    topic: message.topic,
    id: message.id,
    type: message.type,
    target: message.target,
    text: message.text,
    name: message.name,
    addr: message.addr,
    ts: message.ts,
    via: message.via,
    ...(message.idb ? { idb: { msg: message.idb.msg, sig: message.idb.sig } } : {}),
    ...(message.wl ? { wl: { msg: message.wl.msg, wsig: message.wl.wsig, asig: message.wl.asig } } : {}),
    sig: message.sig,
  };
  return encoder.encode(JSON.stringify(ordered));
}

export function newMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ChatMessageDraft {
  topic: string;
  type: MessageType;
  /** The id a thread reply or a reaction refers to. Left out for a text message. */
  target?: string;
  text: string;
  name: string;
  /** Made fresh when left out. Given only to rebuild a message whose bytes must not change. */
  id?: string;
  /** The sender's clock in milliseconds, `Date.now()` when left out. */
  ts?: number;
  /** Who pays for the inbox write. Required, since nothing can tell from here. */
  via: MessageVia;
  /** The sender's Swarm ID chat binding, given only for a signed-in sender. */
  idb?: ChatBinding;
  /** The sender's Swarm ID wallet link, given only beside `idb`, for a sender who shows an ENS name. */
  wl?: WalletLink;
}

export interface SignedChatMessage {
  message: ChatMessage;
  bytes: Uint8Array;
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`).join(', ');
}

/**
 * Builds and signs a message, and throws a ChatMessageError before signing anything that the server would refuse:
 * a field outside its cap, a payload over MAX_MESSAGE_BYTES, or a binding that is not for this key.
 */
export function createChatMessage(
  privateKey: PrivateKey | Uint8Array | string,
  draft: ChatMessageDraft,
): SignedChatMessage {
  const signer = privateKey instanceof PrivateKey ? privateKey : new PrivateKey(privateKey);
  const unsigned: UnsignedChatMessage = {
    v: MESSAGE_VERSION,
    topic: draft.topic,
    id: draft.id ?? newMessageId(),
    type: draft.type,
    target: draft.target ?? '',
    text: draft.text,
    name: draft.name,
    addr: signer.publicKey().address().toHex(),
    ts: draft.ts ?? Date.now(),
    via: draft.via,
    ...(draft.idb ? { idb: draft.idb } : {}),
    ...(draft.wl ? { wl: draft.wl } : {}),
  };

  // A placeholder of the signature's exact length checks the shape and measures the final payload before signing.
  const sized = { ...unsigned, sig: '0'.repeat(130) };
  const shape = chatMessageSchema.safeParse(sized);
  if (!shape.success) {
    throw new ChatMessageError('shape', describeIssues(shape.error));
  }
  const size = encodeChatMessage(sized).byteLength;
  if (size > MAX_MESSAGE_BYTES) {
    throw new ChatMessageError('too-large', `${size} bytes, the cap is ${MAX_MESSAGE_BYTES}`);
  }
  if (unsigned.idb) {
    // Which sites a binding may name is the verifier's call, so only what no verifier would accept is refused here.
    const binding = checkChatBinding(unsigned.idb, unsigned.addr, { allowLocalHttp: true });
    if (!binding.ok) {
      throw new ChatMessageError('binding', binding.detail);
    }
    if (unsigned.wl) {
      const link = checkWalletLink(unsigned.wl, binding.identity.account);
      if (!link.ok) {
        throw new ChatMessageError('binding', `wallet link: ${link.detail}`);
      }
    }
  }

  const message: ChatMessage = { ...unsigned, sig: signer.sign(signedBytes(unsigned)).toHex() };
  return { message, bytes: encodeChatMessage(message) };
}

/**
 * Whether `sig` was made over this message's signed bytes by the key behind `addr`, in its one canonical spelling: v 27
 * or 28 and a low s, as bee-js signs. bee-js would also recover the signer from the high s twin, or from any other v.
 */
export function hasValidSignature(message: ChatMessage): boolean {
  const v = message.sig.slice(128);
  if (
    (v !== RECOVERY_27 && v !== RECOVERY_28) ||
    !isCanonicalSignature(message.sig.slice(0, 64), message.sig.slice(64, 128))
  ) {
    return false;
  }
  try {
    const signer = new Signature(message.sig).recoverPublicKey(signedBytes(message)).address();
    return signer.toHex() === message.addr;
  } catch {
    return false;
  }
}

/**
 * Verifies a message that arrived as an object: its shape, its signature, and, when it carries a binding, that the
 * binding is the fork's four lines for this `addr` and for `options.origin`, and recovers an account. When it also
 * carries a wallet link, the link must be the fork's five lines for that account, signed by its wallet and by the
 * account, and the identity then names the wallet. A message whose binding or link fails is refused as `binding`,
 * never passed as a guest, and so is a bound message checked with no origin.
 * Never throws, and touches no DOM and no Node API, so a page runs it in a Web Worker as the server runs it.
 */
export function verifyChatMessage(value: unknown, options: VerifyOptions): ChatMessageCheck {
  const shape = chatMessageSchema.safeParse(value);
  if (!shape.success) {
    return { ok: false, reason: 'shape', detail: describeIssues(shape.error) };
  }
  const message = shape.data;
  if (!hasValidSignature(message)) {
    return { ok: false, reason: 'signature', detail: 'the signature was not made by addr over these fields' };
  }
  if (!message.idb) {
    return { ok: true, message, identity: null };
  }
  // A caller outside TypeScript can still leave the origin out, which would accept a binding for any site.
  if (typeof options?.origin !== 'string') {
    return { ok: false, reason: 'binding', detail: 'no origin was given to check the binding against' };
  }
  const binding = checkChatBinding(message.idb, message.addr, options);
  if (!binding.ok) {
    return { ok: false, reason: 'binding', detail: binding.detail };
  }
  if (!message.wl) {
    return { ok: true, message, identity: binding.identity };
  }
  // Refused as the binding rather than under a reason of its own, since the link is part of who the binding says sent
  // the message, and a server counting refusals by reason keeps its list.
  const link = checkWalletLink(message.wl, binding.identity.account);
  if (!link.ok) {
    return { ok: false, reason: 'binding', detail: `wallet link: ${link.detail}` };
  }
  return { ok: true, message, identity: { ...binding.identity, wallet: link.wallet } };
}

/**
 * Verifies a message as it arrived on the wire: the byte cap on the raw payload, then UTF-8, JSON, and everything
 * `verifyChatMessage` checks. Never throws, since the server calls it on whatever anybody writes to the chat's GSOC
 * address.
 */
export function parseChatMessage(payload: Uint8Array, options: VerifyOptions): ChatMessageCheck {
  if (payload.byteLength > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: 'too-large', detail: `${payload.byteLength} bytes, the cap is ${MAX_MESSAGE_BYTES}` };
  }
  let text: string;
  try {
    text = decoder.decode(payload);
  } catch {
    return { ok: false, reason: 'not-utf8', detail: 'the payload is not valid UTF-8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json', detail: 'the payload is not JSON' };
  }
  return verifyChatMessage(value, options);
}
