import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedFollower, FeedStatus, type FollowerSettings, type SkipReason } from '../src/follower';
import type { FeedEntry } from '../src/message';

import { bytes, entryAt, FakeGateway, TOPIC } from './fakeGateway';

const POLL_MS = 500;

interface Run {
  gateway: FakeGateway;
  follower: FeedFollower;
  seqs: () => number[];
  skipped: { index: number; reason: SkipReason }[];
  statuses: string[];
  errors: unknown[];
}

function run(gateway: FakeGateway, settings: Partial<FollowerSettings> = {}): Run {
  const entries: FeedEntry[] = [];
  const skipped: Run['skipped'] = [];
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const follower = new FeedFollower(
    gateway,
    TOPIC,
    {
      entry: (entry) => entries.push(entry),
      skipped: (index, reason) => skipped.push({ index, reason }),
      status: (status) => statuses.push(status),
      error: (error) => errors.push(error),
    },
    { pollIntervalMs: POLL_MS, random: () => 1, now: () => Date.now(), ...settings },
  );
  return { gateway, follower, seqs: () => entries.map((entry) => entry.seq), skipped, statuses, errors };
}

function feedOf(count: number): FakeGateway {
  const gateway = new FakeGateway();
  for (let seq = 0; seq < count; seq++) {
    gateway.write(entryAt(seq));
  }
  return gateway;
}

describe.each([404, 500] as const)('with Bee answering %i for a slot not there', (absentStatus) => {
  beforeEach(() => {
    FakeGateway.absentStatus = absentStatus;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('walking', () => {
    it('reads every slot after the start, up to the live edge, in one poll', async () => {
      const { follower, seqs, statuses } = run(feedOf(5));
      follower.start(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([2, 3, 4]);
      expect(follower.nextIndex).toBe(5);
      expect(statuses).toEqual([FeedStatus.LIVE]);
    });

    it('reads at most sixteen slots a poll, and polls again at once while behind', async () => {
      const { follower, gateway, seqs } = run(feedOf(40));
      follower.start(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(seqs()).toHaveLength(40);
      expect(gateway.slotReads.filter((index) => index === 40)).toHaveLength(1);
    });

    it('treats a refused next slot as the live edge and polls it again', async () => {
      const { follower, gateway, seqs } = run(feedOf(1));
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([0]);

      gateway.write(entryAt(1));
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(seqs()).toEqual([0, 1]);
    });

    it('polls on the interval it was given', async () => {
      const { follower, gateway } = run(feedOf(0));
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(gateway.slotReads.filter((index) => index === 0)).toHaveLength(3);
    });
  });

  describe('a slot that fails its checks', () => {
    it.each<[string, Uint8Array, SkipReason]>([
      ['not JSON', new TextEncoder().encode('{'), 'not-json'],
      ['the wrong shape', bytes({ hello: 'world' }), 'shape'],
      ['another index', bytes(entryAt(9)), 'mismatch'],
    ])('is skipped and counted when it is %s, and never stops the walk', async (_case, payload, reason) => {
      const gateway = feedOf(3).writeRaw(1, payload);
      const { follower, seqs, skipped } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([0, 2]);
      expect(skipped).toEqual([{ index: 1, reason }]);
      expect(follower.nextIndex).toBe(3);
    });

    it('does not stop the walk when every slot is bad', async () => {
      const gateway = new FakeGateway();
      for (let seq = 0; seq < 5; seq++) {
        gateway.writeRaw(seq, bytes({ seq }));
      }
      const { follower, skipped } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(skipped).toHaveLength(5);
      expect(follower.nextIndex).toBe(5);
    });
  });

  describe('a slot no peer gives out while later ones exist', () => {
    it('is stepped past on the third poll that read nothing, and the slot behind it is shown', async () => {
      const gateway = feedOf(6);
      gateway.hidden.add(3);
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([0, 1, 2]);

      // The first poll read three slots before it was refused, so it advanced, and the count starts with the next.
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(seqs()).toEqual([0, 1, 2]);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(seqs()).toEqual([0, 1, 2, 4, 5]);
      expect(follower.missedIndices).toEqual([3]);
    });

    it('is read again on later polls and shown when it loads', async () => {
      const gateway = feedOf(6);
      gateway.hidden.add(3);
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(follower.missedIndices).toEqual([3]);

      gateway.hidden.delete(3);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(seqs()).toEqual([0, 1, 2, 4, 5, 3]);
      expect(follower.missedIndices).toEqual([]);
    });

    it('steps past a hole of several slots, keeping each of them', async () => {
      const gateway = feedOf(10);
      for (const index of [2, 3, 4, 5]) {
        gateway.hidden.add(index);
      }
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(follower.missedIndices).toEqual([2, 3, 4, 5]);
      expect(seqs()).toEqual([0, 1, 6, 7, 8, 9]);
    });

    it('shows, in order, a slot the probe jumped over that loads', async () => {
      const gateway = feedOf(10);
      for (const index of [2, 3, 4]) {
        gateway.hidden.add(index);
      }
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      // The probe read 3 and 4, refused, then 6, served. It reads 5, which it jumped over, before it shows 6.
      expect(follower.missedIndices).toEqual([2, 3, 4]);
      expect(seqs()).toEqual([0, 1, 5, 6, 7, 8, 9]);
    });

    it('calls the chat stalled while a stepped-past slot stays unread, and live once it loads', async () => {
      const gateway = feedOf(6);
      gateway.hidden.add(3);
      const { follower, statuses } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(statuses).toEqual([FeedStatus.LIVE]);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(statuses).toEqual([FeedStatus.LIVE, FeedStatus.STALLED]);

      gateway.hidden.delete(3);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(statuses).toEqual([FeedStatus.LIVE, FeedStatus.STALLED, FeedStatus.LIVE]);
    });

    it('reports a slot it cannot keep once the retry list is full', async () => {
      const gateway = feedOf(10);
      for (const index of [2, 3, 4]) {
        gateway.hidden.add(index);
      }
      const { follower, skipped, seqs } = run(gateway, { missedLimit: 2 });
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(follower.missedIndices).toEqual([2, 3]);
      expect(skipped).toEqual([{ index: 4, reason: 'unreachable' }]);
      expect(seqs()).toContain(5);
    });

    it('reads the retry list least recently tried first, so an entry behind four that never load is still read', async () => {
      const gateway = feedOf(12);
      for (let index = 2; index <= 7; index++) {
        gateway.hidden.add(index);
      }
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(new Set(follower.missedIndices)).toEqual(new Set([2, 3, 4, 5, 6, 7]));

      gateway.hidden.delete(7);
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(seqs()).toContain(7);
      expect(new Set(follower.missedIndices)).toEqual(new Set([2, 3, 4, 5, 6]));
    });

    it('lets go of a slot after five minutes unread, reports it, and is live again', async () => {
      const gateway = feedOf(6);
      gateway.hidden.add(3);
      const { follower, skipped, statuses } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(follower.missedIndices).toEqual([3]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statuses.at(-1)).toBe(FeedStatus.STALLED);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(follower.missedIndices).toEqual([]);
      expect(skipped).toEqual([{ index: 3, reason: 'unreachable' }]);
      expect(statuses.at(-1)).toBe(FeedStatus.LIVE);
      const readsOfThree = gateway.slotReads.filter((index) => index === 3).length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gateway.slotReads.filter((index) => index === 3)).toHaveLength(readsOfThree);
    });

    it('probes a long quiet live edge at least once a minute', async () => {
      const gateway = feedOf(1);
      const probedAt: number[] = [];
      const read = gateway.readSlot.bind(gateway);
      gateway.readSlot = (index) => {
        if (index === 2) {
          probedAt.push(Date.now());
        }
        return read(index);
      };
      const { follower } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const gaps = probedAt.slice(1).map((at, i) => at - probedAt[i]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
      expect(probedAt.length).toBeLessThan(30);
    });

    it('finds a hole that opens after a long quiet within a minute', async () => {
      const gateway = feedOf(1);
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(13 * 60_000);
      gateway.hidden.add(1);
      gateway.write(entryAt(1)).write(entryAt(2));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(seqs()).toEqual([0, 2]);
      expect(follower.missedIndices).toEqual([1]);
    });

    it('probes a quiet live edge at three, six, twelve and twenty-four refused polls, and no more often', async () => {
      const { follower, gateway } = run(feedOf(1));
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 30);
      const probes = gateway.slotReads.filter((index) => index === 2);
      expect(probes).toHaveLength(4);
    });
  });

  describe('a slot served with a chunk that fails its own check', () => {
    it('is stepped past through the probe, like a refused slot, kept for later, and the chat stays live', async () => {
      const gateway = feedOf(4);
      gateway.corrupt.add(1);
      const { follower, seqs, statuses } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([0]);
      expect(follower.nextIndex).toBe(1);

      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(seqs()).toEqual([0, 2, 3]);
      expect(follower.missedIndices).toEqual([1]);
      expect(statuses).toEqual([FeedStatus.LIVE]);

      gateway.corrupt.delete(1);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(seqs()).toEqual([0, 2, 3, 1]);
    });
  });

  describe('a gateway that answers every slot with a page that is not a chunk', () => {
    it('neither runs away nor climbs past the head, and says reconnecting after a few polls', async () => {
      const gateway = feedOf(4);
      gateway.servesPages = true;
      const { follower, statuses } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.slotReads.length).toBeLessThan(40);
      expect(follower.nextIndex).toBe(0);
      expect(follower.missedIndices).toEqual([]);
      expect(statuses.at(-1)).toBe(FeedStatus.RECONNECTING);

      gateway.servesPages = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(follower.nextIndex).toBe(4);
      expect(statuses.at(-1)).toBe(FeedStatus.LIVE);
    });
  });

  describe('a gateway that does not answer', () => {
    it('backs off doubling from the poll interval up to eight seconds, and says reconnecting', async () => {
      const gateway = feedOf(1);
      gateway.down = true;
      const { follower, statuses, errors } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses).toEqual([FeedStatus.RECONNECTING]);

      const readsAt = (ms: number) => {
        vi.advanceTimersByTime(ms);
        return gateway.slotReads.length;
      };
      expect(readsAt(999)).toBe(1);
      expect(readsAt(1)).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(readsAt(1_999)).toBe(2);
      expect(readsAt(1)).toBe(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(readsAt(4_000)).toBe(4);
      await vi.advanceTimersByTimeAsync(0);
      expect(readsAt(8_000)).toBe(5);
      await vi.advanceTimersByTimeAsync(0);
      expect(readsAt(7_999)).toBe(5);
      expect(readsAt(1)).toBe(6);
      expect(errors.length).toBeGreaterThanOrEqual(5);
    });

    it('draws each wait from the upper half of its ceiling', async () => {
      const gateway = feedOf(1);
      gateway.down = true;
      const { follower } = run(gateway, { random: () => 0 });
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(499);
      expect(gateway.slotReads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.slotReads).toHaveLength(2);
    });

    it('is live again, at the poll interval, once the gateway answers', async () => {
      const gateway = feedOf(1);
      gateway.down = true;
      const { follower, statuses, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(3_000);
      gateway.down = false;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(statuses).toEqual([FeedStatus.RECONNECTING, FeedStatus.LIVE]);
      expect(seqs()).toEqual([0]);
    });
  });

  describe('start and stop', () => {
    it('stops polling on stop, and leaves no timer behind', async () => {
      const { follower, gateway } = run(feedOf(1));
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      follower.stop();
      const reads = gateway.slotReads.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.slotReads).toHaveLength(reads);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('discards a read that lands after the stop', async () => {
      const gateway = feedOf(3);
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = gateway.readSlot.bind(gateway);
      gateway.readSlot = async (index) => {
        await slow;
        return read(index);
      };
      const { follower, seqs } = run(gateway);
      follower.start(0);
      await vi.advanceTimersByTimeAsync(0);
      follower.stop();
      release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seqs()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('can be stopped before it started, twice, and started again', async () => {
      const { follower, seqs } = run(feedOf(2));
      follower.stop();
      follower.stop();
      follower.start(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(seqs()).toEqual([1]);
    });
  });
});
