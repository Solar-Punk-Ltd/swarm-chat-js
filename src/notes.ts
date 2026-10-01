import {
  DEFAULT_NOTE_HEARTBEAT_MS,
  DEFAULT_NOTE_SLOT_MS,
  noteSlotEnd,
  noteSlotOf,
  parseSlotNote,
  type SlotNote,
} from './message/index.js';
import { UnreadableSlotError, type ChatSource } from './swarm.js';

export interface NoteSettings {
  /** The length of a time slot. Must be the server's, since it is part of every note's address. */
  slotMs: number;
  /** The longest the server goes without a note while a chat is active. Must be the server's. */
  heartbeatMs: number;
  /** How long after a slot ends, by the server's clock, its note is asked for. */
  marginMs: number;
  /** Notes read at once when looking back over several slots, newest first. */
  scanBatch: number;
  /** The furthest the clock correction goes either way. */
  clockLimitMs: number;
}

export const DEFAULT_NOTE_SETTINGS: NoteSettings = {
  slotMs: DEFAULT_NOTE_SLOT_MS,
  heartbeatMs: DEFAULT_NOTE_HEARTBEAT_MS,
  marginMs: 1_000,
  scanBatch: 4,
  clockLimitMs: 5 * 60_000,
};

/** A note that was found, and the time slot it was found at. */
export interface FoundNote {
  slot: number;
  note: SlotNote;
}

export type NoteSource = Required<Pick<ChatSource, 'readNote'>>;

/** Whether a source can read notes, which a source written before notes existed cannot. */
export function readsNotes(source: ChatSource): source is ChatSource & NoteSource {
  return typeof source.readNote === 'function';
}

/**
 * How far this viewer's clock runs ahead of the server's, in milliseconds, as far as reads can tell. A negative value
 * is a clock that runs behind.
 *
 * Reads can only bound it from above. Whatever the server stamped, a note's `writtenAt` or an entry's `at`, it stamped
 * before this viewer received it, so the viewer is at most `received - stamped` ahead. A read scheduled by this
 * viewer's own clock says nothing more, since the same clock decides when it is sent. Learning that a clock runs
 * ahead would need a read sent before the note existed, which is the request this whole scheme exists to avoid.
 *
 * So the correction trusts the local clock, `min(0, bound)`, which only ever moves a read earlier when the bound
 * proves the clock runs behind, and never makes a read early. Once notes stop being found for longer than the
 * heartbeat, the local clock is no longer trusted and every read waits out the whole bound. That is late by at most
 * the freshest read's own delay and never early.
 *
 * A clock that runs behind sees every stamp exactly as old as it expects, since it reads everything as late as it
 * runs behind, so no read proves it behind and its messages arrive that much late. Proving it would also take a read
 * of something not yet written by the viewer's own clock.
 */
export class ClockCorrection {
  private aheadAtMost = Number.POSITIVE_INFINITY;
  private trusted = true;

  constructor(private readonly limitMs: number) {}

  observe(stampedMs: number, receivedMs: number): void {
    this.aheadAtMost = Math.min(this.aheadAtMost, receivedMs - stampedMs);
  }

  /** Reads have stopped finding notes, which a clock that runs ahead of the server's explains. */
  distrust(): void {
    this.trusted = false;
  }

  get isTrusted(): boolean {
    return this.trusted;
  }

  get ms(): number {
    const bounded = Number.isFinite(this.aheadAtMost);
    const raw = this.trusted || !bounded ? Math.min(0, this.aheadAtMost) : this.aheadAtMost;
    return Math.max(-this.limitMs, Math.min(this.limitMs, raw));
  }
}

/** Reads notes for the follower and the opening alike, so both share one clock correction and one count. */
export class NoteReader {
  readonly clock: ClockCorrection;
  /** Note reads that found a note, and those that found none, an unreadable chunk or a note that failed its check. */
  readonly counts = { found: 0, empty: 0 };
  readonly settings: NoteSettings;

  constructor(
    private readonly source: NoteSource,
    settings: Partial<NoteSettings>,
    readonly now: () => number,
  ) {
    this.settings = { ...DEFAULT_NOTE_SETTINGS, ...settings };
    this.clock = new ClockCorrection(this.settings.clockLimitMs);
  }

  /** The newest time slot whose note may be asked for at `now`: over, and the margin past, by the server's clock. */
  lastReadableSlot(now = this.now()): number {
    return noteSlotOf(now - this.settings.marginMs - this.clock.ms, this.settings.slotMs) - 1;
  }

  /** The local time from which slot `slot`'s note may be asked for. */
  readableAt(slot: number): number {
    return noteSlotEnd(slot, this.settings.slotMs) + this.settings.marginMs + this.clock.ms;
  }

  /** How many slots back a reader looks for a note: one heartbeat and two slots, the longest a note can be apart. */
  get lookBackSlots(): number {
    return Math.ceil(this.settings.heartbeatMs / this.settings.slotMs) + 2;
  }

  /** How long a follower goes without finding a note before it stops trusting its clock. */
  get silenceMs(): number {
    return this.settings.heartbeatMs + 2 * this.settings.slotMs + this.settings.marginMs;
  }

  /** One slot's note, or null when there is none to be had. Rejects only when the gateway fails. */
  async read(slot: number): Promise<SlotNote | null> {
    let payload: Uint8Array | null;
    try {
      payload = await this.source.readNote(slot);
    } catch (error) {
      if (!(error instanceof UnreadableSlotError)) {
        throw error;
      }
      payload = null;
    }
    const note = payload === null ? null : parseSlotNote(payload);
    if (note === null) {
      this.counts.empty++;
      return null;
    }
    this.counts.found++;
    this.clock.observe(note.writtenAt, this.now());
    return note;
  }

  /**
   * The newest note from slot `newest` back to slot `oldest`, read newest first, `scanBatch` at a time, stopping at
   * the first batch that finds one. A note names the newest feed slot written by then, so the newest note found is the
   * only one that matters.
   */
  async scan(newest: number, oldest: number): Promise<FoundNote | null> {
    for (let top = newest; top >= oldest; top -= this.settings.scanBatch) {
      const slots: number[] = [];
      for (let slot = top; slot > top - this.settings.scanBatch && slot >= oldest; slot--) {
        slots.push(slot);
      }
      const notes = await Promise.all(slots.map((slot) => this.read(slot)));
      const index = notes.findIndex((note) => note !== null);
      if (index >= 0) {
        return { slot: slots[index]!, note: notes[index]! };
      }
    }
    return null;
  }
}
