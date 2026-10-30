# Changelog

What each release of `@solarpunkltd/swarm-chat-js` changes for a page or a server that uses it.

## 10.0.0

- `verifyChatMessage` and `parseChatMessage` take `{ origins }`, a list of the sites whose chat this is, in place of
  `{ origin }`, and accept a binding for any one of them. A chat served from several pages lists each, so a message
  signed in on one shows as signed in on all. A single site is `{ origins: [site] }`. `checkChatBinding`'s optional
  `origin` is `origins` too. An empty list refuses every bound message as `binding`.

## 9.0.0

- The message, the feed entry and the history file are version 9. A version 8 message, entry or history file fails its
  shape check. Update the server before any page sends a version 9 message, because a server on 8.x refuses every one
  as `shape`.
- A message may carry the sender's Swarm ID wallet link, `wl`, beside its binding, signed with the rest. A verified link
  puts the wallet on `identity.wallet`, and a link that fails refuses the message as `binding`.
- `SwarmChat` takes `user.walletLink`, `createChatMessage` takes `wl`, and `checkWalletLink` checks a link on its own.
- The message no longer has an `own` field. It is gone from the shape, the signed bytes and the payload, and so are
  `infra.own` and the draft's `own`. Whether a sender keeps a copy is read from its own feed. A message, feed entry or
  history row that carries `own` is refused as `shape`.
- A display name with a Unicode format or control character, or with a letter that shows as nothing, is refused as
  `shape`. See [Display names](README.md#display-names).
- A display name that reads as ending in `.eth` is refused as `shape`, so a chosen name cannot pass for a verified ENS
  name.

## 8.1.0

- `infra.own` signs every message with `own: true`, for a page that keeps a copy in the sender's own feed.

## 8.0.0

- The version 8 message adds `via`, `own` and, for a signed-in sender, `idb`, its Swarm ID chat binding, all signed. A
  version 7 message, entry or history file fails its shape check.
- `verifyChatMessage` replaces `checkChatMessage` and also checks the binding, returning the sender's `identity`. It and
  `parseChatMessage` require `{ origin }`, the site whose chat this is. A failed binding is refused with the reason
  `binding`.
- `MAX_MESSAGE_BYTES` is 3,072, so a long text fits beside a binding.
- `createChatMessage` requires `via` and takes `own` and `idb`. `SwarmChat` requires `infra.via` and takes
  `user.binding`.
- `ownFeedTopic` names the feed where a sender keeps its copies.
- `MessageData.signedMessage` carries the whole signed message, for a page to verify. `chatTopic`, `signature` and
  `sentAt` are removed from `MessageData`, because `signedMessage` carries them as `topic`, `sig` and `ts`.
- The binding is recovered through `@ethersphere/core-sdk`, a new dependency that bee-js 13 already installs.

## 7.3.0

- A reader asks Bee for an address that came back missing no more than three times a minute, for feed entries and
  notes alike. This keeps the first messages in a quiet chat from arriving late.

## 7.2.0

- Readers follow a chat by its slot notes and no longer ask for the next feed index before it exists, so a new message
  arrives in seconds. Opening needs no newest-index lookup either. A server without notes is still followed by polling.
- The note format is exported from the root and from `./message`, for the server. New settings `infra.noteSlotMs` and
  `infra.noteHeartbeatMs`.

## 7.0.0, from 6.x

- Messages are signed over every field and verified by the server. 6.x signed four fields with a double prefix, and its
  check accepted forged messages.
- One inbox write per message. The write to the sender's own feed is removed, and so are `userTopic`,
  `additionalProps` and the `enveloped` setting.
- A bad message or history row is skipped and never stops the chat. An entry no peer serves is stepped past and read
  again later.
- The reader no longer checks a signature per message, which cost about 36 ms of main thread per message on open.
- `sendMessage` takes three arguments, and a reaction resolves to `null`. `retrySendMessage` replaces
  `retryBroadcastUserMessage`.
- `stop` keeps listeners. New events: `STATUS`, `MESSAGE_SKIPPED` and `ERROR`. `CRITICAL_ERROR` means three failed
  openings in a row, and opening keeps trying.
- `MessageData.index` is the feed index, and `timestamp` is the server's receive time.
- The script that mines the inbox key is in the server repository, whose operator mines the key.
- The package is ESM first with a CommonJS build. The UMD bundle and the Node polyfills are removed.
