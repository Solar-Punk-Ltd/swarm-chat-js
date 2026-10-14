import type { ChatBinding } from '../src/message';

/**
 * Chat bindings made by the Swarm ID fork itself (solarpunk-id `lib`, `createChatBinding` from its internal entry, at
 * b864a9f02), for its test account below, dated 2026-10-14T12:00:00.000Z. The fork's own `verifyChatBinding`
 * recovered FORK_ACCOUNT from each, and `acceptedChatBinding` accepted the first. Copied here as literals, since this
 * library never imports the fork.
 */

// Test only. The fork's account key, which nobody holds funds with.
export const FORK_ACCOUNT_KEY = '22'.repeat(32);
export const FORK_ACCOUNT = '0x1563915e194d8cfba1943570603f7606a3115508';

export const BOUND_SITE = 'https://example.com';
export const BOUND_CHAT_ADDR = 'a531fcf12e72328748c12ba58b2b023c00e9a8f9';

export const CHAT_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xa531fcf12e72328748c12ba58b2b023c00e9a8f9\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x81b66b5a35aac1203c8c19883c40965e1eaee71ba57df28d3465cb8e03cf4263297bc64b2e5db5d815ae4ebb504f0a8c36ead8193bb13cd44138b2de44642c7d1c',
};

/** The same site four minutes later, kept because its recovery byte is 27 where the first one's is 28. */
export const CHAT_BINDING_V27: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xa531fcf12e72328748c12ba58b2b023c00e9a8f9\nDate: 2026-10-14T12:04:00.000Z',
  sig: '0x0ad789946644748a40669fc821cc61a8465d659d87c2f66921b1ee0646c2b050519d8f9561b0ba97ea8456b5198e5c5b52c8afec68feae9bf489373a8c1f40111b',
};

export const OTHER_SITE = 'https://other.example';
export const OTHER_CHAT_ADDR = '7dbe2d309740e55abeb818365acf15bc95cd211a';

export const OTHER_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://other.example\nChat address: 0x7dbe2d309740e55abeb818365acf15bc95cd211a\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xb41bf4bc3623511e462c947495147dc32a651574884182ca6ae85a5374b5529c3a8a12fe082c32c4956662501f49d7810937e2ce7283450c4d801409187f9a301c',
};

/** Made by the fork with `allowLocalHttp`, as its development build signs one. */
export const LOCAL_SITE = 'http://localhost:5173';
export const LOCAL_CHAT_ADDR = '53211e623dcc41a5f58dcaea359bb0af5866d3bf';

export const LOCAL_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: http://localhost:5173\nChat address: 0x53211e623dcc41a5f58dcaea359bb0af5866d3bf\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x05f059979417de319d2c51aa27649322ca7d9367fba7c8f175f6168f4fa056a349da0352a65dd129b6775508282bbc64160623791daf8da5e65ceb462b9919de1c',
};

/**
 * The chat key the fork gives the test account on `site`: HMAC-SHA256 of the site's origin under the account key, as
 * the fork's `deriveSecret` makes an app secret. Derived rather than written down, so no key-shaped literal is kept.
 */
export async function chatKeyFor(site: string): Promise<string> {
  const keyBytes = Uint8Array.from(FORK_ACCOUNT_KEY.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(site)));
  return Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
