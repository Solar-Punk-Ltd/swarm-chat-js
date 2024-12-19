A chat library for Swarm that enables real-time chatting over Swarm using the GSOC feature.

# Usage

Initalize the Swarm chat lib

```
  const newChat = new SwarmChat({
      gsocResourceId,
      topic,
      nickname,
      bees,
      ownAddress: wallet.address as EthAddress,
      privateKey: wallet.privateKey,
    });
```

Requirements

- gsocResourceId: Required for GSOC functionality. You must mine this ID using the mineResourceId function.
- Learn more about GSOC:
  https://blog.ethswarm.org/foundation/2024/bee-2-3-pre-release/
  https://github.com/ethersphere/SWIPs/blob/99e6cf90a4768b24d27e5339b205c18825b53322/SWIPs/swip-draft_graffiti-soc.md
  The project uses a forked version of @anythread/gsoc for GSOC nodes.

- topic: A simple string used to categorize the chat.
- nickname: A user-friendly name for identification.
- bees: Infrastructure settings for the library.
  Infrastructure Example:
  ```
    bees: {
      // example infrastructure settings
      multiBees: {
        gsoc: {
          multiBees: [
            {
              url: "",
              main: true,
            },
            {
              url: "",
              stamp: "" as BatchId,
            },
          ],
        },
        writer: {
          singleBee: {
            url: "",
            stamp: "" as BatchId,
          },
        },
        reader: {
          singleBee: {
            url: "",
          },
        },
      },
    },
  ```
- multiBees: Use multiple nodes for better performance.
  Main GSOC Node: Handles incoming messages.
  Writer Nodes: Write messages to the shared GSOC address.
  Reader Nodes: Read messages from the feeds.

- ownAddress: The public address of your wallet for authentication.
- privateKey: The private key of your wallet for feed writing. Do not use a wallet storing assets.

Starting and Stopping

- Start Chat: Use the start() method to subscribe to events and initialize intervals.
- Stop Chat: Use the stop() method to clean up resources.

Sending a Message

- Use the sendMessage(message: string) method to send a message.

Listening to Events
The library provides several events that can be subscribed to:

```
 const { on } = newChat.getEmitter();

  on(EVENTS.MESSAGE_REQUEST_SENT, (data: VisibleMessage) => {
      // Message with a loading flag
  });

  on(EVENTS.MESSAGE_REQUEST_ERROR, (data: { id: string }) => {
      // Message with an error flag
  });

  on(EVENTS.MESSAGE_RECEIVED, (data: VisibleMessage) => {
      // Successfully received message
  });

  on(EVENTS.LOADING_INIT_USERS, (data: boolean) => {
      // `true` on `listenToNewSubscribers` call
      // `false` on the first single read call
  });
```

# How it works

Determine Latest Index: The client fetches the user's latest feed index.

Keep Alive Messages: Sends periodic keepMeAlive GSOC messages to one of the GSOC nodes.

User Presence: All clients listen for keepMeAlive messages to check user presence.

Feed Updates: Each feed is read when there is a new index update, displaying new messages.

Punishment Mechanism: Prevents spam by penalizing users who send too many keepMeAlive messages.

# Limitations

Infrastructure: A single or small set of nodes may struggle with high traffic. Multiple nodes are recommended for scalability.

Default settings allow up to 20 users to chat with minimal latency.

GSOC Node Readiness: GSOC nodes are still under development and may occasionally fail under heavy load.

# Resources

Helpful docs:

- https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds
- https://blog.ethswarm.org/foundation/2024/bee-2-3-pre-release/
- https://github.com/ethersphere/SWIPs/blob/99e6cf90a4768b24d27e5339b205c18825b53322/SWIPs/swip-draft_graffiti-soc.md
- https://www.npmjs.com/package/@anythread/gsoc?activeTab=readme

An example demo project to demonstrate a simple use case:
https://github.com/Solar-Punk-Ltd/swarm-chat-react-example
