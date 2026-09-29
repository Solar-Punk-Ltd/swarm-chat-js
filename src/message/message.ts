import { PrivateKey, Signature } from '@ethersphere/bee-js';
import { z } from 'zod';

/**
 * The chat message of version 7: what a browser sends as a GSOC payload, what the server verifies before it
 * publishes, and what every feed entry carries back as `msg`. This module is the only place its bytes are built,
 * signed, checked and read, and the server imports it from here rather than keeping a copy.
 */

export const MESSAGE_VERSION = 7;

/** Measured on the UTF-8 of the whole JSON object, on top of the per-field caps. */
export const MAX_MESSAGE_BYTES = 2048;

export const MAX_TOPIC_CHARACTERS = 128;
export const MAX_TEXT_CHARACTERS = 500;
export const MAX_NAME_CHARACTERS = 20;

export const MessageType = {
  TEXT: 'text',
  THREAD: 'thread',
  REACTION: 'reaction',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

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

const messageId = lowercaseHex(32);

export const chatMessageSchema = z
  .strictObject({
    v: z.literal(MESSAGE_VERSION),
    topic: characters(1, MAX_TOPIC_CHARACTERS),
    id: messageId,
    type: z.enum([MessageType.TEXT, MessageType.THREAD, MessageType.REACTION]),
    target: z.union([z.literal(''), messageId]),
    text: characters(1, MAX_TEXT_CHARACTERS),
    name: characters(1, MAX_NAME_CHARACTERS),
    addr: lowercaseHex(40),
    ts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sig: lowercaseHex(130),
  })
  .refine((message) => (message.type === MessageType.TEXT) === (message.target === ''), {
    message: 'a text message has no target, a thread reply or a reaction names one',
    path: ['target'],
  });

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export type UnsignedChatMessage = Omit<ChatMessage, 'sig'>;

export type ChatMessageRefusal = 'too-large' | 'not-utf8' | 'not-json' | 'shape' | 'signature';

export type ChatMessageCheck =
  | { ok: true; message: ChatMessage }
  | { ok: false; reason: ChatMessageRefusal; detail: string };

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
 * a field outside its cap, or a payload over MAX_MESSAGE_BYTES.
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

  const message: ChatMessage = { ...unsigned, sig: signer.sign(signedBytes(unsigned)).toHex() };
  return { message, bytes: encodeChatMessage(message) };
}

/** Whether `sig` was made over this message's signed bytes by the key behind `addr`. */
export function hasValidSignature(message: ChatMessage): boolean {
  try {
    const signer = new Signature(message.sig).recoverPublicKey(signedBytes(message)).address();
    return signer.toHex() === message.addr;
  } catch {
    return false;
  }
}

/** Checks a message that arrived as an object, its shape and its signature. */
export function checkChatMessage(value: unknown): ChatMessageCheck {
  const shape = chatMessageSchema.safeParse(value);
  if (!shape.success) {
    return { ok: false, reason: 'shape', detail: describeIssues(shape.error) };
  }
  if (!hasValidSignature(shape.data)) {
    return { ok: false, reason: 'signature', detail: 'the signature was not made by addr over these fields' };
  }
  return { ok: true, message: shape.data };
}

/**
 * Checks a message as it arrived on the wire: the byte cap on the raw payload, then UTF-8, JSON, the shape and the
 * signature. Never throws, since the server calls it on whatever anybody writes to the chat's GSOC address.
 */
export function parseChatMessage(payload: Uint8Array): ChatMessageCheck {
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
  return checkChatMessage(value);
}
