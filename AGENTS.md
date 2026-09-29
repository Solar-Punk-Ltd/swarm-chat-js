# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**swarm-chat-js** (`@solarpunkltd/swarm-chat-js`) is a client-side JavaScript/TypeScript library for building decentralized chat applications on the Ethereum Swarm network.

**Critical Architecture Note:** This library is **not standalone** - it requires a companion aggregator server ([swarm-chat-aggregator-js](https://github.com/Solar-Punk-Ltd/swarm-chat-aggregator-js)) to function. The library handles client-side message sending and receiving, while the aggregator consolidates messages from multiple users into a shared chat feed.

## Commands

### Build & Development

```bash
pnpm build              # Build library (ES, CJS, UMD formats) - outputs to dist/
pnpm lint               # Run ESLint
pnpm lint:fix           # Auto-fix linting issues
```

### Mining Helper Script

```bash
pnpm run mine -- <bee-address> <topic-name>   # Mine GSOC resource ID for a topic
```

The mine script (`src/scripts/mine.ts`) generates the GSOC resource ID and topic needed for chat configuration.

## High-Level Architecture

### Message Flow Pattern

The library implements a hub-and-spoke messaging architecture:

1. **User Sends Message:**
   - Client writes message to user's own Swarm feed (`userTopic`)
   - Client broadcasts notification to GSOC address

2. **Aggregator Processing:**
   - Aggregator server listens to GSOC notifications
   - Fetches message from user's feed
   - Writes to shared chat feed (`chatTopic` at `chatAddress`)

3. **Message Retrieval:**
   - Clients poll or subscribe to shared chat feed
   - Messages emitted via event system

### Transport Strategy Pattern

The library uses a pluggable transport system (`src/transports/`):

- **`MessageTransport` interface**: Defines contract for message delivery mechanisms
- **`PollingTransport`**: Default implementation that polls the chat feed at intervals (1s default)
- **Custom transports**: Can be injected via constructor for alternative strategies (e.g., Waku for real-time push)

This pattern allows switching between polling and push-based messaging without changing core logic.

**Dual Transport Mode (Fallback Polling):**

When using unreliable custom transports (e.g., Waku), enable fallback polling as a reliable backup:

```typescript
const settings: ChatSettings = {
  // ... other settings
  infra: {
    // ... other infra settings
    enableFallbackPolling: true, // Enable backup polling
    fallbackPollingInterval: 4000, // Poll every 4s (default: 4000ms)
  },
};

const chat = new SwarmChat(settings, customWakuTransport);
```

**How it works:**

- Both transports run simultaneously
- Primary transport (e.g., Waku) delivers messages in real-time when working
- Fallback polling runs at slower interval (4s) as backup
- Both transports emit `MESSAGE_RECEIVED` events independently
- If primary transport fails/misses messages, polling catches them within 4 seconds

**Note:** Both transports can emit the same message, resulting in duplicate `MESSAGE_RECEIVED` events. Client applications should implement deduplication logic using the message `id` field if needed.

### Two Upload Modes: Owned vs Enveloped

The library supports two distinct modes for uploading data to Swarm, controlled by the `enveloped` setting:

**Owned Mode (`enveloped: false`):**

- Uses the Bee node's postage stamp for uploads
- Simpler integration - the Bee node handles stamping
- Requires `stamp` parameter to be a valid postage batch on the connected Bee node

**Enveloped Mode (`enveloped: true`):**

- Client-side stamping using user's private key
- Stamp can be from any source (not tied to specific Bee node)
- Enables use of gateway nodes without local stamps
- Implemented via `Stamper.fromBlank()` pattern

Key implementation locations:

- `SwarmChatUtils.writeOwnFeedDataByIndex()` - src/lib/utils.ts:34
- `SwarmChatUtils.uploadObjectToBee()` - src/lib/utils.ts:103
- `SwarmChatUtils.sendMessageToGsoc()` - src/lib/utils.ts:191

### Message State Management

**History System** (`src/lib/history.ts`):

- Manages message state references (`messageStateRefs`) from aggregator
- Implements retry logic with exponential backoff (3 max retries)
- Bans persistently failing references to prevent infinite loops
- Caches processed refs to avoid duplicate processing

**Feed Indexing:**

- User feeds use sequential indices (0, 1, 2...)
- Chat feed index tracks latest aggregated message
- `ownIndex` in `ChatSettingsUser` tracks user's current position

### Event-Driven Architecture

The library emits events via `EventEmitter` (`src/utils/eventEmitter.ts`):

```
LOADING_INIT                    # Initialization started/completed
LOADING_PREVIOUS_MESSAGES       # Fetching history
MESSAGE_RECEIVED                # New message from chat feed
MESSAGE_REQUEST_INITIATED       # User started sending
MESSAGE_REQUEST_UPLOADED        # Message written to user's feed
MESSAGE_REQUEST_ERROR           # Send failed
CRITICAL_ERROR                  # Unrecoverable error
```

Client applications subscribe to these events to update UI state.

### Message Types System

Three message types (`src/interfaces/message.ts`):

- **`MessageType.TEXT`**: Standard chat messages
- **`MessageType.THREAD`**: Replies referencing `targetMessageId`
- **`MessageType.REACTION`**: Emoji reactions to messages via `targetMessageId`

All messages include:

- Cryptographic signature (signed with user's private key)
- Timestamp
- Sequential index in user's feed
- Optional `additionalProps` for extensions

## Key Technical Details

### GSOC (Generic Swarm Offchain Communication)

- Pub/sub layer for message notifications
- Requires mined resource ID matching specific difficulty
- Used for broadcasting message updates to aggregator
- Topic and resource ID must be pre-mined using mine script

### Feed Structure

- **User Feed Topic**: `{chatTopic}_EthercastChat_{userAddress}` (generated in `src/lib/utils.ts:18`)
- **Chat Feed**: Owned by aggregator at `chatAddress` with `chatTopic`
- Feeds use SOC (Single Owner Chunks) for updates

### Validation Layer

Located in `src/utils/validation.ts`:

- Schema validation using Zod
- Validates GSOC messages (`StatefulMessage` format)
- Validates user messages with additional properties
- Ensures message state integrity

### Error Handling

- Centralized via `ErrorHandler` singleton (`src/utils/error.ts`)
- Logger singleton for consistent logging (`src/utils/logger.ts`)
- Special handling for "not found" errors (404s indicate feed doesn't exist yet)

## Build System

**Vite Configuration** (`vite.config.js`):

- Builds three output formats: ES modules, CJS, and UMD
- Generates TypeScript declarations via `vite-plugin-dts`
- Node polyfills for browser compatibility
- Externalizes `@ethersphere/bee-js` as peer dependency

**Entry Point**: `src/index.ts` exports public API:

- `SwarmChat` class (main interface)
- `EVENTS` constants
- Type exports: `MessageData`, `ChatSettings`, `MessageType`, etc.
- Transport types for custom implementations

## Code Organization

```
src/
├── index.ts                    # Public API exports
├── lib/
│   ├── core.ts                 # SwarmChat main class
│   ├── utils.ts                # SwarmChatUtils (Bee operations)
│   ├── history.ts              # Message state management
│   └── constants.ts            # Event constants
├── interfaces/
│   ├── chat.ts                 # ChatSettings interfaces
│   └── message.ts              # Message data structures
├── transports/
│   ├── MessageTransport.ts     # Transport interface
│   └── PollingTransport.ts     # Default polling implementation
├── utils/
│   ├── bee.ts                  # Low-level Bee helpers (SOC, CAC)
│   ├── validation.ts           # Zod schemas
│   ├── eventEmitter.ts         # Event system
│   ├── error.ts                # Error handling
│   ├── logger.ts               # Logging
│   └── common.ts               # Utilities (retry, hex conversion)
└── scripts/
    └── mine.ts                 # GSOC mining script
```

## Common Development Patterns

### Adding New Message Properties

To extend messages with custom data:

1. Add to `AdditionalMessageProperties` in message data
2. Validation happens via `validateMessageWithAdditionalProperties()`
3. No schema changes needed - uses flexible object type

### Implementing Custom Transport

Example pattern from codebase:

```typescript
class CustomTransport implements MessageTransport {
  private callback: ((msg: MessageData) => void) | null = null;

  onMessage(cb: (msg: MessageData) => void) {
    this.callback = cb;
  }

  async start() {
    // Initialize transport, call this.callback(msg) when messages arrive
  }

  async stop() {
    // Cleanup
  }
}

// Without fallback (standalone custom transport):
const chat = new SwarmChat(settings, new CustomTransport());

// With fallback polling (recommended for unreliable transports):
const settingsWithFallback: ChatSettings = {
  ...settings,
  infra: {
    ...settings.infra,
    enableFallbackPolling: true,
    fallbackPollingInterval: 4000, // 4s backup polling
  },
};
const chat = new SwarmChat(settingsWithFallback, new CustomTransport());
```

**Note:** When using fallback mode, both transports can emit duplicate messages. Client applications should deduplicate using message `id` fields if necessary.

### Working with Feeds

The library uses bee-js feed readers/writers:

- **Read**: `bee.makeFeedReader(topic, owner).downloadPayload()`
- **Write**: `bee.makeFeedWriter(topic, signer).uploadPayload(stamp, data, { index })`

See `SwarmChatUtils` for reference implementations.

## Dependencies

**Core:**

- `@ethersphere/bee-js` ^9.0.3 - Swarm network client
- `cafe-utility` ^27.12.1 - Merkle trees, binary utilities
- `zod` ^3.24.1 - Runtime validation

**Development:**

- TypeScript 5.2.2
- Vite 5.0.8 - Build tool
- ESLint with TypeScript parser
- Import sorting via `simple-import-sort`

## Important Constraints

1. **Aggregator Dependency**: Cannot function without aggregator server running
2. **GSOC Requirements**: Resource ID must be mined before use (difficulty constraint)
3. **Stamp Management**: Must provide valid postage stamp (owned mode) or enveloped stamp data
4. **Sequential Indices**: User feed indices must be sequential - gaps cause issues
5. **Browser Compatibility**: Requires modern browser with fetch, Uint8Array support
