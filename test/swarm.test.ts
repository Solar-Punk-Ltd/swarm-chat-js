import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { beeChatSource, beeGsocWrite, GATEWAY_STAMPS_ITSELF, UnreadableSlotError } from '../src/swarm';

// Test only: the owner and the GSOC key are never used against a real node.
const OWNER = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const GSOC_KEY = '22'.repeat(32);
const TIMEOUTS = { slotReadMs: 2_000, feedReadMs: 2_000, writeMs: 2_000 };

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

let server: Server;
let base: string;
let answer: (seen: Seen) => { status: number; body?: Uint8Array; headers?: Record<string, string> };
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const record = { method: request.method ?? '', url: request.url ?? '', headers: request.headers };
    seen.push(record);
    request.resume();
    request.on('end', () => {
      const { status, body, headers } = answer(record);
      response.writeHead(status, { 'content-type': 'application/octet-stream', ...headers });
      response.end(body ?? JSON.stringify({ message: 'x', code: status }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

describe('beeChatSource.readSlot', () => {
  it('answers null for a 404, which is a slot not written or not found in time', async () => {
    answer = () => ({ status: 404 });
    const source = beeChatSource(new Bee(base), OWNER, 'chat-test', TIMEOUTS);
    await expect(source.readSlot(3)).resolves.toBeNull();
    expect(seen[0]?.url).toMatch(/^\/chunks\/[0-9a-f]{64}$/);
  });

  it('rejects for a 500, which is the gateway failing and never the end of the chat', async () => {
    answer = () => ({ status: 500 });
    const source = beeChatSource(new Bee(base), OWNER, 'chat-test', TIMEOUTS);
    await expect(source.readSlot(3)).rejects.toThrow();
  });

  it('returns the payload of a slot the feed owner wrote', async () => {
    // A real bee-js feed writer uploads the slot, and the fake gateway serves back what it received as the chunk.
    const owner = new PrivateKey(GSOC_KEY);
    const payload = new TextEncoder().encode('{"v":7,"seq":0}');
    let stored: Uint8Array = new Uint8Array();
    answer = () => ({ status: 200, body: stored });
    const received: Uint8Array[] = [];
    const capturing = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', (part: Buffer) => parts.push(part));
      request.on('end', () => {
        const [identifier, query] = (request.url ?? '').split('/').slice(3).join('/').split('?sig=');
        received.push(
          new Uint8Array([
            ...Buffer.from(identifier ?? '', 'hex'),
            ...Buffer.from(query ?? '', 'hex'),
            ...Buffer.concat(parts),
          ]),
        );
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ reference: 'ab'.repeat(32) }));
      });
    });
    await new Promise<void>((resolve) => capturing.listen(0, '127.0.0.1', resolve));
    try {
      const writer = new Bee(`http://127.0.0.1:${(capturing.address() as AddressInfo).port}`).feed.makeWriter(
        Topic.fromString('chat-test'),
        owner,
      );
      await writer.uploadPayload(GATEWAY_STAMPS_ITSELF, payload, { index: 0 });
    } finally {
      await new Promise<void>((resolve) => capturing.close(() => resolve()));
    }
    stored = received[0]!;

    const source = beeChatSource(new Bee(base), owner.publicKey().address().toHex(), 'chat-test', TIMEOUTS);
    await expect(source.readSlot(0)).resolves.toEqual(payload);
  });

  it('names a served chunk that fails its own check, apart from a gateway failure', async () => {
    answer = () => ({ status: 200, body: new Uint8Array(200) });
    const source = beeChatSource(new Bee(base), OWNER, 'chat-test', TIMEOUTS);
    await expect(source.readSlot(3)).rejects.toBeInstanceOf(UnreadableSlotError);
  });

  it('gives up on a read that outlives its timeout, which bee-js alone would not', async () => {
    answer = () => ({ status: 404 });
    const slow = createServer(() => {});
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
      const source = beeChatSource(new Bee(url), OWNER, 'chat-test', { ...TIMEOUTS, slotReadMs: 200 });
      const started = Date.now();
      await expect(source.readSlot(0)).rejects.not.toBeInstanceOf(UnreadableSlotError);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

describe('beeChatSource.readHead', () => {
  it('answers null for a 404 from the head lookup', async () => {
    answer = () => ({ status: 404 });
    const source = beeChatSource(new Bee(base), OWNER, 'chat-test', TIMEOUTS);
    await expect(source.readHead()).resolves.toBeNull();
    expect(seen[0]?.url).toMatch(new RegExp(`^/feeds/${OWNER}/[0-9a-f]{64}`));
  });

  it('rejects for any other failure', async () => {
    answer = () => ({ status: 502 });
    const source = beeChatSource(new Bee(base), OWNER, 'chat-test', TIMEOUTS);
    await expect(source.readHead()).rejects.toThrow();
  });
});

describe('beeGsocWrite', () => {
  it('posts one single owner chunk, never deferred and never tagged', async () => {
    answer = () => ({
      status: 201,
      body: new TextEncoder().encode(JSON.stringify({ reference: 'ab'.repeat(32) })),
      headers: { 'content-type': 'application/json' },
    });
    const write = beeGsocWrite(new Bee(base), GATEWAY_STAMPS_ITSELF, GSOC_KEY, 'gsoc-inbox', TIMEOUTS);
    await write(new TextEncoder().encode('{"v":7}'));

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url).toMatch(/^\/soc\/[0-9a-f]{40}\/[0-9a-f]{64}\?sig=[0-9a-f]{130}$/);
    expect(request?.headers['swarm-deferred-upload']).toBe('false');
    expect(request?.headers['swarm-tag']).toBeUndefined();
    expect(request?.headers['swarm-postage-batch-id']).toBe(GATEWAY_STAMPS_ITSELF);
  });

  it('rejects when the gateway refuses the write', async () => {
    answer = () => ({ status: 402 });
    const write = beeGsocWrite(new Bee(base), GATEWAY_STAMPS_ITSELF, GSOC_KEY, 'gsoc-inbox', TIMEOUTS);
    await expect(write(new Uint8Array([1]))).rejects.toThrow();
  });
});
