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

| File                          | What it holds                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/message/message.ts`      | The v9 message: its schema, its signed bytes, signing, `verifyChatMessage` and the wire check. The server imports it. |
| `src/message/binding.ts`      | The Swarm ID chat binding: its four lines and the clean site origin.                                                  |
| `src/message/walletLink.ts`   | The Swarm ID wallet link: its five lines, checked for the binding's account, with both signatures recovered.          |
| `src/message/personalSign.ts` | EIP-191 personal_sign recovery and the date spelling the binding and the wallet link share.                           |
| `src/message/ownFeed.ts`      | `ownFeedTopic`, the topic of the feed where a sender keeps copies of its messages.                                    |
| `src/message/entry.ts`        | The feed entry and the history file the server writes, shape-checked for the reader.                                  |
| `src/sender.ts`               | One inbox write per message, resends of the identical bytes, reaction merging.                                        |
| `src/message/note.ts`         | The slot note: slot arithmetic, identifier and address, payload. The server imports it.                               |
| `src/notes.ts`                | Reading notes: one slot, a look back over several, and the clock correction.                                          |
| `src/follower.ts`             | Follows the feed by explicit slots, led by notes: the walk, the retry list, backoff, status, polling fallback.        |
| `src/pacer.ts`                | The spacing of reads of an address that came back missing, and why Bee needs it.                                      |
| `src/history.ts`              | Opening from the newest history file, and loading older files by click.                                               |
| `src/swarm.ts`                | Everything that touches bee-js: slot, head and file reads, and the inbox write.                                       |
| `src/chat.ts`                 | `SwarmChat`, which wires the parts together.                                                                          |
| `src/events.ts`               | `EVENTS`, `MessageData` and the emitter.                                                                              |

The package has two entries: the root, and `./message`, which the server uses and which loads none of the reader.

## What not to break

- **The message module is a contract with the server.** Its signed bytes, field caps and byte cap are shared, and the
  fixed vectors in `test/message.test.ts` must keep passing unchanged. A change to them is a change to the server too.
- **Sign and verify the raw bytes.** bee-js's `PrivateKey.sign` and `Signature.recoverPublicKey` hash and prefix
  inside, although the second names its parameter `digest`. Hashing first is how 6.2.8 came to prefix twice.
- **One signature per message, and per binding.** A signature counts only with v 27 or 28 and a low s
  (`src/message/canonicalSignature.ts`). bee-js recovers the same signer from the high s twin and from any other v.
- **The binding is the Swarm ID fork's, read as the fork reads it.** Its text, its site check and its signature
  spelling follow `verifyChatBinding` in solarpunk-id's `lib/src/utils/chat-binding.ts`, and `test/bindingVectors.ts`
  holds bindings the fork made on its `feat/site-chat-key` branch. Their chat address is the fork's per-site chat key,
  and `chatKeyFor` there derives it the way the fork's `deriveChatKey` does, so when the fork changes that derivation
  the vectors are made again from its built code. That signature is EIP-191 `personal_sign` over the text itself, which bee-js's
  `Signature` cannot recover, so `personalSign.ts` recovers through `@ethersphere/core-sdk/crypto` and passes v as a bigint.
  A binding that fails is refused as `binding`, never shown as a guest.
- **The wallet link is the fork's too, and travels only beside a binding.** Its text and both signatures follow
  `verifyWalletLink` in solarpunk-id's `lib/src/utils/wallet-link.ts`, described in its `docs/Wallet-Link.md`, and
  `test/walletLinkVectors.ts` holds links the fork made. Its account must be the binding's, and a link that fails is
  refused as `binding`. Its fields are appended to the signed bytes only when it is there, so the earlier vectors keep
  their bytes. The library never looks an ENS name up: it hands the checked wallet to the reader.
- **`verifyChatMessage` runs in a Web Worker.** It never throws and uses no DOM and no Node API, since a page verifies
  identities off its main thread. It gets the message from `MessageData.signedMessage`, so every event that carries a
  `MessageData` carries the message exactly as signed. A value `signedMessage` already carries gets no field of its own
  in `MessageData` unless a viewer renders it.
- **Every check of a message names the site.** `verifyChatMessage` and `parseChatMessage` require `{ origin }`, and a
  bound message checked without one is refused, so a binding for one site never passes in another site's chat. Keep
  the origin required, and never give it a default.
- **Never ask Bee for an address before it exists.** A failed read makes Bee skip its peers for that address for a
  minute, which delayed every new message by about forty seconds. A note is asked for only once its slot is over, and
  a feed slot only once a note named it. The head lookup and the polling of the next slot are kept only for a reader
  that finds no note, and an address that came back missing is asked for again no sooner than
  `DEFAULT_MISSING_READ_SPACING_MS` later (`src/pacer.ts`), so no address is read four times in a minute.
- **The note is a contract with the server**, as the message is: its identifier text, its payload and the slot length.
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
