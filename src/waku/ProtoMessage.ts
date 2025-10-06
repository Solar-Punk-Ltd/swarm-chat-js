import path from 'path';
import protobuf from 'protobufjs';

import { MessageData, MessageStateRef } from '../interfaces/message';

// eslint-disable-next-line
const { load } = protobuf;
type Root = protobuf.Root;
type Type = protobuf.Type;

let protoRoot: Root | null = null;
let messagePayloadType: Type | null = null;

async function initializeProtobuf(): Promise<void> {
  if (!protoRoot) {
    protoRoot = await load(path.join(__dirname, '../waku/message.proto'));
    protoRoot.resolveAll();
    messagePayloadType = protoRoot.lookupType('MessagePayload');
  }
}

export async function decodeMessagePayload(
  buffer: Uint8Array,
): Promise<{ message: MessageData; messageStateRefs: MessageStateRef[] }> {
  await initializeProtobuf();
  if (!messagePayloadType) throw new Error('MessagePayload type not initialized');

  const reverseTypeMap = { 0: 'text', 1: 'thread', 2: 'reaction' };

  try {
    const decoded = messagePayloadType.decode(buffer);
    const decodedObject = messagePayloadType.toObject(decoded);

    const messageData: MessageData = {
      ...decodedObject.message,
      type: reverseTypeMap[decodedObject.message.type as keyof typeof reverseTypeMap] ?? 'text',
    };

    const messageStateRefs: MessageStateRef[] = decodedObject.messageStateRefs || [];

    return {
      message: messageData,
      messageStateRefs,
    };
  } catch (error) {
    throw new Error(`Failed to decode message payload: ${error}`);
  }
}
