# Swarm Chat JS

A client library for chat over [Swarm](https://www.ethswarm.org/). A browser signs each message and sends it as one
GSOC write to a shared inbox. A chat server verifies it and publishes it to the chat's feed, and every reader follows
that feed. The browser talks only to a Bee node or gateway, never to a web server of its own.

The library needs its server,
[Solar-Punk-Ltd/swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js), which listens on
the inbox and writes the feed. Version 8 of the library reads and writes the v8 message format only, and a v7 message
fails its shape check.

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
   read again later, so a message arrives late rather than never. A slot that fails its checks is skipped and never
   stops the chat. Gateway failures back off with jitter up to eight seconds. A reader that finds no note, which is a
   server that writes none or a chat it has not opened yet, polls the next slot, and is led by notes from the first
   one it finds. Any address that came back missing, a feed slot or a note, is asked for again no sooner than twenty
   seconds later, three times a minute at most, which keeps Bee from skipping its peers for it.
5. **Older messages.** Loading older messages is a click, which reads the history file before the oldest one shown.

## Installation

```bash
pnpm add @solarpunkltd/swarm-chat-js @ethersphere/bee-js
```

bee-js 13 is a peer dependency. The package runs in browsers and in Node 24 or later, as ESM or CommonJS.

## Usage

```ts
import { EVENTS, MessageType, MessageVia, SwarmChat, type MessageData } from '@solarpunkltd/swarm-chat-js';

const chat = new SwarmChat({
  user: { privateKey: userKey, nickname: 'alice' },
  infra: {
    beeUrl: 'https://gateway.example.com',
    via: MessageVia.GATEWAY,
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
| `user.binding`           | Optional. A signed-in viewer's Swarm ID chat binding, `{ msg, sig }`, for the chat address of `user.privateKey`. Every message then carries it.       |
| `infra.beeUrl`           | The Bee node or gateway the chat is read through, and written through when `infra.writeUrl` is not set.                                               |
| `infra.writeUrl`         | Optional. The Bee node or gateway the inbox writes go through, such as a write gateway that stamps them, when they go somewhere other than the reads. |
| `infra.stamp`            | The batch the inbox writes are stamped with. Left out for a gateway that stamps writes itself.                                                        |
| `infra.via`              | Required. Who pays for the inbox writes, `MessageVia.GATEWAY` or `MessageVia.OWN_STAMP`, as every message says in `via`.                              |
| `infra.gsocTopic`        | The inbox's identifier string, the same for every chat.                                                                                               |
| `infra.gsocResourceId`   | The mined key every sender signs inbox writes with. The server's operator mines it.                                                                   |
| `infra.chatTopic`        | The chat's topic, which every message carries and the feed is named by.                                                                               |
| `infra.chatAddress`      | The server's feed owner address.                                                                                                                      |
| `infra.pollingInterval`  | The shortest wait between two polls, and the first wait after the gateway failed, 1,000 ms by default.                                                |
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
receive time, or the sender's clock while pending), `targetMessageId` for a reply or reaction, `index` (the feed index,
-1 while pending) and `signedMessage`, the message exactly as its sender signed it. Everything else the message says,
its topic, its signature, the sender's clock, `via`, `own` and the binding, is read from `signedMessage`, and a page
that shows who sent it hands `signedMessage` to `verifyChatMessage`. See [Verifying](#verifying).

## The message, for servers and tools

`@solarpunkltd/swarm-chat-js/message` is the one place the message is built, signed and checked, and the server imports
it rather than keeping a copy. It loads none of the reader.

```ts
import { parseChatMessage, MAX_MESSAGE_BYTES } from '@solarpunkltd/swarm-chat-js/message';

const check = parseChatMessage(payload, { origin: 'https://example.com' });
if (check.ok) publish(check.message);
else count(check.reason);
```

A message is a JSON object of at most 3,072 bytes of UTF-8, its fields in this order:

| Field    | Meaning                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `v`      | `8`                                                                                                          |
| `topic`  | The chat's topic, 1 to 128 characters                                                                        |
| `id`     | A random id, 32 lowercase hex characters                                                                     |
| `type`   | `text`, `thread` (a reply, `target` is the parent) or `reaction` (`target` is the message, `text` the emoji) |
| `target` | The id it refers to, or `""` for a text                                                                      |
| `text`   | 1 to 500 characters                                                                                          |
| `name`   | 1 to 20 characters                                                                                           |
| `addr`   | The sender's chat address, 40 lowercase hex characters without `0x`                                          |
| `ts`     | The sender's clock in milliseconds                                                                           |
| `via`    | Who paid for the inbox write: `gateway` (the gateway's stamp) or `own-stamp` (the sender's own)              |
| `own`    | `true` when the sender also keeps a copy of the message in its own feed                                      |
| `idb`    | Only for a signed-in sender: its Swarm ID chat binding, `{ msg, sig }`                                       |
| `sig`    | 130 lowercase hex characters of r, s and v, with v 27 or 28 and s in the lower half                          |

Characters are counted as Unicode code points, so an emoji counts once, and `countCharacters` counts the same way for
a composer. The signed bytes are the UTF-8 of
`JSON.stringify([8, topic, id, type, target, text, name, addr, ts, via, own, idb?.msg ?? '', idb?.sig ?? ''])`, signed
with bee-js's `PrivateKey.sign` and checked with `Signature.recoverPublicKey`, both over the raw bytes. So `via`, `own`
and the binding cannot be changed or taken off without breaking the signature. Every signature has a second valid
spelling, s replaced by n - s with v flipped, and bee-js reads any v but 27 as 28, so the check refuses all but the
low s spelling with v 27 or 28, the one bee-js signs. One message has one valid signature.

### The Swarm ID chat binding

A Swarm ID account gives each site its own chat key, and nothing in that key says which account it came from. The fork
derives it from the site's app secret, itself HMAC-SHA256 of the site's origin under the account key: the chat key is
HMAC-SHA256 of `swarm-id chat key v1` under the app secret, asked again under `swarm-id chat key v1/1`, `/2` and on
while the result is not a valid secp256k1 private key. This library never derives it. It only checks the address a
binding names. The binding is the account's statement, signed with the account's own key, that one chat address on one
site is its own. The Swarm ID fork signs it, and this library reads it exactly as the fork's `verifyChatBinding` does,
without importing the fork. `msg` is four lines joined by `\n`:

```text
Swarm ID chat binding v1
Site: https://example.com
Chat address: 0x<addr>
Date: 2026-10-14T12:00:00.000Z
```

The site is a bare https origin as a browser reports it (plain http only for `localhost`, `127.0.0.1` and `[::1]`, and
only with `allowLocalHttp`), the chat address is `0x` and 40 lowercase hex characters, and the date is ISO 8601 UTC with
milliseconds. `sig` is EIP-191 `personal_sign` over `msg`, written as the fork writes it: `0x` and 130 lowercase hex
characters of r, s and v, v 27 or 28 and s in the lower half. Recovering it gives the account's address.

### Verifying

`verifyChatMessage(value, { origin, allowLocalHttp? })` checks a message's shape and its signature, and then, when it
carries a binding, that the binding's text is those four lines, its chat address is the message's `addr`, its signature
recovers an account, and its site is `origin`. It returns `{ ok: true, message, identity }`, `identity` being
`{ account, site, date }` for a signed-in sender and `null` for a guest. A message whose binding fails is refused with
the reason `binding` and is never shown as a guest.

`origin` is required, the bare origin of the site whose chat this is, such as `https://example.com`. A binding signed
for one site therefore never passes in another site's chat because a caller left the origin out. A JavaScript caller
that passes none anyway gets every bound message refused as `binding`. The server passes its configured site origin,
and a page passes its own.

The server calls it, through `parseChatMessage`, on every payload. The reader in this library still checks no
signature, since that cost 6.x about 36 ms of main thread per message, so a page that shows identities runs
`verifyChatMessage` in a Web Worker on each event's `MessageData.signedMessage`, which is the feed
entry's `msg` or, while pending, the message as it was signed. It never throws, and it touches no DOM and no Node API.

### The own feed

A sender that also keeps a copy of each message it sends says so with `own: true`. The copies live in a feed owned by
the sender's chat address `addr`, under the topic `ownFeedTopic(chatTopic)`, which is `swarm-chat-own-feed-v1:` and the
chat's topic, turned into a feed topic with `Topic.fromString` as the chat's own feed is. This library does not write
that feed yet, so `SwarmChat` always sends `own: false`.

| Export                                                                       | Use                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `parseChatMessage(bytes, { origin })`                                        | The server's check of a raw payload: byte cap, UTF-8, JSON, then `verifyChatMessage`. Never throws.          |
| `verifyChatMessage(value, { origin })`                                       | Shape, signature and binding of a parsed object, with the sender's identity. Never throws.                   |
| `createChatMessage(key, draft)`                                              | Builds and signs, throwing a `ChatMessageError` for anything the check would refuse. `via` is required.      |
| `MessageType`, `MessageVia`                                                  | The values of `type` and `via`.                                                                              |
| `checkChatBinding(binding, addr, options?)`, `chatBindingSchema`             | The binding check on its own and its shape. Its `origin` is optional, for a sender checking its own binding. |
| `ownFeedTopic(chatTopic)`, `OWN_FEED_TOPIC_PREFIX`                           | The topic of a sender's own feed of copies.                                                                  |
| `chatMessageSchema`, `hasValidSignature`, `signedBytes`, `encodeChatMessage` | The parts.                                                                                                   |
| `feedEntrySchema`, `parseFeedEntry`                                          | The feed entry, `{v, seq, at, msg, history}`.                                                                |
| `historyFileSchema`, `parseHistoryFile`                                      | The history file, `{v, topic, fromSeq, toSeq, messages, prev}`.                                              |

The feed entry and the history file carry `v` 8 like the message. A feed entry, at most 4,096 bytes, holds a message at
the byte cap inside its largest wrapper.

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

## Changes in 8.0

- The v8 message adds `via`, `own` and, for a signed-in sender, `idb`, its Swarm ID chat binding, all signed. A v7
  message, entry or history file fails its shape check, and nothing reads both.
- `verifyChatMessage` replaces `checkChatMessage` and also checks the binding, returning the sender's `identity`.
  Both it and `parseChatMessage` require `{ origin }`, the site whose chat this is. A failed binding is refused with the
  new reason `binding`.
- `MAX_MESSAGE_BYTES` is 3,072, so a long text fits beside a binding.
- `createChatMessage` requires `via` and takes `own` and `idb`. `SwarmChat` requires `infra.via` and takes
  `user.binding`.
- `ownFeedTopic` names the feed where a sender keeps its copies.
- `MessageData.signedMessage` carries the whole signed message, for a page to verify. `chatTopic`, `signature` and
  `sentAt` are gone from `MessageData`, since `signedMessage` carries them as `topic`, `sig` and `ts`.
- The binding is recovered through `@ethersphere/core-sdk`, which bee-js 13 already installs, now a dependency here.

## Changes in 7.3

- A reader asks Bee for an address that came back missing no more than three times a minute, a feed slot and a note
  alike. Polling the next slot every second, as a reader that found no note did, kept that slot on Bee's skip list,
  so the first messages in a quiet room arrived 40 to 55 s late. A slot a note names is still read at once.

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
