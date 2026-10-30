import type { ChatBinding } from '../src/message';

/**
 * Chat bindings made by the Swarm ID fork itself (solarpunk-id `lib` on its branch `feat/site-chat-key`, at e412cc7cc,
 * `createChatBinding` from its built internal entry), for its test account below, dated 2026-10-14T12:00:00.000Z. Swarm ID's own `verifyChatBinding`
 * recovered FORK_ACCOUNT from each, and `acceptedChatBinding` accepted the first. Copied here as literals, since this
 * library never imports Swarm ID.
 */

// Test only. The test account's key, which nobody holds funds with.
export const FORK_ACCOUNT_KEY = '22'.repeat(32);
export const FORK_ACCOUNT = '0x1563915e194d8cfba1943570603f7606a3115508';

export const BOUND_SITE = 'https://example.com';
/** The options a check of a message in BOUND_SITE's chat passes. */
export const AT_SITE = { origins: [BOUND_SITE] };

export const BOUND_CHAT_ADDR = 'c6b7cb635534a22fbc368643cc40355545f666dc';

export const CHAT_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xc6b7cb635534a22fbc368643cc40355545f666dc\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xee2151a66fcdb0852b1bff2a03578aff9556f893e4c6d2aef2d484b4ada153804a7b1c97f40eac18fbd5f75674c918c48a761800e8122b7eae7af45393d9a24d1b',
};

/** The same site a minute later, kept because its recovery byte is 28 where the first one's is 27. */
export const CHAT_BINDING_V28: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xc6b7cb635534a22fbc368643cc40355545f666dc\nDate: 2026-10-14T12:01:00.000Z',
  sig: '0x83b441d76935b450845894310d4bcdf29b3e74f44f750c6c7b045e443575d713151acb617a07673461ae95dddae9d58f2e7affa46c4ffee4ac4f3510cfd8afc01c',
};

export const OTHER_SITE = 'https://other.example';
export const OTHER_CHAT_ADDR = 'e4f3c8ce34e17de035a8476a0744266de7a7787a';

export const OTHER_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://other.example\nChat address: 0xe4f3c8ce34e17de035a8476a0744266de7a7787a\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x9ac7b48626f8971e436126783fa8e1d9146cb108e224ade8cf08600b5f65117d7b296234c424d969ad08dad0b8a30f0612dbc1219b3471d6d066422fb20057cb1c',
};

/** Made by Swarm ID with `allowLocalHttp`, as its development build signs one. */
export const LOCAL_SITE = 'http://localhost:5173';
export const LOCAL_CHAT_ADDR = 'e8ba94db6fdfc694ff9dc9ccd07ef8fe5b7ed140';

export const LOCAL_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: http://localhost:5173\nChat address: 0xe8ba94db6fdfc694ff9dc9ccd07ef8fe5b7ed140\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xf0f5e7fc8a79e619fa0e0ec42c6179b7c3ffaa2e82b9d01bd448d643006088d01e2a34e8d17dc0595d471ed098aa5394e260858c72272868f540f66f117eeed51b',
};

const CHAT_KEY_LABEL = 'swarm-id chat key v1';
const MAX_CHAT_KEY_ATTEMPTS = 16;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

async function hmacSha256(keyHex: string, label: string): Promise<string> {
  const keyBytes = Uint8Array.from(keyHex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label)));
  return Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The chat key Swarm ID gives the test account on `site`, as its `deriveChatKey` derives it. The app secret is
 * HMAC-SHA256 of the site's origin under the account key. The chat key is HMAC-SHA256 of `swarm-id chat key v1` under
 * the app secret, asked again under `swarm-id chat key v1/1`, `/2` and on while the result is not a valid secp256k1
 * private key, from 1 to n - 1. Derived rather than written down, so no key-shaped literal is kept.
 */
export async function chatKeyFor(site: string): Promise<string> {
  const appSecret = await hmacSha256(FORK_ACCOUNT_KEY, site);
  for (let attempt = 0; attempt < MAX_CHAT_KEY_ATTEMPTS; attempt++) {
    const candidate = await hmacSha256(appSecret, attempt === 0 ? CHAT_KEY_LABEL : `${CHAT_KEY_LABEL}/${attempt}`);
    const scalar = BigInt(`0x${candidate}`);
    if (scalar > 0n && scalar < SECP256K1_ORDER) {
      return candidate;
    }
  }
  throw new Error(`no valid chat key for ${site} in ${MAX_CHAT_KEY_ATTEMPTS} attempts`);
}
