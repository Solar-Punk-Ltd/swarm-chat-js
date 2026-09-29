import { describe, expect, it } from 'vitest';

import { ChatHistory } from '../src/history';
import type { HistoryLink } from '../src/message';

import { bytes, entryAt, FakeGateway, testMessage, TOPIC } from './fakeGateway';

const FILE_A = 'aa'.repeat(32);
const FILE_B = 'bb'.repeat(32);

/** A history file of the rows fromSeq to toSeq, as the server saves it. */
function file(fromSeq: number, toSeq: number, prev: HistoryLink | null) {
  const messages = [];
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    messages.push({ seq, at: 1759140000000 + seq, msg: testMessage(`message ${seq}`) });
  }
  return { v: 7, topic: TOPIC, fromSeq, toSeq, messages, prev };
}

function open(gateway: FakeGateway) {
  const errors: unknown[] = [];
  const skipped: number[] = [];
  const history = new ChatHistory(gateway, TOPIC, {
    error: (error) => errors.push(error),
    skipped: (count) => skipped.push(count),
  });
  return { history, errors, skipped };
}

/** Two files, B the newest (seq 3 to 5) pointing back to A (seq 0 to 2), and entries 0 to 7 naming B from seq 6. */
function twoFileChat(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.files.set(FILE_A, bytes(file(0, 2, null)));
  gateway.files.set(FILE_B, bytes(file(3, 5, { ref: FILE_A, toSeq: 2 })));
  for (let seq = 0; seq <= 7; seq++) {
    gateway.write(entryAt(seq, seq >= 6 ? { ref: FILE_B, toSeq: 5 } : null));
  }
  return gateway;
}

describe('ChatHistory.open', () => {
  it('shows the newest history file and starts reading after its last message', async () => {
    const gateway = twoFileChat();
    const { history } = open(gateway);
    const opening = await history.open();
    expect(opening.startAt).toBe(6);
    expect(opening.rows.map((row) => row.seq)).toEqual([3, 4, 5]);
    expect(gateway.headReads).toBe(1);
    expect(gateway.fileReads).toEqual([FILE_B]);
    expect(history.hasOlder()).toBe(true);
  });

  it('reads a chat whose entries name no history file yet from its first slot', async () => {
    const gateway = new FakeGateway();
    for (let seq = 0; seq <= 3; seq++) {
      gateway.write(entryAt(seq));
    }
    const { history } = open(gateway);
    expect(await history.open()).toEqual({ startAt: 0, rows: [] });
    expect(history.hasOlder()).toBe(false);
  });

  it('reads from slot 0 when the head lookup answers 404, which is an empty chat or a failed lookup', async () => {
    const gateway = twoFileChat();
    gateway.head = 'not-found';
    const { history } = open(gateway);
    expect(await history.open()).toEqual({ startAt: 0, rows: [] });
  });

  it('reads from slot 0 when the head lookup outlives its timeout, and reports it', async () => {
    const gateway = twoFileChat();
    gateway.head = 'timeout';
    const { history, errors } = open(gateway);
    expect(await history.open()).toEqual({ startAt: 0, rows: [] });
    expect(errors).toHaveLength(1);
  });

  it('rejects when the head lookup fails quickly, so the caller tries again', async () => {
    const gateway = twoFileChat();
    gateway.head = 'fail';
    const { history } = open(gateway);
    await expect(history.open()).rejects.toThrow();
  });

  it('takes the history link from an older entry when the head entry cannot be read', async () => {
    const gateway = twoFileChat();
    gateway.writeRaw(7, bytes({ broken: true }));
    const { history } = open(gateway);
    const opening = await history.open();
    expect(opening.startAt).toBe(6);
    expect(opening.rows.map((row) => row.seq)).toEqual([3, 4, 5]);
  });

  it('opens from the slot the head lookup names, however stale, and leaves the rest to the walk', async () => {
    const gateway = twoFileChat();
    gateway.head = { index: 6 };
    const { history } = open(gateway);
    expect((await history.open()).startAt).toBe(6);
  });

  it('opens without the history file when it cannot be read, and offers it as older messages', async () => {
    const gateway = twoFileChat();
    gateway.files.delete(FILE_B);
    const { history, errors } = open(gateway);
    const opening = await history.open();
    expect(opening).toEqual({ startAt: 6, rows: [] });
    expect(errors).toHaveLength(1);
    expect(history.hasOlder()).toBe(true);

    gateway.files.set(FILE_B, bytes(file(3, 5, { ref: FILE_A, toSeq: 2 })));
    expect((await history.loadOlder()).map((row) => row.seq)).toEqual([3, 4, 5]);
  });

  it.each<[string, (gateway: FakeGateway) => void]>([
    ['not the one its link names', (gateway) => gateway.files.set(FILE_B, bytes(file(3, 4, null)))],
    ['not a history file', (gateway) => gateway.files.set(FILE_B, bytes({ hello: 'world' }))],
  ])('reads from slot 0 when the newest file is %s, and reports it', async (_case, damage) => {
    const gateway = twoFileChat();
    damage(gateway);
    const { history, errors } = open(gateway);
    expect(await history.open()).toEqual({ startAt: 0, rows: [] });
    expect(errors).toHaveLength(1);
    expect(history.hasOlder()).toBe(false);
  });

  it('leaves out and reports the bad rows of a file', async () => {
    const gateway = twoFileChat();
    const damaged = file(3, 5, { ref: FILE_A, toSeq: 2 });
    damaged.messages[1] = { ...damaged.messages[1]!, msg: { ...damaged.messages[1]!.msg, id: 'bad' } };
    gateway.files.set(FILE_B, bytes(damaged));
    const { history, skipped } = open(gateway);
    expect((await history.open()).rows.map((row) => row.seq)).toEqual([3, 5]);
    expect(skipped).toEqual([1]);
  });
});

describe('ChatHistory.loadOlder', () => {
  it('follows prev one file per click until there is none', async () => {
    const gateway = twoFileChat();
    const { history } = open(gateway);
    await history.open();
    expect((await history.loadOlder()).map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(history.hasOlder()).toBe(false);
    expect(await history.loadOlder()).toEqual([]);
  });

  it('rejects and offers the same file again when it cannot be read', async () => {
    const gateway = twoFileChat();
    const { history } = open(gateway);
    await history.open();
    gateway.down = true;
    await expect(history.loadOlder()).rejects.toThrow();
    expect(history.hasOlder()).toBe(true);
    gateway.down = false;
    expect((await history.loadOlder()).map((row) => row.seq)).toEqual([0, 1, 2]);
  });

  it('shares one read between clicks that overlap', async () => {
    const gateway = twoFileChat();
    const { history } = open(gateway);
    await history.open();
    const [first, second] = await Promise.all([history.loadOlder(), history.loadOlder()]);
    expect(first).toBe(second);
    expect(gateway.fileReads.filter((reference) => reference === FILE_A)).toHaveLength(1);
  });

  it('stops offering a file that is not the one its link names', async () => {
    const gateway = twoFileChat();
    gateway.files.set(FILE_A, bytes(file(0, 1, null)));
    const { history } = open(gateway);
    await history.open();
    await expect(history.loadOlder()).rejects.toThrow(/refused/);
    expect(history.hasOlder()).toBe(false);
  });
});
