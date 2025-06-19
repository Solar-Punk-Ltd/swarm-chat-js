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

export function assertComment(value: unknown): asserts value is UserComment {
  if (!Types.isStrictlyObject(value)) {
    throw new TypeError('UserComment has to be object!');
  }

  const comment = value as unknown as UserComment;

  if (!Types.isStrictlyObject(comment.message)) {
    throw new TypeError('UserComment.message has to be object!');
  }

  if (typeof comment.message.text !== 'string') {
    throw new TypeError('text property of UserComment.message has to be string!');
  }

  if (comment.message.messageId !== undefined && typeof comment.message.messageId !== 'string') {
    throw new TypeError('messageId property of UserComment.message has to be string!');
  }

  if (comment.message.threadId !== undefined && typeof comment.message.threadId !== 'string') {
    throw new TypeError('threadId property of UserComment.message has to be string!');
  }

  if (comment.message.parent !== undefined && typeof comment.message.parent !== 'string') {
    throw new TypeError('parent property of UserComment.message has to be string!');
  }

  if (!Types.isStrictlyObject(comment.user)) {
    throw new TypeError('UserComment.user has to be object!');
  }

  if (typeof comment.timestamp !== 'number') {
    throw new TypeError('timestamp property of UserComment has to be number!');
  }

  if (typeof comment.user.address !== 'string') {
    throw new TypeError('address property of UserComment.user has to be string!');
  }

  if (typeof comment.user.username !== 'string') {
    throw new TypeError('username property of UserComment.user has to be string!');
  }
}

export function isEmpty(obj?: object | Array<any>): boolean {
  if (!obj) {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.length === 0;
  }
  return Object.keys(obj).length === 0;
}

// TODO: merge comment and messagedata
// const CommentSchema = z.object({
//   id: z.string(),
//   targetMessageId: z.string().optional(),
//   type: z.nativeEnum(MessageType),
//   message: z.string(),
//   username: z.string(),
//   address: z.string(),
//   timestamp: z.number(),
//   index: z.number(),
//   topic: z.string(),
// });

// const CommentStateRefSchema = z.object({
//   reference: z.string(),
//   timestamp: z.number(),
// });

// const UserStateRefSchema = z.object({
//   username: z.string(),
//   address: z.string(),
// });

// const CommentStatefulMessageSchema = z.object({
//   message: CommentSchema,
//   messageStateRefs: z.array(CommentStateRefSchema).nullable(),
// });

// export function validateUserComment(message: any): boolean {
//   const result = CommentStatefulMessageSchema.safeParse(message);
//   if (!result.success) {
//     logger.warn('UserComment message validation failed:', result.error.format());
//     return false;
//   }

//   return true;
// }
