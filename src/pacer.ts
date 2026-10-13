/**
 * The shortest wait between two reads of one address that came back missing: three reads a minute at most.
 *
 * Bee answers the first few reads of a chunk it cannot find 404, and puts every peer it asked on a skip list for that
 * chunk for a minute (`ethersphere/bee`, `pkg/retrieval/retrieval.go`, `errSkip` and `skiplistDur = time.Minute`).
 * Once no peer is left it answers 500 at once, because "no peer left" is not `storage.ErrNotFound`
 * (`pkg/api/chunk.go`). A chunk written while its address is on that list stays unreadable on that node for up to a
 * minute. Measured on swarm-dev on 2026-10-12: an address read every second for 20 s and then written was readable
 * after 33 to 36 s, one nobody had asked for at once. About four reads of a missing address exhaust the list, so one
 * read every twenty seconds stays under it.
 */
export const DEFAULT_MISSING_READ_SPACING_MS = 20_000;

/**
 * Holds back a read of a slot whose address came back missing until `spacingMs` has passed since that answer. A slot
 * that was found, or never read, may be read at once. A follower keeps one for feed slots and a note reader one for
 * time slots.
 */
export class MissingReadPacer {
  private readonly missedAt = new Map<number, number>();

  constructor(
    private readonly spacingMs: number,
    private readonly now: () => number,
  ) {}

  /** The local time from which `slot` may be read again, which is in the past for an address not held back. */
  readableAt(slot: number, now = this.now()): number {
    const at = this.missedAt.get(slot);
    return at === undefined || this.expired(at, now) ? Number.NEGATIVE_INFINITY : at + this.spacingMs;
  }

  mayRead(slot: number, now = this.now()): boolean {
    return now >= this.readableAt(slot, now);
  }

  missed(slot: number, now = this.now()): void {
    for (const [held, at] of this.missedAt) {
      if (this.expired(at, now)) {
        this.missedAt.delete(held);
      }
    }
    this.missedAt.set(slot, now);
  }

  found(slot: number): void {
    this.missedAt.delete(slot);
  }

  clear(): void {
    this.missedAt.clear();
  }

  /** A miss recorded after `now` was recorded before the clock was set back, and holds nothing. */
  private expired(at: number, now: number): boolean {
    return at > now || now - at >= this.spacingMs;
  }
}
