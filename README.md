# Swarm Chat JS

`@solarpunkltd/swarm-chat-js` is a client library that adds a chat to any web page or Node program, with every message
stored on [Swarm](https://www.ethswarm.org/), the decentralised storage network. A page that uses it needs no web server
of its own. It talks only to a Bee node, which is a Swarm node, or to a gateway, which is a Bee node that serves the
public over HTTP.

The library is one half of a chat. The other half is its server,
[swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js), which receives the messages,
checks them and publishes them for every reader. Any project can run the server and use the library to add chat on
Swarm. One project built on them is [stream-event-client](https://github.com/Solar-Punk-Ltd/stream-event-client), a
viewer for live streams with a chat beside each video.

## Terms

- **Chunk.** The unit Swarm stores, at most 4,096 bytes, found by its address.
- **Single owner chunk.** A chunk whose address comes from an owner's key and an identifier, so only that key can write
  it.
- **GSOC.** A single owner chunk whose key is shared on purpose, so anyone can write to it. A Bee node near its address
  can subscribe to it and hears every write. The chat uses one GSOC address as a shared inbox.
- **Feed.** A sequence of single owner chunks written by one owner under one topic, at index 0, 1, 2 and on. Each chat is
  one feed, and the server is its only writer.
- **Postage stamp.** Every write to Swarm is paid for with a stamp from a postage batch. A gateway can stamp writes
  itself, or a sender can stamp with a batch of its own.

## How it works

1. **Sending.** The library builds the message, signs it with the user's key, and writes it once to the inbox. The
   message stays pending until the chat's feed shows it. If it does not show, the identical bytes are written again
   every ten seconds, up to five times, and the message is then marked failed so the page can offer a retry.
2. **Publishing.** The server checks each message's shape and signature and writes it to the chat's feed as the next
   entry. After each publish it saves a history file of the chat, and every entry links to the newest history file.
   The server also writes slot notes, small chunks that say which entries exist. See
   [Slot notes](#slot-notes-for-servers-and-tools).
3. **Opening.** A reader reads the slot notes of the last few seconds, newest first, going back up to one heartbeat
   (30 seconds by default). The newest note names the newest entry. The reader shows that entry's history file and
   reads the entries after it. When it finds no note, it asks Bee for the feed's newest index instead.
4. **Following.** Once each two-second time slot is over, plus one second, the reader asks for that slot's note once.
   It reads feed entries only up to the newest one a note named, so it never asks Bee for an address that is not
   written yet. This matters because Bee answers such a request by skipping its peers for that address for about a
   minute, which would delay the message once it is written. An entry a note named that does not load is read again
   later, so a message arrives late rather than never. A slot that fails its checks is skipped. Gateway failures back
   off with jitter, up to eight seconds. A reader that finds no note polls the next feed index instead, and switches
   to notes as soon as it finds one. An address that came back missing is asked for again no sooner than 20 seconds
   later.
5. **Older messages.** Loading older messages is a call the page makes, usually on a click. It reads the history file
   before the oldest one shown.

## What you need

- A running [swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js). Its operator gives
  you the inbox identifier and key, the feed owner address and the slot note timing.
- A Bee node or gateway to read through, and one to write through. The node the inbox writes go through must be a
  different Bee node from the one the server listens on.
- A way to pay for the inbox writes: a gateway that stamps them, or a postage batch of the sender's own.

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

| Setting                  | Meaning                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.privateKey`        | Signs every message. A viewer that only reads may pass any key.                                                                                               |
| `user.nickname`          | The name on every message, 1 to 20 characters. It may not read as an ENS name ending in `.eth`. Nothing can be sent without one.                              |
| `user.binding`           | Optional. A signed-in viewer's Swarm ID chat binding, `{ msg, sig }`, for the chat address of `user.privateKey`. Every message then carries it.               |
| `user.walletLink`        | Optional, only with `user.binding`. The viewer's Swarm ID wallet link, `{ msg, wsig, asig }`, for the binding's account. Every message then carries it.       |
| `infra.beeUrl`           | The Bee node or gateway the chat is read through, and written through when `infra.writeUrl` is not set.                                                       |
| `infra.writeUrl`         | Optional. The Bee node or gateway the inbox writes go through, such as a write gateway that stamps them, when they go somewhere other than the reads.         |
| `infra.stamp`            | The postage batch id the inbox writes are stamped with. Left out for a gateway that stamps writes itself.                                                     |
| `infra.via`              | Required. Who pays for the inbox writes, `MessageVia.GATEWAY` or `MessageVia.OWN_STAMP`. Every message records it in `via`.                                   |
| `infra.gsocTopic`        | The inbox's identifier string, the same for every chat on one server.                                                                                         |
| `infra.gsocResourceId`   | The inbox key every sender signs inbox writes with. The server's operator mines it so the inbox sits near the server's listening node.                        |
| `infra.chatTopic`        | The chat's topic. Every message carries it, and the chat's feed is named by it.                                                                               |
| `infra.chatAddress`      | The server's feed owner address.                                                                                                                              |
| `infra.pollingInterval`  | The shortest wait between two polls, and the first wait after the gateway failed. 1,000 ms by default.                                                        |
| `infra.socReadTimeout`   | The time limit for one feed entry read. 5,000 ms by default.                                                                                                  |
| `infra.feedReadTimeout`  | The time limit for the newest-index lookup and for a history file download. 15,000 ms by default. A lookup that runs out of time reads the chat from index 0. |
| `infra.gsocWriteTimeout` | The time limit for one inbox write. 10,000 ms by default.                                                                                                     |
| `infra.noteSlotMs`       | The server's `NOTE_SLOT_MS`, 2,000 ms by default. It is part of every note's address, so a different value finds no notes and the reader polls instead.       |
| `infra.noteHeartbeatMs`  | The server's `NOTE_HEARTBEAT_MS`, 30,000 ms by default. It sets how far back an opening reader looks for a note.                                              |

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
| `orderMessages(messages)`                   | Published messages in chat order, then pending ones by the sender's clock.                                                                                                                                                                                                         |
| `getStatus()`                               | `live`, `reconnecting`, `stalled`, or `null` before the first read.                                                                                                                                                                                                                |
| `getAddress()`                              | The address of the key, which is every sent message's `address`.                                                                                                                                                                                                                   |

## Events

| Event                       | Carries          | When                                                                                                                            |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LOADING_INIT`              | `boolean`        | `true` when opening starts, `false` once the chat is open.                                                                      |
| `LOADING_PREVIOUS_MESSAGES` | `boolean`        | Around a load of older messages.                                                                                                |
| `MESSAGE_RECEIVED`          | `MessageData`    | A message the feed or a history file shows. For a sender, this is what "sent" means.                                            |
| `MESSAGE_REQUEST_INITIATED` | `MessageData`    | A message signed and about to be written, with `index` -1.                                                                      |
| `MESSAGE_REQUEST_UPLOADED`  | `MessageData`    | The first write of the message that the node accepted. It is still pending.                                                     |
| `MESSAGE_REQUEST_ERROR`     | `MessageData`    | Its resends ran out and the feed never showed it.                                                                               |
| `STATUS`                    | `FeedStatus`     | `live`: the gateway answers. `reconnecting`: it does not. `stalled`: a message known to exist has not loaded for eight seconds. |
| `MESSAGE_SKIPPED`           | `SkippedMessage` | A feed entry or history row that is not shown, and why.                                                                         |
| `ERROR`                     | `unknown`        | A failure the chat recovers from on its own.                                                                                    |
| `CRITICAL_ERROR`            | `unknown`        | Opening failed three times in a row. It keeps trying.                                                                           |

**The order of a sent message's events.** `MESSAGE_REQUEST_INITIATED` comes first, then `MESSAGE_REQUEST_UPLOADED`
once a write is accepted, then `MESSAGE_RECEIVED` when the feed shows it. The resends and the give-up wait while the
status is not `live`, so a message is not marked failed only because this viewer cannot see the feed. A message can
still be marked failed and then shown, for example when the server published it after the last resend. So
`MESSAGE_RECEIVED` may follow `MESSAGE_REQUEST_ERROR` for the same `id`, and the page keeps the received one.

A `MessageData` has these fields:

- `id`, `type`, `message` (the text or emoji), `username` and `address`.
- `timestamp`: the server's receive time, or the sender's clock while pending.
- `targetMessageId`: the message a reply or reaction refers to.
- `index`: the feed index, -1 while pending.
- `signedMessage`: the message exactly as its sender signed it.

Everything else the message says, such as its topic, its signature, the sender's clock, `via` and the binding, is read
from `signedMessage`. A page that shows who sent a message hands `signedMessage` to `verifyChatMessage`. See
[Verifying](#verifying).

## The message, for servers and tools

`@solarpunkltd/swarm-chat-js/message` is the one place the message is built, signed and checked. The server imports it
rather than keeping its own copy. This entry point loads none of the reader.

```ts
import { parseChatMessage, MAX_MESSAGE_BYTES } from '@solarpunkltd/swarm-chat-js/message';

const check = parseChatMessage(payload, { origin: 'https://example.com' });
if (check.ok) publish(check.message);
else count(check.reason);
```

A message is a JSON object of at most 3,072 bytes of UTF-8, with its fields in this order:

| Field    | Meaning                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `v`      | `9`, the message format version                                                                              |
| `topic`  | The chat's topic, 1 to 128 characters                                                                        |
| `id`     | A random id, 32 lowercase hex characters                                                                     |
| `type`   | `text`, `thread` (a reply, `target` is the parent) or `reaction` (`target` is the message, `text` the emoji) |
| `target` | The id it refers to, or `""` for a text                                                                      |
| `text`   | 1 to 500 characters                                                                                          |
| `name`   | The display name, 1 to 20 characters, with the limits in [Display names](#display-names)                     |
| `addr`   | The sender's chat address, 40 lowercase hex characters without `0x`                                          |
| `ts`     | The sender's clock in milliseconds                                                                           |
| `via`    | Who paid for the inbox write: `gateway` (the gateway's stamp) or `own-stamp` (the sender's own)              |
| `idb`    | Only for a signed-in sender: its Swarm ID chat binding, `{ msg, sig }`                                       |
| `wl`     | Only beside `idb`, for a sender who shows an ENS name: its Swarm ID wallet link, `{ msg, wsig, asig }`       |
| `sig`    | 130 lowercase hex characters of r, s and v, with v 27 or 28 and s in the lower half                          |

Characters are counted as Unicode code points, so an emoji counts once. `countCharacters` counts the same way, for a
text box that shows a count.

The signed bytes are the UTF-8 of
`JSON.stringify([9, topic, id, type, target, text, name, addr, ts, via, idb?.msg ?? '', idb?.sig ?? ''])`. When the
message carries a wallet link, `wl.msg`, `wl.wsig` and `wl.asig` are appended to that array. The library signs with
bee-js's `PrivateKey.sign` and checks with `Signature.recoverPublicKey`, both over the raw bytes. So `via`, the binding
and the wallet link cannot be changed, added or removed without breaking the signature.

Every signature has a second valid spelling, with s replaced by n - s and v flipped, and bee-js reads any v other than
27 as 28. The check therefore accepts only the low s spelling with v 27 or 28, which is the one bee-js produces. One
message has exactly one valid signature.

### Display names

A name may not contain a Unicode format or control character (`\p{Cf}`, `\p{Cc}`), such as the right-to-left override
U+202E or a zero width space, because those can make one name look like another. The zero width non-joiner U+200C and
the zero width joiner U+200D are allowed, because Persian and Indic names and joined emoji need them. Variation
selectors such as U+FE0F are allowed too. Letters and marks that show as nothing are refused: the braille blank U+2800,
the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the combining grapheme joiner U+034F and the Khmer inherent vowels
U+17B4 and U+17B5.

A name that reads as ending in `.eth` is refused, because a page may show a verified ENS name in the same place and a
chosen name could pass for one. The check builds a skeleton of the name, the name as a reader sees it:

- NFKD normalised, so fullwidth and other compatibility forms fold and accented letters lose their accents
- every character Unicode's confusables data maps to the full stop read as `.`, and the ideographic full stop U+3002
  too, since ENS reads it as one
- Unicode default ignorable code points, the braille blank, and nonspacing and enclosing marks removed
- letters the confusables data maps to `e`, `t` or `h` read as those letters, such as Cyrillic `е`, `т`, `н` and Greek
  `Ε`, `Τ`, `Η`
- lower-cased, trimmed, and stripped of trailing spaces and dots

The name is refused when the skeleton ends in `.eth`. So `vitalik.eth`, `Vitalik.ETH`, `vitalik.eth.`, `vitalik.еth`
(Cyrillic `е`), `vitalik٠eth` (Arabic-Indic zero) and `ＶＩＴＡＬＩＫ．ＥＴＨ` are refused, while `vitalik eth`,
`vitalik-eth`, `Kenneth`, `Seth`, `Ethan` and `J.Ethan` pass. `displayNameProblem(name)` runs the same check for a
sign-up form.

### The Swarm ID chat binding

[Swarm ID](https://github.com/Solar-Punk-Ltd/solarpunk-id) is a separate identity project. A Swarm ID account gives each
site its own chat key, and nothing in that key says which account it came from. A chat binding is the account's
statement, signed with the account's own key, that one chat address on one site belongs to it. This library does not
derive chat keys and does not import Swarm ID. It only checks the bindings, and reads them exactly as Swarm ID's
`verifyChatBinding` does.

`msg` is four lines joined by `\n`:

```text
Swarm ID chat binding v1
Site: https://example.com
Chat address: 0x<addr>
Date: 2026-10-14T12:00:00.000Z
```

- The site is a bare https origin as a browser reports it. Plain http is accepted only for `localhost`, `127.0.0.1` and
  `[::1]`, and only with the `allowLocalHttp` option.
- The chat address is `0x` and 40 lowercase hex characters.
- The date is ISO 8601 UTC with milliseconds.
- `sig` is an EIP-191 `personal_sign` signature over `msg`: `0x` and 130 lowercase hex characters of r, s and v, with v
  27 or 28 and s in the lower half. Recovering it gives the account's address.

### The Swarm ID wallet link

Swarm ID never tells a site which wallet secures an account. A person who wants readers to see their ENS name turns on
"Show my ENS name on sites" in Swarm ID. Swarm ID then gives the site a wallet link: a statement, signed by the wallet
and countersigned by the account's own key, that the two belong to the same person. Swarm ID hands it over as
`{ message, walletSignature, accountSignature }`, and a message carries it as `{ msg, wsig, asig }`. This library reads
it exactly as Swarm ID's `verifyWalletLink` does.

`msg` is five lines joined by `\n`:

```text
Swarm ID wallet link v1
I link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.
Account: 0x<the binding's account>
Wallet: 0x<the wallet>
Date: 2026-10-15T12:00:00.000Z
```

- The second line must match exactly. A wallet shows the person only the text it signs, so this sentence tells them
  what the signature does.
- Both addresses are `0x` and 40 lowercase hex characters, and the date is ISO 8601 UTC with milliseconds.
- `wsig` and `asig` are EIP-191 `personal_sign` signatures over `msg` by the wallet and by the account, each `0x` and
  130 lowercase hex characters, with v 27 or 28 and s in the lower half.

A message carries a link only beside its binding, and the link counts toward the 3,072 byte limit. The largest message
with a binding and a link is 2,376 bytes.

### Verifying

`verifyChatMessage(value, { origin, allowLocalHttp? })` checks a message's shape and signature. When the message carries
a binding, it also checks that the binding's text is the four lines above, that its chat address is the message's
`addr`, that its signature recovers an account, and that its site is `origin`. It returns
`{ ok: true, message, identity }`. `identity` is `{ account, site, date }` for a signed-in sender and `null` for a
guest. A message whose binding fails is refused with the reason `binding`, and is never shown as a guest.

When the message also carries a wallet link, the link's text must be the five lines above, its account must be the
binding's account, its wallet signature must recover its wallet, and its account signature must recover its account.
`identity` then also has `wallet`, the checked wallet address. A link that fails refuses the message with the reason
`binding`, with a detail starting `wallet link:`. The check looks nothing up. A page that shows an ENS name passes
`identity.wallet` to its own ENS lookup, such as Swarm ID's `resolveVerifiedEnsName`, which requires the wallet's reverse
record and the name's forward record to agree.

`origin` is required. It is the bare origin of the site whose chat this is, such as `https://example.com`, so a binding
signed for one site never passes in another site's chat. A JavaScript caller that passes no origin gets every bound
message refused as `binding`. The server passes its configured site origin, and a page passes its own.

**What `identity.account` proves.** It proves only that whoever controls that Swarm ID account bound this chat key for
this site, on the date the binding names. It is not a verified person and not an approved account. One person can hold
many accounts, an account takes a minute to make, and a lost or shared account key binds just as well. A page that
wants more, such as a badge for known people or a list of accounts allowed to post, keeps that list itself and compares
`identity.account` with it.

The server runs this check, through `parseChatMessage`, on every payload. The reader in this library checks no
signatures, because the server already did and a check costs main-thread time on every message. A page that shows
identities runs `verifyChatMessage` in a Web Worker on each event's `MessageData.signedMessage`. That is the feed
entry's `msg`, or the message as it was signed while it is pending. `verifyChatMessage` never throws, and it uses no DOM
and no Node API.

### The own feed

A sender may also keep a copy of each message it sends in a feed of its own, so anyone can compare that feed with the
chat. The copies live in a feed owned by the sender's chat address `addr`, under the topic `ownFeedTopic(chatTopic)`.
That topic is `swarm-chat-own-feed-v1:` followed by the chat's topic, turned into a feed topic with `Topic.fromString`
as the chat's own feed is. A copy is the signed payload itself. The message says nothing about a copy, so whether one
exists is read from that feed.

The library does not write the copy. A page that keeps copies passes its own inbox write function, a `GsocWrite`, as
`new SwarmChat(settings, { write })`. That function receives the signed payload, the same bytes on every resend, and
writes the copy beside the inbox write.

### Exports

| Export                                                                       | Use                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseChatMessage(bytes, { origin })`                                        | The server's check of a raw payload: byte limit, UTF-8, JSON, then `verifyChatMessage`. Never throws.                                                                       |
| `verifyChatMessage(value, { origin })`                                       | Shape, signature and binding of a parsed object, with the sender's identity. Never throws.                                                                                  |
| `displayNameProblem(name)`                                                   | `null` for a name a message may carry, else `'length'` (not 1 to 20 characters), `'invisible'` (a format or control character) or `'ens-like'` (reads as ending in `.eth`). |
| `createChatMessage(key, draft)`                                              | Builds and signs, throwing a `ChatMessageError` for anything the check would refuse. `via` is required.                                                                     |
| `MessageType`, `MessageVia`                                                  | The values of `type` and `via`.                                                                                                                                             |
| `checkChatBinding(binding, addr, options?)`, `chatBindingSchema`             | The binding check on its own, and its shape. Its `origin` is optional, for a sender checking its own binding.                                                               |
| `checkWalletLink(link, account)`, `walletLinkSchema`                         | The wallet link check on its own, for the binding's account, and its shape.                                                                                                 |
| `ownFeedTopic(chatTopic)`, `OWN_FEED_TOPIC_PREFIX`                           | The topic of a sender's own feed of copies.                                                                                                                                 |
| `chatMessageSchema`, `hasValidSignature`, `signedBytes`, `encodeChatMessage` | The parts of the message check.                                                                                                                                             |
| `feedEntrySchema`, `parseFeedEntry`                                          | The feed entry, `{v, seq, at, msg, history}`.                                                                                                                               |
| `historyFileSchema`, `parseHistoryFile`                                      | The history file, `{v, topic, fromSeq, toSeq, messages, prev}`.                                                                                                             |

The feed entry and the history file carry `v` 9, like the message. A feed entry is at most 4,096 bytes, enough for a
message at the byte limit inside the largest entry around it.

## Slot notes, for servers and tools

A slot note tells readers which feed entries exist, so they never ask for one that does not. Time slot `s` covers
`[s * slotMs, (s + 1) * slotMs)` in Unix milliseconds, with `slotMs` 2,000 by default. The note of slot `s` is a single
owner chunk signed by the chat feed's key. Its identifier is keccak256 of the UTF-8 text
`<chat topic>/note/<slotMs>/<s>`, and it is read through `GET /chunks/<address>`. Its payload is
`{"v":1,"newest":<the highest feed index written>,"writtenAt":<the server's clock in ms>}`, with `newest` -1 for a chat
with nothing written yet. A payload that does not match this exact shape counts as no note.

The server writes a slot's note once the slot is over, when an entry landed since its last note, or when a heartbeat
has passed since that note. An entry's own write has finished before any note names it. A note write that fails is not
retried at its address, because the next slot's note carries the same information.

| Export                                                           | Use                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `noteSlotOf(timeMs, slotMs)`, `noteSlotEnd(slot, slotMs)`        | The slot arithmetic.                                   |
| `noteIdentifier(topic, slotMs, slot)`, `noteAddress(..., owner)` | Where a note is written and read.                      |
| `encodeSlotNote(note)`, `parseSlotNote(bytes)`, `slotNoteSchema` | The payload, encoded in field order and read strictly. |
| `DEFAULT_NOTE_SLOT_MS`, `DEFAULT_NOTE_HEARTBEAT_MS`              | The defaults both sides share.                         |

**The reader's clock.** A reader schedules note reads by its own clock. Every note's `writtenAt` and every entry's `at`
was stamped by the server before the reader received it, so the reader can be at most `received - stamped` ahead of
the server. While notes are found, the reader trusts its own clock and moves reads earlier only when that bound proves
its clock runs behind. When no note is found for longer than a heartbeat, it waits out the whole bound from then on,
which is never early. A clock that runs behind sees every stamp as old as it expects, so its messages arrive as late as
it runs behind.

## Changes

Each release's changes are in [CHANGELOG.md](CHANGELOG.md).

## Development

Node 24 and pnpm 12, pinned by `.nvmrc` and `packageManager`.

```bash
pnpm install
pnpm test
```

CI runs `lint` (oxlint, type-aware), `format:check` (oxfmt), `typecheck`, `test` (vitest) and `build` (vite, with types
from `tsc`). `pnpm format` formats the code, and `pnpm pack` builds before it packs.

## License

Apache-2.0
