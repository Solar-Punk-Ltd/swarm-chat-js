import { FeedIndex, Identifier, Topic } from '@upcoming/bee-js';
import { Binary } from 'cafe-utility';

export function makeFeedIdentifier(topic: Topic, index: FeedIndex | number): Identifier {
  index = typeof index === 'number' ? FeedIndex.fromBigInt(BigInt(index)) : index;

  return new Identifier(Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), index.toUint8Array())));
}
