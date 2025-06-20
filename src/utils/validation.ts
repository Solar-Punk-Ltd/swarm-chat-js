import { Signature } from '@ethersphere/bee-js';
import { UserComment } from '@solarpunkltd/comment-system';
import { Binary, Types } from 'cafe-utility';
import { z } from 'zod';

import { MessageType } from '../interfaces/message';

import { Logger } from './logger';

const logger = Logger.getInstance();

const MessageSchema = z.object({
  id: z.string(),
  targetMessageId: z.string().optional(),
  type: z.nativeEnum(MessageType),
  message: z.string(),
  username: z.string(),
  address: z.string(),
  timestamp: z.number(),
  signature: z.string(),
  index: z.number(),
  chatTopic: z.string(),
  userTopic: z.string(),
});

const StateRefSchema = z.object({
  reference: z.string(),
  timestamp: z.number(),
});

const StatefulMessageSchema = z.object({
  message: MessageSchema,
  messageStateRefs: z.array(StateRefSchema).nullable(),
});

export function validateGsocMessage(message: any): boolean {
  const result = StatefulMessageSchema.safeParse(message);
  if (!result.success) {
    logger.warn('GSOC message validation failed:', result.error.format());
    return false;
  }

  if (!validateUserSignature(message.message)) {
    logger.warn('Invalid main message signature');
    return false;
  }

  return true;
}

export function validateMessageState(messageState: any[]): boolean {
  if (!Array.isArray(messageState)) {
    logger.warn('Message state must be an array');
    return false;
  }

  for (const message of messageState) {
    if (!validateMessageData(message)) {
      logger.warn('Invalid message in message state:', message.id);
      return false;
    }
  }

  return true;
}

export function validateMessageData(message: any): boolean {
  const result = MessageSchema.safeParse(message);
  if (!result.success) {
    logger.warn('Message data validation failed:', result.error.format());
    return false;
  }

  if (!validateUserSignature(message)) {
    logger.warn('Invalid message signature');
    return false;
  }

  return true;
}

export function validateUserSignature(validatedUser: any): boolean {
  try {
    const message = {
      username: validatedUser.username,
      address: validatedUser.address,
      timestamp: validatedUser.timestamp,
    };

    const ENCODER = new TextEncoder();
    const digest = Binary.concatBytes(
      ENCODER.encode(`\x19Ethereum Signed Message:\n32`),
      Binary.keccak256(ENCODER.encode(JSON.stringify(message))),
    );

    const isValidSig = new Signature(validatedUser.signature).isValid(digest, validatedUser.address);

    if (isValidSig) {
      throw new Error('Signature verification failed!');
    }

    return true;
  } catch (error) {
    logger.warn('Error in validateUserSignature', error);
    return false;
  }
}
