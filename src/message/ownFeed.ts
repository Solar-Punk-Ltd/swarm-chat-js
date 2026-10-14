/**
 * A sender may keep a copy of each message it sends in a feed of its own, owned by its chat address `addr`, and says
 * so with `own: true`. That feed is named by `ownFeedTopic(chatTopic)`, turned into a feed topic with
 * `Topic.fromString` as the chat's own feed is named by `chatTopic`. The prefix carries a version, so a later layout of
 * the copies takes a new topic rather than mixing with this one.
 */
export const OWN_FEED_TOPIC_PREFIX = 'swarm-chat-own-feed-v1:';

/** The topic string of the feed where the sender keeps its copies of the messages it sent to chat `chatTopic`. */
export function ownFeedTopic(chatTopic: string): string {
  return `${OWN_FEED_TOPIC_PREFIX}${chatTopic}`;
}
