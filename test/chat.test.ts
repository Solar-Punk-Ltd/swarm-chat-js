import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChatMessageError,
  EVENTS,
  FeedStatus,
  MessageType,
  parseChatMessage,
  SwarmChat,
  type MessageData,
} from '../src';
import type { ChatParts, ChatSettings } from '../src/chat';

import { bytes, entryAt, FakeGateway, TEST_KEY, TOPIC } from './fakeGateway';

const POLL_MS = 500;

const SETTINGS: ChatSettings = {
  user: { privateKey: TEST_KEY, nickname: 'tester' },
  infra: {
    beeUrl: 'http://gateway.example.com',
    gsocTopic: 'gsoc-inbox',
    // Test only.
    gsocResourceId: '22'.repeat(32),
    chatTopic: TOPIC,
    chatAddress: '33'.repeat(20),
    pollingInterval: POLL_MS,
  },
};

/**
 * The server, as far as a viewer can tell: a write that passes the message check is published as the next entry, and
 * `deaf` drops writes on the floor as a server that stopped listening.
 */
class FakeServer {
  deaf = false;
  failWrites = false;
  writes: Uint8Array[] = [];
  private readonly published = new Set<string>();

  constructor(private readonly gateway: FakeGateway) {}

  write = async (payload: Uint8Array): Promise<void> => {
    this.writes.push(payload);
    if (this.failWrites) {
      throw new Error('gateway refused the write');
    }
    const check = parseChatMessage(payload);
    if (this.deaf || !check.ok || this.published.has(check.message.id)) {
      return;
    }
    this.published.add(check.message.id);
    const seq = this.gateway.slots.size;
    this.gateway.writeRaw(seq, bytes({ v: 7, seq, at: 1759150000000 + seq, msg: check.message, history: null }));
  };
}

interface Harness {
  chat: SwarmChat;
  gateway: FakeGateway;
  server: FakeServer;
  events: Record<string, unknown[]>;
  received: () => MessageData[];
}

function harness(gateway = new FakeGateway(), settings = SETTINGS, parts: Partial<ChatParts> = {}): Harness {
  const server = new FakeServer(gateway);
  const chat = new SwarmChat(settings, {
    source: gateway,
    write: server.write,
    follower: { random: () => 1 },
    openRetryMs: [1_000, 2_000],
    ...parts,
  });
  const events: Record<string, unknown[]> = {};
  const { on } = chat.getEmitter();
  for (const event of Object.values(EVENTS)) {
    events[event] = [];
    on(event, (data: unknown) => events[event]!.push(data));
  }
  const received = () => events[EVENTS.MESSAGE_RECEIVED] as MessageData[];
  return { chat, gateway, server, events, received };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('start', () => {
  it('opens the chat, shows what is there, then follows it live', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    const { chat, events, received } = harness(gateway);

    await chat.start();
    expect(events[EVENTS.LOADING_INIT]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(10);
    expect(received().map((message) => message.index)).toEqual([0, 1]);
    expect(events[EVENTS.STATUS]).toEqual([FeedStatus.LIVE]);

    gateway.write(entryAt(2));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(received().map((message) => message.index)).toEqual([0, 1, 2]);
  });

  it('shows a message in 6.x field names, timed by the server', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0));
    const { chat, received } = harness(gateway);
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    const [message] = received();
    expect(message).toMatchObject({
      type: 'text',
      message: 'message 0',
      username: 'tester',
      timestamp: 1759140000000,
      index: 0,
      chatTopic: TOPIC,
    });
    expect(message).not.toHaveProperty('targetMessageId');
  });

  it('keeps trying to open, says reconnecting, and raises CRITICAL_ERROR on the third failure', async () => {
    const gateway = new FakeGateway();
    gateway.head = 'fail';
    const { chat, events } = harness(gateway);
    let opened = false;
    void chat.start().then(() => {
      opened = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events[EVENTS.STATUS]).toEqual([FeedStatus.RECONNECTING]);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect(events[EVENTS.CRITICAL_ERROR]).toHaveLength(1);
    expect(events[EVENTS.ERROR]).toHaveLength(3);

    gateway.head = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opened).toBe(true);
    expect(events[EVENTS.LOADING_INIT]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(10);
    expect(events[EVENTS.STATUS]).toEqual([FeedStatus.RECONNECTING, FeedStatus.LIVE]);
  });

  it('opens at once from slot 0 when the head lookup times out, with no critical error', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    gateway.head = 'timeout';
    const { chat, events, received } = harness(gateway);
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(events[EVENTS.LOADING_INIT]).toEqual([true, false]);
    expect(events[EVENTS.CRITICAL_ERROR]).toHaveLength(0);
    expect(events[EVENTS.ERROR]).toHaveLength(1);
    expect(received().map((message) => message.index)).toEqual([0, 1]);
  });

  it('opens once however often start is called', async () => {
    const { chat, gateway } = harness();
    await Promise.all([chat.start(), chat.start()]);
    await chat.start();
    expect(gateway.headReads).toBe(1);
  });

  it('never shows one message twice, even when two history files overlap', async () => {
    const gateway = new FakeGateway();
    const row = (seq: number) => ({ seq, at: seq, msg: entryAt(seq).msg });
    const older = { v: 7, topic: TOPIC, fromSeq: 0, toSeq: 1, messages: [row(0), row(1)], prev: null };
    const newest = {
      v: 7,
      topic: TOPIC,
      fromSeq: 1,
      toSeq: 2,
      messages: [row(1), row(2)],
      prev: { ref: 'aa'.repeat(32), toSeq: 1 },
    };
    gateway.files.set('aa'.repeat(32), bytes(older));
    gateway.files.set('bb'.repeat(32), bytes(newest));
    gateway
      .write(entryAt(0))
      .write(entryAt(1))
      .write(entryAt(2))
      .write(entryAt(3, { ref: 'bb'.repeat(32), toSeq: 2 }));
    const { chat, received } = harness(gateway);
    await chat.start();
    await chat.fetchPreviousMessages();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(received().map((message) => message.index)).toEqual([1, 2, 0, 3]);
  });
});

describe('stop', () => {
  it('stops every poll and timer, and a start before the open resolves', async () => {
    const gateway = new FakeGateway();
    gateway.head = 'fail';
    const { chat } = harness(gateway);
    const starting = chat.start();
    await vi.advanceTimersByTimeAsync(0);
    await chat.stop();
    await starting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.headReads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('may come before start, twice, and start works after it', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0));
    const { chat, received } = harness(gateway);
    await chat.stop();
    await chat.stop();
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(received()).toHaveLength(1);
  });

  it('keeps its listeners, so a chat started again reports to them', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0));
    const { chat, received } = harness(gateway);
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    await chat.stop();
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(received().map((message) => message.index)).toEqual([0, 0]);
  });

  it('cancels a resend of a message still pending', async () => {
    const { chat, server } = harness();
    server.deaf = true;
    await chat.start();
    await chat.sendMessage('hello', MessageType.TEXT);
    await chat.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sendMessage', () => {
  it('reports a message pending, written, then received once the feed shows it, and writes it once', async () => {
    const { chat, server, events, received } = harness();
    await chat.start();
    const pending = await chat.sendMessage('hello', MessageType.TEXT);
    expect(pending).toMatchObject({ message: 'hello', index: -1, address: chat.getAddress() });
    expect(events[EVENTS.MESSAGE_REQUEST_INITIATED]).toEqual([pending]);

    await vi.advanceTimersByTimeAsync(0);
    expect(events[EVENTS.MESSAGE_REQUEST_UPLOADED]).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(received()).toEqual([expect.objectContaining({ id: pending!.id, index: 0 })]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.writes).toHaveLength(1);
    expect(events[EVENTS.MESSAGE_REQUEST_ERROR]).toHaveLength(0);
  });

  it('sends a thread reply with its parent as target', async () => {
    const { chat, server } = harness();
    await chat.start();
    await chat.sendMessage('a reply', MessageType.THREAD, 'a1'.repeat(16));
    const check = parseChatMessage(server.writes[0]!);
    expect(check.ok && check.message).toMatchObject({ type: 'thread', target: 'a1'.repeat(16) });
  });

  it('merges quick taps on one reaction into one net toggle', async () => {
    const { chat, server } = harness();
    await chat.start();
    const target = 'a1'.repeat(16);
    expect(await chat.sendMessage('👍', MessageType.REACTION, target)).toBeNull();
    await chat.sendMessage('👍', MessageType.REACTION, target);
    await chat.sendMessage('👍', MessageType.REACTION, target);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.writes).toHaveLength(1);
  });

  it('refuses a message with no nickname, sending nothing', async () => {
    const { chat, server } = harness(new FakeGateway(), { ...SETTINGS, user: { ...SETTINGS.user, nickname: '' } });
    await chat.start();
    await expect(chat.sendMessage('hello', MessageType.TEXT)).rejects.toBeInstanceOf(ChatMessageError);
    expect(server.writes).toHaveLength(0);
  });

  it('fails a message the server never shows, and a retry sends the same bytes', async () => {
    const { chat, server, events } = harness();
    server.deaf = true;
    await chat.start();
    const pending = await chat.sendMessage('hello', MessageType.TEXT);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events[EVENTS.MESSAGE_REQUEST_ERROR]).toEqual([pending]);
    expect(server.writes).toHaveLength(6);

    server.deaf = false;
    expect(chat.retrySendMessage(pending!)).toBe(true);
    expect(server.writes[6]).toEqual(server.writes[0]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events[EVENTS.MESSAGE_RECEIVED]).toEqual([expect.objectContaining({ id: pending!.id })]);
  });

  it('never fails a message the server published while this reader could not see the feed', async () => {
    const { chat, gateway, events } = harness();
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    gateway.down = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const pending = await chat.sendMessage('hello', MessageType.TEXT);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events[EVENTS.MESSAGE_REQUEST_ERROR]).toHaveLength(0);

    gateway.down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events[EVENTS.MESSAGE_RECEIVED]).toEqual([expect.objectContaining({ id: pending!.id })]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events[EVENTS.MESSAGE_REQUEST_ERROR]).toHaveLength(0);
  });

  it('sends nothing to a feed of its own, only the one inbox write per attempt', async () => {
    const { chat, server, gateway } = harness();
    await chat.start();
    await chat.sendMessage('hello', MessageType.TEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.writes).toHaveLength(1);
    expect(gateway.slots.size).toBe(1);
  });
});

describe('fetchPreviousMessages', () => {
  it('shows the file before the oldest shown, and says when there is no more', async () => {
    const gateway = new FakeGateway();
    const older = {
      v: 7,
      topic: TOPIC,
      fromSeq: 0,
      toSeq: 0,
      messages: [{ seq: 0, at: 1, msg: entryAt(0).msg }],
      prev: null,
    };
    const newest = {
      v: 7,
      topic: TOPIC,
      fromSeq: 1,
      toSeq: 1,
      messages: [{ seq: 1, at: 2, msg: entryAt(1).msg }],
      prev: { ref: 'aa'.repeat(32), toSeq: 0 },
    };
    gateway.files.set('aa'.repeat(32), bytes(older));
    gateway.files.set('bb'.repeat(32), bytes(newest));
    gateway
      .write(entryAt(0))
      .write(entryAt(1))
      .write(entryAt(2, { ref: 'bb'.repeat(32), toSeq: 1 }));
    const { chat, events, received } = harness(gateway);

    await chat.start();
    expect(chat.hasPreviousMessages()).toBe(true);
    const shown = await chat.fetchPreviousMessages();
    expect(shown.map((message) => message.index)).toEqual([0]);
    expect(events[EVENTS.LOADING_PREVIOUS_MESSAGES]).toEqual([true, false]);
    expect(chat.hasPreviousMessages()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(
      received()
        .map((message) => message.index)
        .sort(),
    ).toEqual([0, 1, 2]);
  });
});

describe('orderMessages', () => {
  it('orders published messages by their place in the chat, then pending ones by time', () => {
    const { chat } = harness();
    const ordered = chat.orderMessages([
      { index: -1, timestamp: 5 },
      { index: 2, timestamp: 1 },
      { index: -1, timestamp: 3 },
      { index: 0, timestamp: 9 },
    ]);
    expect(ordered).toEqual([
      { index: 0, timestamp: 9 },
      { index: 2, timestamp: 1 },
      { index: -1, timestamp: 3 },
      { index: -1, timestamp: 5 },
    ]);
  });
});

describe('a listener that throws', () => {
  it('never stops the chat or the listeners after it', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    const { chat, received } = harness(gateway);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    chat.getEmitter().on(EVENTS.MESSAGE_RECEIVED, () => {
      throw new Error('a broken view');
    });
    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(received()).toHaveLength(2);
    quiet.mockRestore();
  });
});

describe('a chat whose server writes notes', () => {
  it('opens from the newest note, follows by notes on its slot length, and never asks for the head or the next slot', async () => {
    vi.setSystemTime(1759140000000);
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    const slot = Math.floor(Date.now() / 1_000);
    gateway.writeNote(slot - 3, 1, Date.now() - 2_000);
    const { chat, received } = harness(gateway, { ...SETTINGS, infra: { ...SETTINGS.infra, noteSlotMs: 1_000 } });

    await chat.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(received().map((message) => message.index)).toEqual([0, 1]);
    expect(gateway.headReads).toBe(0);

    gateway.write(entryAt(2));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(received()).toHaveLength(2);
    gateway.writeNote(Math.floor(Date.now() / 1_000), 2, Date.now());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(received().map((message) => message.index)).toEqual([0, 1, 2]);
    expect(gateway.slotReads).not.toContain(3);
    await chat.stop();
  });
});
