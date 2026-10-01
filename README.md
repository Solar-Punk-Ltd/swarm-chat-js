# Swarm Chat JS

A client library for chat over [Swarm](https://www.ethswarm.org/). A browser signs each message and sends it as one
GSOC write to a shared inbox. A chat server verifies it and publishes it to the chat's feed, and every reader follows
that feed. The browser talks only to a Bee node or gateway, never to a web server of its own.

The library needs its server,
[Solar-Punk-Ltd/swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js), which listens on
the inbox and writes the feed. Version 7 of the library reads and writes the v7 message format only.

## How it works

1. **Sending.** The sender builds the message, signs it with the user's key, and writes it once to the inbox, a GSOC
   address every chat shares. The message stays pending until the chat feed shows it. If it does not, the identical
   bytes are written again every ten seconds, up to five times, and then it is failed with a manual retry.
2. **Publishing.** The server checks each message's shape and signature and writes it to the chat's feed as the next
   entry, at index 0, 1, 2 and on. After a message is published it saves a history file of the chat, and every entry
   links to the newest file saved. Once a two-second time slot ends in which a message landed, and at least every 30
   seconds while the chat is active, it writes a slot note naming the newest entry. See
   [Slot notes](#slot-notes-for-servers-and-tools).
3. **Opening.** A reader reads the notes of the slots just ended, newest first, back as far as one heartbeat. The
   newest note found names the newest entry, whose history file is shown, and the entries after it are read. Only
   when no note is found, which is a server that writes none, does it ask Bee for the feed's head instead.
4. **Following.** Once each time slot is over, plus a second, a reader asks for that slot's note once, and reads the
   feed entries up to the newest one a note named, never further. So it never asks Bee for an address before it is
   written. Bee answers such a request by skipping its peers for that address for a minute, which made new messages
   arrive about forty seconds late while readers polled the next slot. An entry a note named that does not load is
   read again on later reads, so a message arrives late rather than never. A slot that fails its checks is skipped
   and never stops the chat. Gateway failures back off with jitter up to eight seconds. A reader of a server that
   writes no notes polls the next slot as 7.1 did, and is led by notes from the first one it finds.
5. **Older messages.** Loading older messages is a click, which reads the history file before the oldest one shown.

## Installation

```bash
pnpm add @solarpunkltd/swarm-chat-js @ethersphere/bee-js
```

bee-js 13 is a peer dependency. The package runs in browsers and in Node 24 or later, as ESM or CommonJS.

## Usage

```ts
import { EVENTS, MessageType, SwarmChat, type MessageData } from '@solarpunkltd/swarm-chat-js';

const chat = new SwarmChat({
  user: { privateKey: userKey, nickname: 'alice' },
  infra: {
    beeUrl: 'https://gateway.example.com',
    gsocTopic: inboxIdentifier,
    gsocResourceId: minedInboxKey,
    chatTopic: 'chat-my-stream',
    chatAddress: serverFeedOwner,
    pollingInterval: 500,
  },
});

const { on } = chat.getEmitter();
on(EVENTS.MESSAGE_RECEIVED, (message: MessageData) => show(message));
on(EVENTS.MESSAGE_REQUEST_ERROR, (message: MessageData) => offerRetry(message));
on(EVENTS.STATUS, (status) => showConnection(status));

await chat.start();
await chat.sendMessage('hello', MessageType.TEXT);
await chat.sendMessage('👍', MessageType.REACTION, someMessageId);

// Later, and in any order, as often as needed.
await chat.stop();
```

## Settings

| Setting                  | Meaning                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.privateKey`        | Signs every message. A viewer that only reads may pass any key.                                                                                       |
| `user.nickname`          | The name on every message, 1 to 20 characters. Nothing can be sent without one.                                                                       |
| `infra.beeUrl`           | The Bee node or gateway the chat is read through, and written through when `infra.writeUrl` is not set.                                               |
| `infra.writeUrl`         | Optional. The Bee node or gateway the inbox writes go through, such as a write gateway that stamps them, when they go somewhere other than the reads. |
| `infra.stamp`            | The batch the inbox writes are stamped with. Left out for a gateway that stamps writes itself.                                                        |
| `infra.gsocTopic`        | The inbox's identifier string, the same for every chat.                                                                                               |
| `infra.gsocResourceId`   | The mined key every sender signs inbox writes with. The server's operator mines it.                                                                   |
| `infra.chatTopic`        | The chat's topic, which every message carries and the feed is named by.                                                                               |
| `infra.chatAddress`      | The server's feed owner address.                                                                                                                      |
| `infra.pollingInterval`  | How often a reader of a server without notes polls at the live edge, 1,000 ms by default.                                                             |
| `infra.socReadTimeout`   | One feed slot read, 5,000 ms by default.                                                                                                              |
| `infra.feedReadTimeout`  | The head lookup and a history file download, 15,000 ms by default. A head lookup that runs out of time reads the chat from slot 0.                    |
| `infra.gsocWriteTimeout` | One inbox write, 10,000 ms by default.                                                                                                                |
| `infra.noteSlotMs`       | The server's `NOTE_SLOT_MS`, 2,000 ms by default. It is part of every note's address, so a different value finds no notes and polls instead.          |
| `infra.noteHeartbeatMs`  | The server's `NOTE_HEARTBEAT_MS`, 30,000 ms by default, which sets how far back an opening looks for a note.                                          |

## Methods

| Method                                      | What it does                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                                   | Opens the chat and follows it. Resolves once it is open, or once `stop` is called. Opening is retried for as long as the chat runs.                                                                                                                                                |
| `stop()`                                    | Stops every poll, resend and retry. Listeners stay, so a later `start` reports to them again.                                                                                                                                                                                      |
| `getEmitter()`                              | The events below, with `on` and `off`.                                                                                                                                                                                                                                             |
| `sendMessage(text, type, targetMessageId?)` | Sends a text or a thread reply and resolves to the pending message. A reaction resolves to `null`: taps on one reaction inside a second cancel in pairs, and only an odd count is sent. Rejects with a `ChatMessageError`, sending nothing, for a message the server would refuse. |
| `retrySendMessage(message)`                 | Writes a failed or pending message again with its identical bytes.                                                                                                                                                                                                                 |
| `fetchPreviousMessages()`                   | Shows the history file before the oldest one shown, and resolves to its messages.                                                                                                                                                                                                  |
| `hasPreviousMessages()`                     | Whether there is an older file to load.                                                                                                                                                                                                                                            |
| `orderMessages(messages)`                   | Published messages in chat order, then pending ones by time.                                                                                                                                                                                                                       |
| `getStatus()`                               | `live`, `reconnecting`, `stalled`, or `null` before the first read.                                                                                                                                                                                                                |
| `getAddress()`                              | The address of the key, which is every sent message's `address`.                                                                                                                                                                                                                   |

## Events

| Event                       | Carries          | When                                                                                                                            |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LOADING_INIT`              | `boolean`        | `true` when opening starts, `false` once the chat is open.                                                                      |
| `LOADING_PREVIOUS_MESSAGES` | `boolean`        | Around a load of older messages.                                                                                                |
| `MESSAGE_RECEIVED`          | `MessageData`    | A message the feed or a history file shows. For a sender, this is what "sent" means.                                            |
| `MESSAGE_REQUEST_INITIATED` | `MessageData`    | A message signed and about to be written, with `index` -1.                                                                      |
| `MESSAGE_REQUEST_UPLOADED`  | `MessageData`    | Its first write the node accepted. It is still pending.                                                                         |
| `MESSAGE_REQUEST_ERROR`     | `MessageData`    | Its resends ran out unseen.                                                                                                     |
| `STATUS`                    | `FeedStatus`     | `live`: the gateway answers. `reconnecting`: it does not. `stalled`: a message known to exist has not loaded for eight seconds. |
| `MESSAGE_SKIPPED`           | `SkippedMessage` | A feed slot or history row not shown, and why.                                                                                  |
| `ERROR`                     | `unknown`        | A failure the chat recovers from on its own.                                                                                    |
| `CRITICAL_ERROR`            | `unknown`        | Opening failed three times in a row. It keeps trying.                                                                           |

**The order of a sent message's events.** `MESSAGE_REQUEST_INITIATED` comes first, then `MESSAGE_REQUEST_UPLOADED`
once a write is accepted, then `MESSAGE_RECEIVED` when the feed shows it. The resends and the give-up wait while the
status is not `live`, so a message is not failed only because this viewer could not see the feed. A message can still
be failed and then shown, for example when the server published it after the last resend, so `MESSAGE_RECEIVED` may
follow `MESSAGE_REQUEST_ERROR` for the same `id`, and a viewer settles on the received one.

A `MessageData` has `id`, `type`, `message` (the text or emoji), `username`, `address`, `timestamp` (the server's
receive time, or the sender's clock while pending), `targetMessageId` for a reply or reaction, `chatTopic`,
`signature`, `index` (the feed index, -1 while pending) and `sentAt` (the sender's clock, which nothing checks).

## The message, for servers and tools

`@solarpunkltd/swarm-chat-js/message` is the one place the message is built, signed and checked, and the server imports
it rather than keeping a copy. It loads none of the reader.

```ts
import { parseChatMessage, MAX_MESSAGE_BYTES } from '@solarpunkltd/swarm-chat-js/message';

const check = parseChatMessage(payload);
if (check.ok) publish(check.message);
else count(check.reason);
```

A message is a JSON object of at most 2,048 bytes of UTF-8:

| Field    | Meaning                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `v`      | `7`                                                                                                          |
| `topic`  | The chat's topic, 1 to 128 characters                                                                        |
| `id`     | A random id, 32 lowercase hex characters                                                                     |
| `type`   | `text`, `thread` (a reply, `target` is the parent) or `reaction` (`target` is the message, `text` the emoji) |
| `target` | The id it refers to, or `""` for a text                                                                      |
| `text`   | 1 to 500 characters                                                                                          |
| `name`   | 1 to 20 characters                                                                                           |
| `addr`   | The sender's address, 40 lowercase hex characters without `0x`                                               |
| `ts`     | The sender's clock in milliseconds                                                                           |
| `sig`    | 130 hex characters                                                                                           |

Characters are counted as Unicode code points, so an emoji counts once, and `countCharacters` counts the same way for
a composer. The signed bytes are the UTF-8 of `JSON.stringify([7, topic, id, type, target, text, name, addr, ts])`,
signed with bee-js's `PrivateKey.sign` and checked with `Signature.recoverPublicKey`, both over the raw bytes.

| Export                                                                       | Use                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `parseChatMessage(bytes)`                                                    | The server's check of a raw payload: byte cap, UTF-8, JSON, shape, signature. Never throws. |
| `checkChatMessage(value)`                                                    | The same for a parsed object.                                                               |
| `createChatMessage(key, draft)`                                              | Builds and signs, throwing a `ChatMessageError` for anything the check would refuse.        |
| `chatMessageSchema`, `hasValidSignature`, `signedBytes`, `encodeChatMessage` | The parts.                                                                                  |
| `feedEntrySchema`, `parseFeedEntry`                                          | The feed entry, `{v, seq, at, msg, history}`.                                               |
| `historyFileSchema`, `parseHistoryFile`                                      | The history file, `{v, topic, fromSeq, toSeq, messages, prev}`.                             |

## Slot notes, for servers and tools

A note tells readers which feed entries exist, so they never ask for one that does not. Time slot `s` covers
`[s * slotMs, (s + 1) * slotMs)` in Unix milliseconds, `slotMs` being 2,000 by default. The note of slot `s` is a
single owner chunk signed by the chat feed's key, at the identifier keccak256 of the UTF-8 text
`<chat topic>/note/<slotMs>/<s>`, and is read through `GET /chunks/<address>`. Its payload is
`{"v":1,"newest":<the highest feed index written>,"writtenAt":<the server's clock in ms>}`, `newest` -1 for a chat with
nothing written yet, and a payload that fails this strict shape counts as no note.

The server writes a slot's note once the slot is over, when an entry landed since its last note that was written, or
when a heartbeat has passed since that note. An entry's own write has finished before any note names it. A note write
that fails is not retried at its address: the next slot's note carries the same news.

| Export                                                           | Use                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `noteSlotOf(timeMs, slotMs)`, `noteSlotEnd(slot, slotMs)`        | The slot arithmetic.                                   |
| `noteIdentifier(topic, slotMs, slot)`, `noteAddress(..., owner)` | Where a note is written and read.                      |
| `encodeSlotNote(note)`, `parseSlotNote(bytes)`, `slotNoteSchema` | The payload, encoded in field order and read strictly. |
| `DEFAULT_NOTE_SLOT_MS`, `DEFAULT_NOTE_HEARTBEAT_MS`              | The defaults both sides share.                         |

**The reader's clock.** A reader schedules note reads by its own clock. Every note's `writtenAt` and every entry's `at`
was stamped before the reader received it, so the reader runs at most `received - stamped` ahead of the server. While
notes are found it trusts its own clock, moving reads earlier only when that bound proves the clock runs behind. When
no note is found for longer than a heartbeat, it waits out the whole bound from then on, which is never early. A
clock that runs behind sees every stamp as old as it expects, so its messages arrive as late as it runs behind.

## Changes in 7.2

- Readers follow a chat by its slot notes and no longer ask for the next feed slot before it exists, so a new message
  arrives in seconds rather than about forty. Opening needs no head lookup either. A server without notes is followed
  as 7.1 followed it.
- The note protocol is exported from the root and from `./message` for the server. New settings `infra.noteSlotMs`
  and `infra.noteHeartbeatMs`.

## Changes from 6.x

- Messages are signed over every field and verified by the server. 6.x signed four fields with a double prefix, and its
  check passed forged messages.
- One inbox write per message. The write to the sender's own feed is gone, and so are `userTopic`, `additionalProps`,
  and the `enveloped` setting.
- A bad message or history row is skipped, never a freeze. A slot no peer gives out is stepped past and read again.
- No signature check per message on the read path, which cost 6.x about 36 ms of main thread per message on every open.
- `sendMessage` takes three arguments, and a reaction resolves to `null`. `retrySendMessage` covers what
  `retryBroadcastUserMessage` did.
- `stop` keeps listeners. New events: `STATUS`, `MESSAGE_SKIPPED` and `ERROR`. `CRITICAL_ERROR` means three failed
  openings in a row, and opening keeps trying.
- `MessageData.index` is the feed index, `timestamp` is the server's receive time, and `sentAt` is new.
- The GSOC mining script moved to the server repository, whose operator mines the inbox key.
- The package is ESM first with a CommonJS build. The UMD bundle and the Node polyfills are gone.

## Development

Node 24 and pnpm 12, through `packageManager`.

```bash
pnpm install
pnpm test
```

`lint` (oxlint, type-aware), `format` and `format:check` (oxfmt), `typecheck`, `test` (vitest) and `build` (vite, with
types from `tsc`) are the scripts CI runs. `pnpm pack` builds before it packs.

## License

Apache-2.0
