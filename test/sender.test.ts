import { PrivateKey } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatMessageError, MessageType, parseChatMessage, type ChatMessage } from '../src/message';
import { Sender, type GsocWrite, type SenderEvents } from '../src/sender';

// Test only.
const TEST_KEY = new PrivateKey('11'.repeat(32));
const TOPIC = 'chat-test';

interface Harness {
  sender: Sender;
  writes: Uint8Array[];
  events: { [K in keyof SenderEvents]: ChatMessage[] };
  answer: (outcome: 'ok' | Error) => void;
}

/** A sender whose writes resolve at once, unless `hold` is set, when each waits for `answer`. */
function harness(options: { hold?: boolean; fail?: boolean } = {}): Harness {
  const writes: Uint8Array[] = [];
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const write: GsocWrite = (payload) => {
    writes.push(payload);
    if (options.fail) {
      return Promise.reject(new Error('gateway refused'));
    }
    if (options.hold) {
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    }
    return Promise.resolve();
  };
  const events: Harness['events'] = { pending: [], written: [], failed: [], confirmed: [] };
  const sender = new Sender(TEST_KEY, 'tester', write, {
    pending: (message) => events.pending.push(message),
    written: (message) => events.written.push(message),
    failed: (message) => events.failed.push(message),
    confirmed: (message) => events.confirmed.push(message),
  });
  const answer = (outcome: 'ok' | Error) => {
    const next = waiting.shift();
    if (outcome === 'ok') {
      next?.resolve();
    } else {
      next?.reject(outcome);
    }
  };
  return { sender, writes, events, answer };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Sender.send', () => {
  it('writes the signed message once, straight away, and reports it pending then written', async () => {
    const { sender, writes, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });

    expect(events.pending).toEqual([message]);
    expect(writes).toHaveLength(1);
    expect(parseChatMessage(writes[0]!)).toEqual({ ok: true, message });

    await vi.advanceTimersByTimeAsync(0);
    expect(events.written).toEqual([message]);
    expect(sender.isPending(message.id)).toBe(true);
  });

  it('refuses a message the server would refuse, writing nothing', () => {
    const { sender, writes, events } = harness();
    expect(() => sender.send({ topic: TOPIC, type: MessageType.Text, text: '' })).toThrow(ChatMessageError);
    expect(writes).toHaveLength(0);
    expect(events.pending).toHaveLength(0);
  });

  it('resends the identical bytes every ten seconds until the feed shows it', async () => {
    const { sender, writes, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);

    sender.confirm(message);
    expect(events.confirmed).toEqual([message]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(2);
    expect(events.failed).toHaveLength(0);
    expect(sender.isPending(message.id)).toBe(false);
  });

  it('fails a message after five resends, ten seconds after the last', async () => {
    const { sender, writes, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });

    await vi.advanceTimersByTimeAsync(50_000);
    expect(writes).toHaveLength(6);
    expect(events.failed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.failed).toEqual([message]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(6);
  });

  it('keeps resending through write errors, and fails with the last error', async () => {
    const { sender, writes, events } = harness({ fail: true });
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(6);
    expect(events.written).toHaveLength(0);
    expect(events.failed).toEqual([message]);
  });

  it('waits for a slow write to settle before counting ten seconds', async () => {
    const { sender, writes, answer } = harness({ hold: true });
    sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(1);
    answer('ok');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(2);
  });

  it('reports written once, however many writes succeed', async () => {
    const { sender, events } = harness();
    sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.written).toHaveLength(1);
  });
});

describe('Sender.confirm', () => {
  it('ignores a message with this id from another address', async () => {
    const { sender, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    sender.confirm({ ...message, addr: '22'.repeat(20) });
    expect(events.confirmed).toHaveLength(0);
    expect(sender.isPending(message.id)).toBe(true);
  });

  it('ignores a message it never sent', () => {
    const { sender, events } = harness();
    const other = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'one' });
    sender.confirm({ ...other, id: 'f'.repeat(32) });
    expect(events.confirmed).toHaveLength(0);
  });

  it('still confirms a message that has already failed', async () => {
    const { sender, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    await vi.advanceTimersByTimeAsync(60_000);
    sender.confirm(message);
    expect(events.confirmed).toEqual([message]);
  });
});

describe('Sender.retry', () => {
  it('writes a failed message again with the same bytes and starts its resends over', async () => {
    const { sender, writes, events } = harness();
    const message = sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.failed).toHaveLength(1);

    expect(sender.retry(message.id)).toBe(true);
    expect(writes).toHaveLength(7);
    expect(writes[6]).toEqual(writes[0]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(writes).toHaveLength(12);
    expect(events.failed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.failed).toHaveLength(2);
  });

  it('does nothing for a message it no longer holds', () => {
    const { sender } = harness();
    expect(sender.retry('a'.repeat(32))).toBe(false);
  });
});

describe('Sender.react', () => {
  const target = 'a1'.repeat(16);

  it('sends one reaction when the window closes after one tap', async () => {
    const { sender, writes } = harness();
    sender.react(TOPIC, target, '👍');
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(1);
    const check = parseChatMessage(writes[0]!);
    expect(check.ok && check.message).toMatchObject({ type: 'reaction', target, text: '👍' });
  });

  it('sends nothing for an even number of taps, and one reaction for an odd number', async () => {
    const { sender, writes } = harness();
    sender.react(TOPIC, target, '👍');
    sender.react(TOPIC, target, '👍');
    sender.react(TOPIC, target, '🎉');
    sender.react(TOPIC, target, '🎉');
    sender.react(TOPIC, target, '🎉');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(1);
    const check = parseChatMessage(writes[0]!);
    expect(check.ok && check.message.text).toBe('🎉');
  });

  it('opens a new window for a tap after the last one closed', async () => {
    const { sender, writes } = harness();
    sender.react(TOPIC, target, '👍');
    await vi.advanceTimersByTimeAsync(1_000);
    sender.react(TOPIC, target, '👍');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(2);
  });
});

describe('Sender.stop', () => {
  it('cancels every resend and every open reaction window', async () => {
    const { sender, writes, events } = harness();
    sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    sender.react(TOPIC, 'a1'.repeat(16), '👍');
    sender.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toHaveLength(1);
    expect(events.failed).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules nothing when a write settles after the stop', async () => {
    const { sender, writes, answer } = harness({ hold: true });
    sender.send({ topic: TOPIC, type: MessageType.Text, text: 'hello' });
    sender.stop();
    answer('ok');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
