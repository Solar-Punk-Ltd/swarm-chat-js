import { publicKeyToAddress, recoverPublicKey } from '@ethersphere/core-sdk/crypto';

import { isCanonicalSignature } from './canonicalSignature.js';

/**
 * EIP-191 personal_sign recovery and the date spelling, as the Swarm ID fork signs and reads its statements: the chat
 * binding and the wallet link. bee-js's `Signature` cannot recover a personal_sign signature, so this goes through
 * `@ethersphere/core-sdk/crypto` and passes v as a bigint.
 */

const PERSONAL_MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';
const RECOVERY_IDS = new Set([27, 28]);
/** `Date.prototype.toISOString` exactly: UTC, milliseconds and a `Z`. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const encoder = new TextEncoder();

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

/**
 * The address that made `sig` over `text`, `0x` and 40 lowercase hex characters, or null for a signature Swarm ID
 * would refuse or nothing recovers from. `sig` is `0x` and 130 hex characters of r, s and v, already shape-checked.
 */
export function recoverPersonalSigner(text: string, sig: string): string | null {
  const rHex = sig.slice(2, 66);
  const sHex = sig.slice(66, 130);
  const v = parseInt(sig.slice(130), 16);
  if (!RECOVERY_IDS.has(v) || !isCanonicalSignature(rHex, sHex)) {
    return null;
  }
  try {
    const point = recoverPublicKey(
      personalMessage(text),
      BigInt(`0x${rHex}`),
      BigInt(`0x${sHex}`),
      BigInt(v) as 27n | 28n,
    );
    return `0x${toHex(publicKeyToAddress(point))}`;
  } catch {
    return null;
  }
}

/** Whether `text` is a date in the one spelling `Date.prototype.toISOString` writes. */
export function isCanonicalDate(text: string): boolean {
  if (!ISO_UTC_PATTERN.test(text)) {
    return false;
  }
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}
