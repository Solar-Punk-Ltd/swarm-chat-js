# Swarm Chat JS Library 🐝💬

The core client-side library for building decentralized chat applications over [Swarm](https://www.ethswarm.org/). This library provides the essential logic for sending, receiving, and managing chat messages within a Swarm ecosystem.

**Important Note:** `swarm-chat-js` is designed to work in conjunction with a companion aggregator server. It is **not functional as a standalone library** for a complete chat system. The aggregator is responsible for collecting messages broadcast by users and consolidating them into a shared chat feed.

The current reference implementation works with the [Solar-Punk-Ltd/swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js).

---

## ⚙️ How It Works

`swarm-chat-js` enables decentralized communication by leveraging Swarm's features like Feeds and GSOC.

**Conceptual Overview:**

Users broadcast their messages via updates to their personal Swarm feeds, with notifications sent to a pre-defined GSOC address. A dedicated **aggregator server** listens to this GSOC message. When new message notifications arrive, the aggregator fetches the message content, processes it, and then writes it to a common, persistent, protected Swarm feed (the "chat feed"). Client applications polling this aggregated chat feed to display messages to users (built into `swarm-chat-js`).

**Message Flow:**

1.  **User Sends Message:** A user types and sends a message using an application built with `swarm-chat-js`.
    - The message is written to the user's own Swarm feed.
    - An update is broadcast to a designated GSOC address.
2.  **Aggregator Receives & Processes:** The aggregator server, subscribed to the GSOC address, receives the update.
    - It may perform validation or other processing steps.
3.  **Aggregator Writes to Chat Feed:** The aggregator writes the processed message to the main, shared "chat feed".
4.  **Client App Reads:** `swarm-chat-js` in other users' applications polls this main chat feed for new messages and displays them.

---

## 📦 Installation

You can install the library using npm or pnpm:

```bash
npm/pnpm install @solarpunkltd/swarm-chat-js
```

---

## 🛠️ Core Concepts & API

### Imports

```typescript
import { EVENTS, MessageData, MessageType, SwarmChat, ChatSettings } from '@solarpunkltd/swarm-chat-js';
```

### `ChatSettings` Interface

This configuration object is crucial for initializing the `SwarmChat` instance.

```typescript
export interface ChatSettings {
  user: {
    /** Private key of the chat user, used for signing updates to their own Swarm feed. */
    privateKey: string;
    /** Display name or nickname of the current user. */
    nickname: string;
  };
  infra: {
    /** URL of the Bee node used by the client to write to their own feed and to poll the aggregated chat feed. */
    beeUrl: string;
    /**
     * If true, a postage stamp (`stamp` property) must be provided for uploading messages.
     * The stamp does not necessarily need to be tied to the `beeUrl` node; it can be an independent stamp. (Enveloped stamp)
     */
    enveloped: boolean;
    /** Optional: Postage stamp ID. Required if `enveloped` is true, unless `beeUrl` points to a gateway with auto-stamping capabilities. */
    stamp?: string;
    /** The mined GSOC topic string where users broadcast updates about their new messages. */
    gsocTopic: string;
    /** The mined GSOC resource ID (address) associated with the `gsocTopic`. */
    gsocResourceId: string;
    /** The topic of the aggregated chat feed, written by the aggregator server. */
    chatTopic: string;
    /** The public address (Swarm feed address) of the aggregated chat feed, written by the aggregator. */
    chatAddress: string;
  };
}
```

### Events (`EVENTS`)

The library emits several events that your application can subscribe to for reacting to different stages of the chat lifecycle. Use `SwarmChat.getEmitter().on(EVENT_NAME, callback)` to subscribe.

- `EVENTS.LOADING_INIT`: ('loadingInit')
  Fired when the chat library begins its initialization process.
- `EVENTS.LOADING_PREVIOUS_MESSAGES`: ('loadingPreviousMessages')
  Fired when the library is actively loading previous messages from the chat feed.
- `EVENTS.MESSAGE_RECEIVED`: ('messageReceived')
  A new message has been successfully received from the aggregated chat feed and processed by the client.
- `EVENTS.MESSAGE_REQUEST_INITIATED`: ('messageRequestInitiated')
  The current user has initiated the process of sending a new message.
- `EVENTS.MESSAGE_REQUEST_UPLOADED`: ('messageRequestUploaded')
  The current user's message has been successfully uploaded to their own feed. (Note: The broadcast to the GSOC for aggregator pickup can still be pending or fail after this event).
- `EVENTS.MESSAGE_REQUEST_ERROR`: ('messageRequestError')
  An error occurred during the message sending process (either uploading to the user's feed or broadcasting via GSOC).
- `EVENTS.CRITICAL_ERROR`: ('criticalError')
  The library has encountered a critical, potentially unrecoverable error.

### Main `SwarmChat` Methods

The `SwarmChat` class instance provides the following core methods:

- `start()`: Initializes and starts the chat service, including setting up listeners and beginning to poll for messages.
- `stop()`: Stops the chat service, clears intervals, and cleans up resources.
- `getEmitter()`: Returns an event emitter instance, allowing your application to subscribe to the `EVENTS` listed above.
- `sendMessage(message: string, type: MessageType, targetMessageId?: string, id?: string)`: Initiates the process of sending a new chat message from the current user. Supports different message types including text, threads, and reactions.
- `fetchPreviousMessages()`: Manually triggers the fetching of older messages from the aggregated chat feed.
- `hasPreviousMessages()`: Returns a boolean indicating whether there are previous messages available to fetch (determined by checking if more than one message state reference exists).
- `retrySendMessage(message: MessageData)`: Attempts to resend a message that previously encountered an error during the initial request phase (e.g., failed to write to the user's own feed).
- `retryBroadcastUserMessage(message: MessageData)`: Attempts to re-broadcast a message update via GSOC if the message was successfully uploaded to the user's feed but the GSOC broadcast might have failed or needs retrying.

### Message Types

The library supports three types of messages through the `MessageType` enum:

- `MessageType.TEXT`: Regular chat messages
- `MessageType.THREAD`: Reply messages that reference a parent message via `targetMessageId`
- `MessageType.REACTION`: Emoji reactions to existing messages, also using `targetMessageId` to reference the target message

### Message State Management

The library includes robust message state handling with:

- **Automatic retry logic**: Failed message state references are automatically retried with exponential backoff
- **Ref banning**: Persistently failing references are banned after maximum retry attempts to prevent infinite loops
- **Efficient caching**: Message state data is cached to avoid redundant network requests

---

## 🚀 Usage Example (React)

Here's an example of how `swarm-chat-js` can be integrated into a React application using a custom hook (`useSwarmChat`). This hook encapsulates chat logic, state management, and event handling.

### Complete Implementation

For a full working example, check out our React integration:

**📖 [View Complete useSwarmChat Hook Implementation](https://github.com/Solar-Punk-Ltd/swarm-chat-react-example/blob/master/src/hooks/useSwarmChat.tsx)**

### Basic Usage

```typescript
import { useSwarmChat } from './hooks/useSwarmChat';
import { MessageType } from '@solarpunkltd/swarm-chat-js';

function ChatComponent() {
  const { messages, isLoading, sendMessage, hasPreviousMessages, loadPreviousMessages } = useSwarmChat(chatSettings);

  const handleSendMessage = (text: string) => {
    sendMessage(text, MessageType.TEXT);
  };

  const handleReaction = (targetMessageId: string, emoji: string) => {
    sendMessage(emoji, MessageType.REACTION, targetMessageId);
  };

  const handleReply = (targetMessageId: string, replyText: string) => {
    sendMessage(replyText, MessageType.THREAD, targetMessageId);
  };

  return (
    <div className="chat-container">
      {/* Your chat UI implementation */}
      {hasPreviousMessages() && <button onClick={loadPreviousMessages}>Load Previous Messages</button>}
      {/* Message list, input field, etc. */}
    </div>
  );
}
```

---

## ⛏️ Helper Scripts

### Mine GSOC Address

The library provides a helper script to mine a GSOC address and topic. This is typically used when setting up your aggregator server.

**Usage:**

```bash
npm run mine -- <bee-address> <topic-name>
```

---

## ⚠️ Limitations

- **Polling Mechanism:** The current version of `swarm-chat-js` relies on polling the aggregator's chat feed to fetch new messages. This approach can be resource-heavy.

---

## 💡 Future Development

- **Push-Based Event System:** We are actively designing a new architecture to transition from the polling mechanism to a more efficient, push-based event system for message delivery. This will significantly reduce node load and improve real-time message propagation.
- **Performance Optimizations:** Further improvements to message state handling and caching mechanisms.

---

## 📚 Further Reading & Resources

- [What are Feeds? (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [GSOC Introduction (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/gsoc/#introduction)
- [Example Aggregator: Solar-Punk-Ltd/swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js)
- [Example React client](https://github.com/Solar-Punk-Ltd/swarm-chat-react-example)

---
