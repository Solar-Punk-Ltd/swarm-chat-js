import type { NoteStart } from './follower.js';
import { parseFeedEntry, parseHistoryFile, type HistoryLink, type HistoryRow } from './message/index.js';
import type { NoteReader } from './notes.js';
import { HeadLookupTimeoutError, UnreadableSlotError, type ChatSource } from './swarm.js';

/** Where a chat's reading starts, and what it shows before the first poll. */
export interface Opening {
  /** The first feed index the follower reads. */
  startAt: number;
  /** Messages of the newest history file, oldest first. */
  rows: HistoryRow[];
  /** Where notes lead the follower from, or null when no note was found and the chat is followed by polling. */
  notes: NoteStart | null;
}

export interface HistoryEvents {
  /** Rows of a history file left out because they failed their checks. */
  skipped(count: number): void;
  /** A history file that could not be read. Opening goes on without it, and loading older messages offers it again. */
  error(error: unknown): void;
}

/**
 * Slots read back from Bee's head when the head entry itself cannot be read, looking for one that names the newest
 * history file. Past this the chat is opened from its first slot, which a chat of an event's size affords.
 */
const HEAD_SEARCH_DEPTH = 16;

/**
 * Opens a chat from the newest history file and the feed entries after it, and hands out older files one click at a
 * time.
 *
 * Opening reads the notes of the time slots just ended, newest first, back as far as one heartbeat, and the newest
 * note found names the newest feed slot, whose entry links the newest history file. That asks Bee for nothing that is
 * not written. Only when no note is found, which is a server that writes none, does opening ask Bee's head lookup
 * once, which itself asks for slots not yet written. A 404 there is not taken on its own, because Bee answers 404 for
 * a lookup that failed as well as for a feed with no update, so the chat is then read from slot 0, which is missing
 * only when the chat is empty.
 */
export class ChatHistory {
  private older: HistoryLink | null = null;
  private loading: Promise<HistoryRow[]> | null = null;

  constructor(
    private readonly source: ChatSource,
    private readonly topic: string,
    private readonly events: HistoryEvents,
    private readonly notes: NoteReader | null = null,
  ) {}

  /** Rejects when the gateway fails before anything was learned, so the caller can try again. */
  async open(): Promise<Opening> {
    this.older = null;
    const noted = await this.newestNote();
    if (noted !== null) {
      return this.openAt(noted.newest, noted);
    }
    const head = await this.readHead();
    if (head === null) {
      // Empty or a failed lookup, the walk starts at slot 0 either way, and its first poll reads slot 0, which is
      // the confirmation the contract asks for. An empty chat's first message lands there.
      return { startAt: 0, rows: [], notes: null };
    }
    return this.openAt(head.index, null, head.payload);
  }

  /** The newest note of the slots just ended, as where the follower starts, or null when there is none. */
  private async newestNote(): Promise<NoteStart | null> {
    if (this.notes === null) {
      return null;
    }
    const last = this.notes.lastReadableSlot();
    const found = await this.notes.scan(last, last - this.notes.lookBackSlots + 1);
    return found === null ? null : { newest: found.note.newest, nextNoteSlot: last + 1 };
  }

  /** Opens from the history file the entry at or below `headIndex` links, the head's payload when already read. */
  private async openAt(headIndex: number, notes: NoteStart | null, headPayload?: Uint8Array): Promise<Opening> {
    const link = headIndex < 0 ? null : await this.newestLink(headIndex, headPayload);
    if (link === null) {
      return { startAt: 0, rows: [], notes };
    }
    const rows = await this.readFile(link);
    if (rows === 'refused') {
      // A file that is not what its link names hides everything before it and every file behind its prev, so the
      // chat is read from slot 0 instead, the walk a failed head lookup takes.
      return { startAt: 0, rows: [], notes };
    }
    return { startAt: link.toSeq + 1, rows: rows ?? [], notes };
  }

  /**
   * The head, or null for a lookup that found nothing or ran out of time. Bee's head lookup has a floor of about a
   * second that grows with the feed, and was measured at 30 to 48 seconds on a loaded gateway, so a lookup that
   * outlives its timeout is read as nothing known and the chat is read from slot 0, which a chat of an event's size
   * affords. Waiting on it instead left a late joiner's chat unopened. A quick failure still rejects, so it is retried.
   */
  private async readHead(): Promise<{ index: number; payload: Uint8Array } | null> {
    try {
      return await this.source.readHead();
    } catch (error) {
      if (error instanceof HeadLookupTimeoutError) {
        this.events.error(error);
        return null;
      }
      throw error;
    }
  }

  /** Whether a click on "load older" has something to load. */
  hasOlder(): boolean {
    return this.older !== null;
  }

  /** The file before the oldest one shown, oldest first. Rejects when it cannot be read, and offers it again. */
  loadOlder(): Promise<HistoryRow[]> {
    this.loading ??= this.loadOlderOnce().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadOlderOnce(): Promise<HistoryRow[]> {
    const link = this.older;
    if (link === null) {
      return [];
    }
    const bytes = await this.source.readFile(link.ref);
    const check = parseHistoryFile(bytes, this.topic, link);
    if (!check.ok) {
      // A file that is not what its link names never will be, so it is not offered again.
      this.older = null;
      throw new Error(`history file ${link.ref} refused (${check.reason}): ${check.detail}`);
    }
    this.report(check.value.skipped);
    this.older = check.value.prev;
    return check.value.rows;
  }

  /**
   * The history link of the newest readable entry at or below the head, reading the head first when its payload is
   * not given. Null means no history file is named, so the chat is read from its first slot.
   */
  private async newestLink(headIndex: number, headPayload?: Uint8Array): Promise<HistoryLink | null> {
    const first = headPayload === undefined ? headIndex : headIndex - 1;
    if (headPayload !== undefined) {
      const head = parseFeedEntry(headPayload, headIndex, this.topic);
      if (head.ok) {
        return head.value.history;
      }
    }
    for (let index = first; index >= Math.max(0, headIndex - HEAD_SEARCH_DEPTH); index--) {
      const payload = await this.source.readSlot(index).catch((error: unknown) => {
        if (error instanceof UnreadableSlotError) {
          return null;
        }
        throw error;
      });
      if (payload === null) {
        continue;
      }
      const entry = parseFeedEntry(payload, index, this.topic);
      if (entry.ok) {
        return entry.value.history;
      }
    }
    return null;
  }

  /** The rows of the file `link` names, null when it could not be read now, or 'refused' when it fails its checks. */
  private async readFile(link: HistoryLink): Promise<HistoryRow[] | null | 'refused'> {
    try {
      const check = parseHistoryFile(await this.source.readFile(link.ref), this.topic, link);
      if (!check.ok) {
        this.events.error(new Error(`history file ${link.ref} refused (${check.reason}): ${check.detail}`));
        return 'refused';
      }
      this.report(check.value.skipped);
      this.older = check.value.prev;
      return check.value.rows;
    } catch (error) {
      // The live chat does not wait on its history: the file is offered again as "load older".
      this.events.error(error);
      this.older = link;
      return null;
    }
  }

  private report(skipped: number): void {
    if (skipped > 0) {
      this.events.skipped(skipped);
    }
  }
}
