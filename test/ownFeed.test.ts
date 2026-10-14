import { describe, expect, it } from 'vitest';

import { OWN_FEED_TOPIC_PREFIX, ownFeedTopic } from '../src/message';

describe('ownFeedTopic', () => {
  it('is the versioned prefix and the chat topic', () => {
    expect(OWN_FEED_TOPIC_PREFIX).toBe('swarm-chat-own-feed-v1:');
    expect(ownFeedTopic('chat-devcon-main')).toBe('swarm-chat-own-feed-v1:chat-devcon-main');
  });

  it('is the same for one chat every time, and differs between chats', () => {
    expect(ownFeedTopic('chat-a')).toBe(ownFeedTopic('chat-a'));
    expect(ownFeedTopic('chat-a')).not.toBe(ownFeedTopic('chat-b'));
  });

  it('never equals the chat topic itself, so the copies never land in the chat feed', () => {
    expect(ownFeedTopic('chat-a')).not.toBe('chat-a');
  });
});
