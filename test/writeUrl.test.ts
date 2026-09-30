import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MessageType, SwarmChat, type ChatSettings } from '../src/index';

// Test only: the owner and the keys are never used against a real node.
const OWNER = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const GSOC_KEY = '22'.repeat(32);
const USER_KEY = '33'.repeat(32);
const WRITTEN = JSON.stringify({ reference: 'ab'.repeat(32) });

interface Node {
  server: Server;
  url: string;
  requests: string[];
}

/**
 * A stand-in for one Bee node that notes each request as `METHOD /first-path-part`. A read of the chat finds nothing,
 * which is an empty chat, and a GSOC write is accepted.
 */
async function startNode(): Promise<Node> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} /${(request.url ?? '').split('/')[1]}`);
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(WRITTEN);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Not Found', code: 404 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function settings(infra: { beeUrl: string; writeUrl?: string }): ChatSettings {
  return {
    user: { privateKey: USER_KEY, nickname: 'ada' },
    infra: {
      ...infra,
      gsocTopic: 'inbox',
      gsocResourceId: GSOC_KEY,
      chatTopic: 'chat-test',
      chatAddress: OWNER,
      pollingInterval: 50,
      feedReadTimeout: 2_000,
      socReadTimeout: 2_000,
      gsocWriteTimeout: 2_000,
    },
  };
}

async function openAndSend(chat: SwarmChat, writer: Node): Promise<void> {
  await chat.start();
  await chat.sendMessage('hello', MessageType.TEXT);
  await expect.poll(() => writer.requests.filter((request) => request === 'POST /soc').length).toBe(1);
}

let reads: Node;
let writes: Node;
let chat: SwarmChat | null = null;

beforeAll(async () => {
  reads = await startNode();
  writes = await startNode();
});

afterEach(async () => {
  await chat?.stop();
  chat = null;
  reads.requests.length = 0;
  writes.requests.length = 0;
});

afterAll(async () => {
  for (const node of [reads, writes]) await new Promise<void>((resolve) => node.server.close(() => resolve()));
});

describe('infra.writeUrl', () => {
  it('sends the inbox write to writeUrl and every read to beeUrl', async () => {
    chat = new SwarmChat(settings({ beeUrl: reads.url, writeUrl: writes.url }));
    await openAndSend(chat, writes);

    expect(writes.requests.every((request) => request === 'POST /soc')).toBe(true);
    expect(reads.requests.length).toBeGreaterThan(0);
    expect(reads.requests.every((request) => request.startsWith('GET '))).toBe(true);
  });

  it('sends reads and the write to beeUrl when there is no writeUrl', async () => {
    chat = new SwarmChat(settings({ beeUrl: reads.url }));
    await openAndSend(chat, reads);

    expect(reads.requests.some((request) => request.startsWith('GET '))).toBe(true);
    expect(writes.requests).toEqual([]);
  });
});
