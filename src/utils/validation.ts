import { Signature } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';
import { z } from 'zod';

import { MessageType } from '../interfaces/message';

import { Logger } from './logger';

const logger = Logger.getInstance();

export const CORE_MESSAGE_PROPERTIES = [
  'id',
  'targetMessageId',
  'type',
  'message',
  'username',
  'address',
  'timestamp',
  'signature',
  'index',
  'chatTopic',
  'userTopic',
  'additionalProps',
];

const MessageSchema = z
  .object({
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
    additionalProps: z.record(z.any()).optional(),
  })
  .refine(
    (data) => {
      if (!data.additionalProps || Object.keys(data.additionalProps).length === 0) {
        return true;
      }

      const validation = validateAdditionalPropertiesInternal(data.additionalProps);
      return validation.isValid;
    },
    {
      message: 'Invalid additional properties in message',
    },
  );

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
      message: validatedUser.message,
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

export function validateAdditionalPropertiesInternal(additionalProps: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (additionalProps === null || additionalProps === undefined) {
    return { isValid: true, errors: [] };
  }

  if (typeof additionalProps !== 'object' || Array.isArray(additionalProps)) {
    errors.push('Additional properties must be a plain object');
    return { isValid: false, errors };
  }

  for (const key of Object.keys(additionalProps)) {
    if (CORE_MESSAGE_PROPERTIES.includes(key)) {
      errors.push(`Property '${key}' is reserved and cannot be overridden`);
    }
  }

  const serialized = JSON.stringify(additionalProps);
  const sizeInBytes = new TextEncoder().encode(serialized).length;
  const MAX_SIZE = 1 * 1024; // 1KB limit

  if (sizeInBytes > MAX_SIZE) {
    errors.push(`Additional properties too large: ${sizeInBytes} bytes (max: ${MAX_SIZE} bytes)`);
  }

  const MAX_DEPTH = 5;
  function checkDepth(obj: any, depth = 0): boolean {
    if (depth > MAX_DEPTH) return false;

    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      for (const value of Object.values(obj)) {
        if (!checkDepth(value, depth + 1)) return false;
      }
    }
    return true;
  }

  if (!checkDepth(additionalProps)) {
    errors.push(`Additional properties nested too deeply (max depth: ${MAX_DEPTH})`);
  }

  for (const [key, value] of Object.entries(additionalProps)) {
    if (key.length > 100) {
      errors.push(`Property key '${key}' too long (max: 100 characters)`);
    }

    if (typeof value === 'string' && value.length > 1000) {
      errors.push(`Property '${key}' value too long (max: 1000 characters)`);
    }

    if (typeof value === 'string') {
      const dangerousPatterns = [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /javascript:/gi,
        /data:text\/html/gi,
        /vbscript:/gi,
        /on\w+\s*=/gi,
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(value)) {
          errors.push(`Property '${key}' contains potentially dangerous content`);
          break;
        }
      }
    }
  }

  const MAX_PROPERTIES = 20;
  if (Object.keys(additionalProps).length > MAX_PROPERTIES) {
    errors.push(`Too many additional properties: ${Object.keys(additionalProps).length} (max: ${MAX_PROPERTIES})`);
  }

  return { isValid: errors.length === 0, errors };
}

export function validateAdditionalProperties(additionalProps: any): { isValid: boolean; errors: string[] } {
  return validateAdditionalPropertiesInternal(additionalProps);
}

export function validateMessageWithAdditionalProperties(message: any): { isValid: boolean; errors: string[] } {
  const result = MessageSchema.safeParse(message);
  if (!result.success) {
    const errors = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
    logger.warn('Message validation failed:', result.error.format());
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [] };
}
