import { z } from 'zod';

import { chatMessageSchema, MESSAGE_VERSION } from './message.js';

/**
 * What the server writes: one feed entry per message at indices 0, 1, 2 and on, and one history file per chat that
 * the entries point to. The server builds these and the reader checks their shape. The reader does not check each
 * message's signature, because the server checked it before publishing.
 */

/** A feed entry is always one chunk, so bee-js never wraps it. */
export const MAX_ENTRY_BYTES = 4096;

const reference = z.string().regex(/^[0-9a-f]{64}([0-9a-f]{64})?$/, 'expected a 64 or 128 hex character reference');
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const historyLinkSchema = z.strictObject({
  ref: reference,
  toSeq: sequence,
});

export type HistoryLink = z.infer<typeof historyLinkSchema>;

export const feedEntrySchema = z.strictObject({
  v: z.literal(MESSAGE_VERSION),
  seq: sequence,
  at: sequence,
  msg: chatMessageSchema,
  history: historyLinkSchema.nullable(),
});

export type FeedEntry = z.infer<typeof feedEntrySchema>;

export const historyRowSchema = z.strictObject({
  seq: sequence,
  at: sequence,
  msg: chatMessageSchema,
});

export type HistoryRow = z.infer<typeof historyRowSchema>;

/** A row that fails its shape is left out and counted, so one bad row never hides the rest of the file. */
export const historyFileSchema = z
  .strictObject({
    v: z.literal(MESSAGE_VERSION),
    topic: z.string().min(1),
    fromSeq: sequence,
    toSeq: sequence,
    messages: z.array(z.unknown()),
    prev: historyLinkSchema.nullable(),
  })
  .refine((file) => file.fromSeq <= file.toSeq, { message: 'fromSeq is after toSeq', path: ['fromSeq'] });

export interface HistoryFile {
  topic: string;
  fromSeq: number;
  toSeq: number;
  rows: HistoryRow[];
  prev: HistoryLink | null;
  /** Rows left out because they failed their shape, lay outside fromSeq to toSeq, or belonged to another chat. */
  skipped: number;
}

export type ReadRefusal = 'not-utf8' | 'not-json' | 'shape' | 'mismatch';

export type ReadCheck<T> = { ok: true; value: T } | { ok: false; reason: ReadRefusal; detail: string };

const decoder = new TextDecoder('utf-8', { fatal: true });

function readJson(payload: Uint8Array): ReadCheck<unknown> {
  let text: string;
  try {
    text = decoder.decode(payload);
  } catch {
    return { ok: false, reason: 'not-utf8', detail: 'the payload is not valid UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'not-json', detail: 'the payload is not JSON' };
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join(', ');
}

/**
 * Reads the entry at feed index `index` of chat `topic`. An entry is refused when its `seq` is not that index or its
 * message belongs to another chat, since either would put a message in the wrong place.
 */
export function parseFeedEntry(payload: Uint8Array, index: number, topic: string): ReadCheck<FeedEntry> {
  const json = readJson(payload);
  if (!json.ok) {
    return json;
  }
  const shape = feedEntrySchema.safeParse(json.value);
  if (!shape.success) {
    return { ok: false, reason: 'shape', detail: describeIssues(shape.error) };
  }
  if (shape.data.seq !== index) {
    return { ok: false, reason: 'mismatch', detail: `seq ${shape.data.seq} at index ${index}` };
  }
  if (shape.data.msg.topic !== topic) {
    return { ok: false, reason: 'mismatch', detail: 'the message belongs to another chat' };
  }
  return { ok: true, value: shape.data };
}

/** Reads a history file of chat `topic` that `link` pointed to. */
export function parseHistoryFile(payload: Uint8Array, topic: string, link: HistoryLink): ReadCheck<HistoryFile> {
  const json = readJson(payload);
  if (!json.ok) {
    return json;
  }
  const shape = historyFileSchema.safeParse(json.value);
  if (!shape.success) {
    return { ok: false, reason: 'shape', detail: describeIssues(shape.error) };
  }
  if (shape.data.topic !== topic || shape.data.toSeq !== link.toSeq) {
    return { ok: false, reason: 'mismatch', detail: 'the file is not the one its link names' };
  }
  const { fromSeq, toSeq, prev } = shape.data;
  const rows: HistoryRow[] = [];
  let skipped = 0;
  for (const candidate of shape.data.messages) {
    const row = historyRowSchema.safeParse(candidate);
    if (row.success && row.data.seq >= fromSeq && row.data.seq <= toSeq && row.data.msg.topic === topic) {
      rows.push(row.data);
    } else {
      skipped++;
    }
  }
  return { ok: true, value: { topic, fromSeq, toSeq, rows, prev, skipped } };
}
