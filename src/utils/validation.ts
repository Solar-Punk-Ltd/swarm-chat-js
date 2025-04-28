import { Signature } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { z } from 'zod';

import { Logger } from './logger';

const logger = Logger.getInstance();

const UserSchema = z.object({
  username: z.string(),
  address: z.string(),
  timestamp: z.number(),
  index: z.number(),
  signature: z.string(),
});

const HistoryEntrySchema = z.object({
  id: z.number(),
  ref: z.string(),
  updater: z.string(),
  timestamp: z.number(),
});

const GsocMessageSchema = z.object({
  topic: z.string(),
  messageSender: UserSchema.optional(),
  historyEntry: HistoryEntrySchema,
});

const UserHistorySchema = z.object({
  events: z.array(z.object({ type: z.string(), timestamp: z.number() })),
  messageEntries: z.array(z.object({ index: z.number(), timestamp: z.number() })),
});

const ChatHistorySchema = z.object({
  allTimeUsers: z.record(UserHistorySchema),
});

export function validateGsocMessage(message: any): boolean {
  const result = GsocMessageSchema.safeParse(message);
  if (!result.success) {
    logger.warn(result.error.format());
    return false;
  }
  if (message.messageSender && !validateUser(message.messageSender)) {
    console.warn('Invalid messageSender');
    return false;
  }
  if (!validateHistoryEntry(message.historyEntry)) {
    console.warn('Invalid historyEntry');
    return false;
  }
  return true;
}

export function validateHistoryEntry(entry: any): boolean {
  const result = HistoryEntrySchema.safeParse(entry);
  if (!result.success) {
    logger.warn(result.error.format());
    return false;
  }
  return true;
}

export function validateChatHistory(chatHistory: any): boolean {
  const result = ChatHistorySchema.safeParse(chatHistory);
  if (!result.success) {
    logger.warn(result.error.format());
    return false;
  }
  return true;
}

export function validateUserHistory(userHistory: any): boolean {
  const result = UserHistorySchema.safeParse(userHistory);
  if (!result.success) {
    logger.warn(result.error.format());
    return false;
  }
  return true;
}

export function validateUser(user: any): boolean {
  const result = UserSchema.safeParse(user);
  if (!result.success) {
    logger.warn(result.error.format());
    return false;
  }

  return validateUserSignature(user);
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
