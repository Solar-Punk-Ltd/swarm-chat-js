import { Signature } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { z } from 'zod';

import { Logger } from './logger';

const logger = Logger.getInstance();

const MessageSchema = z.object({
  id: z.string(),
  targetMessageId: z.string().optional(),
  type: z.enum(['text', 'thread', 'reaction']),
  message: z.string(),
  username: z.string(),
  address: z.string(),
  timestamp: z.number(),
  signature: z.string(),
  index: z.number(),
  chatTopic: z.string(),
  userTopic: z.string(),
});

const MessageWithReactionsSchema = z.object({
  message: MessageSchema,
  reactionState: z.string(),
});

export function validateGsocMessage(message: any): boolean {
  const result = MessageWithReactionsSchema.safeParse(message);
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

export function validateReactionState(reactionState: any[]): boolean {
  if (!Array.isArray(reactionState)) {
    logger.warn('Reaction state must be an array');
    return false;
  }

  for (const reaction of reactionState) {
    if (!validateMessageData(reaction)) {
      logger.warn('Invalid reaction in reaction state:', reaction.id);
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
