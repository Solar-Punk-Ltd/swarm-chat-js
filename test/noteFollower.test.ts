import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedFollower, FeedStatus, type FollowerSettings, type NoteStart } from '../src/follower';
import { ChatHistory } from '../src/history';
import { noteSlotEnd, noteSlotOf, type FeedEntry } from '../src/message';
import { ClockCorrection, NoteReader, type NoteSettings } from '../src/notes';

import { bytes, entryAt, FakeGateway, TOPIC } from './fakeGateway';

const SLOT_MS = 2_000;
const MARGIN_MS = 1_000;
const HEARTBEAT_MS = 30_000;
/** The start of a time slot, so every test begins at a slot boundary. */
const T0 = 1759140000000;
const S0 = noteSlotOf(T0, SLOT_MS);
const NOTES: Partial<NoteSettings> = { slotMs: SLOT_MS, marginMs: MARGIN_MS, heartbeatMs: HEARTBEAT_MS, scanBatch: 4 };

interface Run {
  gateway: FakeGateway;
  follower: FeedFollower;
  notes: NoteReader;
  seqs: () => number[];
  statuses: string[];
}

/** A follower whose clock runs `aheadMs` ahead of the gateway's, which is the server's. */
function run(gateway: FakeGateway, aheadMs = 0, settings: Partial<FollowerSettings> = {}): Run {
  const entries: FeedEntry[] = [];
  const statuses: string[] = [];
  const now = () => Date.now() + aheadMs;
  const notes = new NoteReader(gateway, NOTES, now);
  const follower = new FeedFollower(
    gateway,
    TOPIC,
    {
      entry: (entry) => entries.push(entry),
      skipped: () => {},
      status: (status) => statuses.push(status),
      error: () => {},
    },
    { pollIntervalMs: 1_000, random: () => 1, now, ...settings },
    notes,
  );
  return { gateway, follower, notes, seqs: () => entries.map((entry) => entry.seq), statuses };
}

/**
 * The chat server as the gateway sees it: each message lands in the next feed slot, stamped with the server's clock,
 * and once a slot ends in which one landed, or a heartbeat has passed, it writes that slot's note.
 */
class NoteServer {
  newest = -1;
  private noted = -2;
  private lastNoteAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly gateway: FakeGateway) {}

  start(): this {
    const tick = () => {
      const now = Date.now();
      const ended = noteSlotOf(now, SLOT_MS) - 1;
      if (this.newest > this.noted || now - this.lastNoteAt >= HEARTBEAT_MS) {
        this.gateway.writeNote(ended, this.newest, now);
        this.noted = this.newest;
        this.lastNoteAt = now;
      }
      this.timer = setTimeout(tick, noteSlotEnd(noteSlotOf(Date.now(), SLOT_MS), SLOT_MS) - Date.now());
    };
    this.timer = setTimeout(tick, noteSlotEnd(noteSlotOf(Date.now(), SLOT_MS), SLOT_MS) - Date.now());
    return this;
  }

  publish(): number {
    this.newest++;
    this.gateway.writeRaw(this.newest, bytes({ ...entryAt(this.newest), at: Date.now() }));
    return this.newest;
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}

/** Whether every note read asked for a slot that was over, plus the margin, by the server's clock. */
function readsNeverEarly(gateway: FakeGateway, from = 0): boolean {
  return gateway.noteReads.slice(from).every((read) => read.at >= noteSlotEnd(read.slot, SLOT_MS) + MARGIN_MS);
}

const startAt = (newest: number, nextNoteSlot = S0): NoteStart => ({ newest, nextNoteSlot });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('following led by notes', () => {
  it('asks for each slot note once, when the slot is over plus the margin, and no feed slot in a quiet chat', async () => {
    const { follower, gateway } = run(new FakeGateway());
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS - 1);
    expect(gateway.noteReads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.noteReads.map((read) => read.slot)).toEqual([S0]);
    await vi.advanceTimersByTimeAsync(60_000);
    const slots = gateway.noteReads.map((read) => read.slot);
    expect(slots).toEqual(Array.from({ length: slots.length }, (_, i) => S0 + i));
    expect(slots).toHaveLength(31);
    expect(gateway.slotReads).toEqual([]);
    follower.stop();
  });

  it('reads the feed slots a note names, and never a slot past the newest one named', async () => {
    const gateway = new FakeGateway();
    for (let seq = 0; seq <= 5; seq++) {
      gateway.write(entryAt(seq));
    }
    gateway.writeNote(S0, 3, T0 + SLOT_MS);
    const { follower, seqs, statuses } = run(gateway);
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(seqs()).toEqual([0, 1, 2, 3]);
    expect(Math.max(...gateway.slotReads)).toBe(3);
    expect(statuses).toEqual([FeedStatus.LIVE]);

    await vi.advanceTimersByTimeAsync(10 * SLOT_MS);
    expect(Math.max(...gateway.slotReads)).toBe(3);

    gateway.writeNote(S0 + 11, 5, T0 + 12 * SLOT_MS);
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(seqs()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(gateway.slotReads).not.toContain(6);
    follower.stop();
  });

  it('starts from the newest slot the opening found, reading nothing up to it again', async () => {
    const gateway = new FakeGateway();
    for (let seq = 0; seq <= 4; seq++) {
      gateway.write(entryAt(seq));
    }
    const { follower, seqs } = run(gateway);
    follower.start(3, startAt(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(seqs()).toEqual([3, 4]);
    expect(gateway.slotReads).toEqual([3, 4]);
    follower.stop();
  });

  it('puts a slot a note named that does not load on the retry list, and shows it once it loads', async () => {
    const gateway = new FakeGateway();
    for (let seq = 0; seq <= 3; seq++) {
      gateway.write(entryAt(seq));
    }
    gateway.hidden.add(1);
    gateway.writeNote(S0, 3, T0 + SLOT_MS);
    const { follower, seqs } = run(gateway);
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(seqs()).toEqual([0, 2, 3]);
    expect(follower.missedIndices).toEqual([1]);

    gateway.hidden.delete(1);
    await vi.advanceTimersByTimeAsync(SLOT_MS);
    expect(seqs()).toEqual([0, 2, 3, 1]);
    expect(follower.missedIndices).toEqual([]);
    follower.stop();
  });

  it('treats a note that fails its check as no note, and counts it with the empty ones', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0));
    gateway.notes.set(S0, bytes({ v: 1, newest: 0, writtenAt: T0, extra: 1 }));
    const { follower, notes } = run(gateway);
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(gateway.slotReads).toEqual([]);
    expect(notes.counts).toEqual({ found: 0, empty: 1 });
    follower.stop();
  });

  it('asks the same note again after the gateway failed, with the backoff, and says reconnecting meanwhile', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0));
    gateway.writeNote(S0, 0, T0 + SLOT_MS);
    gateway.notesDown = true;
    const { follower, seqs, statuses } = run(gateway);
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(statuses).toEqual([FeedStatus.LIVE, FeedStatus.RECONNECTING]);
    gateway.notesDown = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seqs()).toEqual([0]);
    expect(gateway.noteReads.map((read) => read.slot)).toEqual([S0, S0 + 1, S0]);
    expect(statuses).toEqual([FeedStatus.LIVE, FeedStatus.RECONNECTING, FeedStatus.LIVE]);
    follower.stop();
  });

  it('catches up after a hidden tab the way an opening does: newest first, stopping at the first note found', async () => {
    const gateway = new FakeGateway();
    for (let seq = 0; seq <= 4; seq++) {
      gateway.write(entryAt(seq));
    }
    gateway.writeNote(S0 + 2, 2, T0 + 3 * SLOT_MS).writeNote(S0 + 7, 4, T0 + 8 * SLOT_MS);
    const { follower, seqs } = run(gateway);
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(0);
    // The timer due at the first slot's end fires twenty seconds late, as a hidden tab's does.
    vi.setSystemTime(T0 + 20_000);
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(gateway.noteReads.map((read) => read.slot)).toEqual([S0 + 10, S0 + 9, S0 + 8, S0 + 7]);
    expect(seqs()).toEqual([0, 1, 2, 3, 4]);
    follower.stop();
  });

  it('looks back no further than a heartbeat and two slots when catching up', async () => {
    const { follower, gateway, notes } = run(new FakeGateway());
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T0 + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS);
    expect(gateway.noteReads).toHaveLength(notes.lookBackSlots);
    expect(notes.lookBackSlots).toBe(HEARTBEAT_MS / SLOT_MS + 2);
    follower.stop();
  });

  it('leaves no timer behind after stop', async () => {
    const { follower } = run(new FakeGateway());
    follower.start(0, startAt(-1));
    await vi.advanceTimersByTimeAsync(10_000);
    follower.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('following a server that writes no notes', () => {
  it('polls the next slot as before, and is led by notes from the first note it finds', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    const { follower, seqs } = run(gateway);
    follower.start(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seqs()).toEqual([0, 1]);
    expect(gateway.slotReads.filter((index) => index === 2).length).toBeGreaterThan(1);
    expect(follower.ledByNotes).toBe(false);

    const now = Date.now();
    gateway.writeNote(noteSlotOf(now, SLOT_MS), 1, now);
    await vi.advanceTimersByTimeAsync(2 * SLOT_MS);
    expect(follower.ledByNotes).toBe(true);
    const readsOfTwo = gateway.slotReads.filter((index) => index === 2).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gateway.slotReads.filter((index) => index === 2).length).toBe(readsOfTwo);
    follower.stop();
  });
});

describe('the opening', () => {
  const FILE = 'aa'.repeat(32);

  function history(gateway: FakeGateway, notes: NoteReader | null) {
    return new ChatHistory(gateway, TOPIC, { error: () => {}, skipped: () => {} }, notes);
  }

  it('finds the newest note of the slots just ended, newest first, and asks for no head lookup', async () => {
    const gateway = new FakeGateway();
    gateway.files.set(
      FILE,
      bytes({
        v: 7,
        topic: TOPIC,
        fromSeq: 0,
        toSeq: 1,
        messages: [0, 1].map((seq) => ({ seq, at: entryAt(seq).at, msg: entryAt(seq).msg })),
        prev: null,
      }),
    );
    for (let seq = 0; seq <= 3; seq++) {
      gateway.write(entryAt(seq, seq >= 2 ? { ref: FILE, toSeq: 1 } : null));
    }
    vi.setSystemTime(T0 + 20 * SLOT_MS + MARGIN_MS);
    const last = S0 + 19;
    gateway.writeNote(last - 5, 3, T0 + 15 * SLOT_MS);
    gateway.writeNote(last - 9, 2, T0 + 11 * SLOT_MS);
    const notes = new NoteReader(gateway, NOTES, () => Date.now());
    const opening = await history(gateway, notes).open();

    expect(opening.notes).toEqual({ newest: 3, nextNoteSlot: last + 1 });
    expect(opening.startAt).toBe(2);
    expect(opening.rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(gateway.headReads).toBe(0);
    expect(gateway.slotReads).toEqual([3]);
    expect(gateway.noteReads.map((read) => read.slot)).toEqual([
      last,
      last - 1,
      last - 2,
      last - 3,
      last - 4,
      last - 5,
      last - 6,
      last - 7,
    ]);
  });

  it('opens a chat whose note says nothing is written yet at slot 0, reading no feed slot', async () => {
    const gateway = new FakeGateway();
    gateway.writeNote(S0, -1, T0 + SLOT_MS);
    vi.setSystemTime(T0 + 2 * SLOT_MS + MARGIN_MS);
    const opening = await history(gateway, new NoteReader(gateway, NOTES, () => Date.now())).open();
    expect(opening).toEqual({ startAt: 0, rows: [], notes: { newest: -1, nextNoteSlot: S0 + 2 } });
    expect(gateway.slotReads).toEqual([]);
    expect(gateway.headReads).toBe(0);
  });

  it('falls back to the head lookup when no note is found, as a server without notes needs', async () => {
    const gateway = new FakeGateway();
    gateway.write(entryAt(0)).write(entryAt(1));
    const notes = new NoteReader(gateway, NOTES, () => Date.now());
    const opening = await history(gateway, notes).open();
    expect(opening).toEqual({ startAt: 0, rows: [], notes: null });
    expect(gateway.headReads).toBe(1);
    expect(gateway.noteReads).toHaveLength(notes.lookBackSlots);
  });
});

describe('the clock', () => {
  it('learns from a note stamped later than it was received that this clock runs behind, and reads sooner', () => {
    const clock = new ClockCorrection(5 * 60_000);
    clock.observe(T0 + 10_000, T0);
    expect(clock.ms).toBe(-10_000);
    clock.observe(T0 + 5_000, T0 + 6_000);
    expect(clock.ms).toBe(-10_000);
  });

  it('trusts the local clock while notes are found, and waits out the whole bound once they stop', () => {
    const clock = new ClockCorrection(5 * 60_000);
    clock.observe(T0, T0 + 4_200);
    expect(clock.ms).toBe(0);
    clock.distrust();
    expect(clock.ms).toBe(4_200);
  });

  it('never goes past its limit, either way, and ignores a distrust with nothing to bound it', () => {
    const clock = new ClockCorrection(60_000);
    clock.distrust();
    expect(clock.ms).toBe(0);
    clock.observe(T0 + 10 * 60_000, T0);
    expect(clock.ms).toBe(-60_000);
    const ahead = new ClockCorrection(60_000);
    ahead.observe(T0, T0 + 10 * 60_000);
    ahead.distrust();
    expect(ahead.ms).toBe(60_000);
  });

  it('a clock 3 s ahead stops reading notes too early once a heartbeat passes with none, and misses no message', async () => {
    const gateway = new FakeGateway();
    const server = new NoteServer(gateway).start();
    server.publish();
    await vi.advanceTimersByTimeAsync(4 * SLOT_MS);
    const { follower, notes, seqs } = run(gateway, 3_000);
    const opening = await new ChatHistory(gateway, TOPIC, { error: () => {}, skipped: () => {} }, notes).open();
    follower.start(opening.startAt, opening.notes);

    for (let second = 0; second < 120; second += 7) {
      server.publish();
      await vi.advanceTimersByTimeAsync(7_000);
    }
    await vi.advanceTimersByTimeAsync(40_000);
    expect(notes.clock.isTrusted).toBe(false);
    expect(notes.clock.ms).toBeGreaterThanOrEqual(3_000);
    expect(seqs()).toEqual(Array.from({ length: server.newest + 1 }, (_, i) => i));

    const before = gateway.noteReads.length;
    server.publish();
    await vi.advanceTimersByTimeAsync(SLOT_MS + MARGIN_MS + notes.clock.ms);
    expect(readsNeverEarly(gateway, before)).toBe(true);
    expect(seqs().at(-1)).toBe(server.newest);
    follower.stop();
    server.stop();
  });

  it('a clock minutes ahead finds no note when opening, polls as before, and is led by notes after a heartbeat', async () => {
    const gateway = new FakeGateway();
    const server = new NoteServer(gateway).start();
    server.publish();
    await vi.advanceTimersByTimeAsync(4 * SLOT_MS);
    const { follower, notes, seqs } = run(gateway, 3 * 60_000);
    const opening = await new ChatHistory(gateway, TOPIC, { error: () => {}, skipped: () => {} }, notes).open();
    expect(opening.notes).toBeNull();
    follower.start(opening.startAt, opening.notes);

    for (let second = 0; second < 90; second += 5) {
      server.publish();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(follower.ledByNotes).toBe(true);
    expect(notes.clock.ms).toBeGreaterThanOrEqual(3 * 60_000);
    expect(seqs()).toEqual(Array.from({ length: server.newest + 1 }, (_, i) => i));
    follower.stop();
    server.stop();
  });

  it('a clock minutes behind never reads a note early and shows every message, as late as it runs behind', async () => {
    const gateway = new FakeGateway();
    const server = new NoteServer(gateway).start();
    for (let i = 0; i < 40; i++) {
      server.publish();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const { follower, notes, seqs } = run(gateway, -2 * 60_000);
    const opening = await new ChatHistory(gateway, TOPIC, { error: () => {}, skipped: () => {} }, notes).open();
    expect(opening.notes).not.toBeNull();
    follower.start(opening.startAt, opening.notes);
    const published = server.newest;
    for (let i = 0; i < 10; i++) {
      server.publish();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2 * SLOT_MS + MARGIN_MS);
    expect(readsNeverEarly(gateway)).toBe(true);
    expect(seqs().at(-1)).toBe(server.newest);
    expect(seqs().filter((seq) => seq > published)).toHaveLength(10);
    follower.stop();
    server.stop();
  });
});
