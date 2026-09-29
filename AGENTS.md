# Working rules for this repository

`@solarpunkltd/swarm-chat-js` is the client library of a Swarm chat. A browser signs a message and writes it once to a
shared GSOC inbox, the chat server ([swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js))
verifies it and publishes it to the chat's feed, and readers follow that feed. The README describes the API and the
wire formats. This file says how the code is laid out and what not to break.

## Commands

Node 24 and pnpm 12, pinned by `.nvmrc` and `packageManager`.

```bash
pnpm install
pnpm test
```

`lint` (oxlint, type-aware), `format` and `format:check` (oxfmt), `typecheck`, `test` (vitest) and `build` are the six
scripts CI runs, by those names. `pnpm pack` builds first.

## Layout

| File                     | What it holds                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/message/message.ts` | The v7 message: its schema, its signed bytes, signing, verifying and the wire check. The server imports it.  |
| `src/message/entry.ts`   | The feed entry and the history file the server writes, shape-checked for the reader.                         |
| `src/sender.ts`          | One inbox write per message, resends of the identical bytes, reaction merging.                               |
| `src/follower.ts`        | Follows the feed by explicit slots: the walk, stepping past a missing slot, the retry list, backoff, status. |
| `src/history.ts`         | Opening from the newest history file, and loading older files by click.                                      |
| `src/swarm.ts`           | Everything that touches bee-js: slot, head and file reads, and the inbox write.                              |
| `src/chat.ts`            | `SwarmChat`, which wires the parts together.                                                                 |
| `src/events.ts`          | `EVENTS`, `MessageData` and the emitter.                                                                     |

The package has two entries: the root, and `./message`, which the server uses and which loads none of the reader.

## What not to break

- **The message module is a contract with the server.** Its signed bytes, field caps and byte cap are shared, and the
  fixed vectors in `test/message.test.ts` must keep passing unchanged. A change to them is a change to the server too.
- **Sign and verify the raw bytes.** bee-js's `PrivateKey.sign` and `Signature.recoverPublicKey` hash and prefix
  inside, although the second names its parameter `digest`. Hashing first is how 6.2.8 came to prefix twice.
- **A 404 or a 500 is never the end of the chat.** On a slot it means the chunk is not there or was not found in time,
  which at the live edge is ordinary. Bee 2.8 answers 404 and a Bee 2.6 cluster answers 500 for a slot never written.
  On the head lookup it means an empty feed or a failed lookup, so the reader starts at slot 0. A timeout, an abort
  and a 502, 503 or 504 are the gateway failing.
- **One bad slot never stops the reader.** A slot that fails its checks is skipped and counted. A served chunk that
  fails its own check is an `UnreadableSlotError`, kept for later, and never treated as the gateway failing.
- **Never send an inbox write deferred or tagged**, so each write is pushed at once and messages never collide.
- **bee-js 13.1.0 ignores its `timeout` request option.** Every request carries a fresh `AbortSignal.timeout`.
- **No signature check per message on the read path.** The server checked, and the check cost 6.x about 36 ms of main
  thread per message on every open.
- **Every timer stops on `stop()`.** The tests assert no timer is left.

## Style

oxlint and oxfmt as configured. Comments only for context the code cannot carry. Conventional commit messages, one
change per commit.
