import protobuf, { Root, Type } from 'protobufjs';

import { MessageData, MessageStateRef } from '../interfaces/message';
import { ErrorHandler } from '../utils/error.js';

import { protoSchema } from './message';

let protoRoot: Root | null = null;
let messagePayloadType: Type | null = null;

const errorHandler = ErrorHandler.getInstance();

async function initializeProtobuf(): Promise<void> {
  if (!protoRoot) {
    protoRoot = Root.fromJSON(protobuf.parse(protoSchema).root);
    messagePayloadType = protoRoot.lookupType('MessagePayload');
  }
}

export async function decodeMessagePayload(
  buffer: Uint8Array,
): Promise<{ message: MessageData; messageStateRefs: MessageStateRef[] }> {
  await initializeProtobuf();
  if (!messagePayloadType) throw new Error('MessagePayload type not initialized');

  try {
    const decoded = messagePayloadType.decode(buffer);
    const decodedObject = messagePayloadType.toObject(decoded, {
      longs: String,
      enums: String,
      defaults: true,
    });

    if (!decodedObject.message) {
      throw new Error('Decoded object has no message field');
    }

    let additionalProps = decodedObject.message.additionalProps;
    if (additionalProps && typeof additionalProps === 'string') {
      try {
        additionalProps = JSON.parse(additionalProps);
      } catch (e) {
        console.warn('Failed to parse additionalProps as JSON:', additionalProps);
      }
    }

    const messageData: MessageData = {
      ...decodedObject.message,
      timestamp: Number(decodedObject.message.timestamp),
      additionalProps,
    };

    const messageStateRefs: MessageStateRef[] = (decodedObject.messageStateRefs || []).map((ref: MessageStateRef) => ({
      ...ref,
      timestamp: Number(ref.timestamp),
    }));

    return {
      message: messageData,
      messageStateRefs,
    };
  } catch (error) {
    errorHandler.handleError(error, 'ProtoMessage.decodeMessagePayload');
    throw error;
  }
}
