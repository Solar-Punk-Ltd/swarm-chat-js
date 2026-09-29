import { parseFeedEntry, type FeedEntry, type ReadRefusal } from './message/index.js';
import { UnreadableSlotError, type ChatSource } from './swarm.js';

export const FeedStatus = {
  /** The gateway answers. The next slot may simply not be written yet, which is the ordinary state of a quiet chat. */
  LIVE: 'live',
  /** The gateway does not answer, and reads are being held off between retries. */
  RECONNECTING: 'reconnecting',
  /** The gateway answers, but a message known to exist has not loaded for a while. */
  STALLED: 'stalled',
} as const;

export type FeedStatus = (typeof FeedStatus)[keyof typeof FeedStatus];

/** Why a slot was not shown: its payload failed a check, or it was stepped past and the retry list was full. */
export type SkipReason = ReadRefusal | 'unreachable';

export interface FollowerSettings {
  pollIntervalMs: number;
  /** Slots one poll may walk before handing back, which only a viewer catching up on a backlog reaches. */
  maxSlotsPerPoll: number;
  /** Polls the next slot may be refused before asking whether anything lies behind it. */
  unservedPollsBeforeProbe: number;
  /** How far past a refused slot to look, stopping at the first that answers. */
  probeDistances: readonly number[];
  /** Stepped-past slots kept for reading again on later polls. */
  missedLimit: number;
  /** Stepped-past slots read again in one poll. */
  missedReadsPerPoll: number;
  backoffCapMs: number;
  /** How long a stepped-past slot may stay unread before the chat is called stalled. */
  stallAfterMs: number;
  random: () => number;
  now: () => number;
}

export const DEFAULT_FOLLOWER_SETTINGS: FollowerSettings = {
  pollIntervalMs: 1_000,
  maxSlotsPerPoll: 16,
  unservedPollsBeforeProbe: 3,
  probeDistances: [1, 2, 4, 8],
  missedLimit: 32,
  missedReadsPerPoll: 4,
  backoffCapMs: 8_000,
  stallAfterMs: 8_000,
  random: Math.random,
  now: Date.now,
};

export interface FollowerEvents {
  entry(entry: FeedEntry): void;
  skipped(index: number, reason: SkipReason, detail: string): void;
  status(status: FeedStatus): void;
  error(error: unknown): void;
}

/**
 * Follows a chat feed the way the video player follows its playlist feed: explicit slot reads after the last one
 * seen, several in one poll, until one is refused. A refused next slot is the live edge and is polled again. When it
 * keeps being refused, the follower looks a few slots past it, and a later slot that answers means the refused one is
 * a message no peer is giving out right now. That one is stepped past and kept on a short list to read again, so a
 * message skipped arrives late rather than never.
 */
export class FeedFollower {
  private next = 0;
  private unservedPolls = 0;
  private gatewayFailures = 0;
  private readonly missed = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private running = false;
  private status: FeedStatus | null = null;
  private readonly settings: FollowerSettings;

  constructor(
    private readonly source: ChatSource,
    private readonly topic: string,
    private readonly events: FollowerEvents,
    settings: Partial<FollowerSettings> = {},
  ) {
    this.settings = { ...DEFAULT_FOLLOWER_SETTINGS, ...settings };
  }

  /** The index of the next slot this follower will ask for. */
  get nextIndex(): number {
    return this.next;
  }

  get missedIndices(): number[] {
    return [...this.missed.keys()];
  }

  /** Starts polling at `fromIndex`, with the first poll at once. Starting again restarts from the new index. */
  start(fromIndex: number): void {
    this.stop();
    this.next = fromIndex;
    this.unservedPolls = 0;
    this.gatewayFailures = 0;
    this.running = true;
    this.schedule(0);
  }

  /** Cancels the next poll, and makes a poll in flight discard what it reads. */
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll(generation);
    }, delayMs);
  }

  private async poll(generation: number): Promise<void> {
    let walked = 0;
    let failed = false;
    try {
      walked = await this.walk(generation);
      await this.readMissed(generation);
    } catch (error) {
      failed = true;
      if (generation === this.generation) {
        this.gatewayFailed(error);
      }
    }
    if (generation !== this.generation || !this.running) {
      return;
    }
    if (failed) {
      this.schedule(this.backoffMs());
      return;
    }
    this.gatewayAnswered();
    this.schedule(walked >= this.settings.maxSlotsPerPoll ? 0 : this.settings.pollIntervalMs);
  }

  /** Reads forward from the next slot. Returns how many slots it consumed. Throws when the gateway fails. */
  /** A slot's payload, null when refused, or 'unreadable' when it was served and failed its own check. */
  private async read(index: number): Promise<Uint8Array | null | 'unreadable'> {
    try {
      return await this.source.readSlot(index);
    } catch (error) {
      if (error instanceof UnreadableSlotError) {
        return 'unreadable';
      }
      throw error;
    }
  }

  private async walk(generation: number): Promise<number> {
    for (let consumed = 0; consumed < this.settings.maxSlotsPerPoll; consumed++) {
      const index = this.next;
      const payload = await this.read(index);
      if (generation !== this.generation) {
        return consumed;
      }
      if (payload === 'unreadable') {
        this.unservedPolls = 0;
        this.next = index + 1;
        this.remember(index);
        continue;
      }
      if (payload === null) {
        // Counted only when this poll read nothing: a poll that read four slots and then met the live edge advanced.
        if (consumed === 0) {
          this.unservedPolls++;
          if (this.shouldProbe() && (await this.probePast(index, generation))) {
            continue;
          }
        }
        return consumed;
      }
      this.unservedPolls = 0;
      this.next = index + 1;
      this.accept(index, payload);
    }
    return this.settings.maxSlotsPerPoll;
  }

  /**
   * Probes at the threshold and then at doubling intervals, three, six, twelve polls and on. A quiet chat stays
   * refused for minutes, and probing each of those polls would cost four reads a poll to find nothing, while never
   * probing again would leave a hole that opened during the quiet undetected until a reload.
   */
  private shouldProbe(): boolean {
    const threshold = this.settings.unservedPollsBeforeProbe;
    if (this.unservedPolls < threshold || this.unservedPolls % threshold !== 0) {
      return false;
    }
    const multiple = this.unservedPolls / threshold;
    return (multiple & (multiple - 1)) === 0;
  }

  /**
   * Looks past a refused slot. Returns whether a later slot answered. The probe jumps, so the slots it jumped over
   * are read in order before the one that answered: each is shown if it loads and kept for later if it is refused
   * too, since every slot of a chat is a message of its own.
   */
  private async probePast(missing: number, generation: number): Promise<boolean> {
    const refused = new Set<number>([missing]);
    for (const distance of this.settings.probeDistances) {
      const found = missing + distance;
      const payload = await this.read(found);
      if (generation !== this.generation) {
        return false;
      }
      if (payload === null || payload === 'unreadable') {
        refused.add(found);
        continue;
      }
      this.unservedPolls = 0;
      this.remember(missing);
      for (let gap = missing + 1; gap < found; gap++) {
        const between = refused.has(gap) ? null : await this.read(gap);
        if (generation !== this.generation) {
          return false;
        }
        if (between === null || between === 'unreadable') {
          this.remember(gap);
        } else {
          this.accept(gap, between);
        }
      }
      this.next = found + 1;
      this.accept(found, payload);
      return true;
    }
    return false;
  }

  private remember(index: number): void {
    if (this.missed.has(index)) {
      return;
    }
    if (this.missed.size >= this.settings.missedLimit) {
      this.events.skipped(index, 'unreachable', 'stepped past with the retry list full');
      return;
    }
    this.missed.set(index, this.settings.now());
  }

  private async readMissed(generation: number): Promise<void> {
    const due = [...this.missed.keys()].slice(0, this.settings.missedReadsPerPoll);
    for (const index of due) {
      const payload = await this.read(index);
      if (generation !== this.generation) {
        return;
      }
      if (payload !== null && payload !== 'unreadable') {
        this.missed.delete(index);
        this.accept(index, payload);
      }
    }
  }

  private accept(index: number, payload: Uint8Array): void {
    const check = parseFeedEntry(payload, index, this.topic);
    if (check.ok) {
      this.events.entry(check.value);
    } else {
      this.events.skipped(index, check.reason, check.detail);
    }
  }

  private gatewayFailed(error: unknown): void {
    this.gatewayFailures++;
    this.setStatus(FeedStatus.RECONNECTING);
    this.events.error(error);
  }

  private gatewayAnswered(): void {
    this.gatewayFailures = 0;
    const now = this.settings.now();
    const stalled = [...this.missed.values()].some((since) => now - since >= this.settings.stallAfterMs);
    this.setStatus(stalled ? FeedStatus.STALLED : FeedStatus.LIVE);
  }

  /** Doubles from the poll interval up to the cap, and draws each wait from its upper half so viewers drift apart. */
  private backoffMs(): number {
    const { pollIntervalMs, backoffCapMs, random } = this.settings;
    const ceiling = Math.min(backoffCapMs, pollIntervalMs * 2 ** this.gatewayFailures);
    return ceiling / 2 + (random() * ceiling) / 2;
  }

  private setStatus(status: FeedStatus): void {
    if (status !== this.status) {
      this.status = status;
      this.events.status(status);
    }
  }
}
