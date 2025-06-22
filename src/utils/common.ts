import { PrivateKey, Topic } from '@ethersphere/bee-js';

import { ErrorHandler } from './error';
import { Logger } from './logger';

const logger = Logger.getInstance();
const errorHandler = ErrorHandler.getInstance();

export function sleep(delay: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

export function remove0x(hex: string) {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
}

export async function retryAwaitableAsync<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delay: number = 250,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn()
      .then(resolve)
      .catch((error) => {
        if (retries > 0) {
          logger.info(`Retrying... Attempts left: ${retries}. Error: ${error.message}`);
          setTimeout(() => {
            retryAwaitableAsync(fn, retries - 1, delay)
              .then(resolve)
              .catch(reject);
          }, delay);
        } else {
          errorHandler.handleError(error, 'Utils.retryAwaitableAsync');
          reject(error);
        }
      });
  });
}
// TODO: import from comment-system
export function getPrivateKeyFromIdentifier(identifier: string): PrivateKey {
  if (!identifier) {
    throw new Error('Cannot generate private key from an invalid identifier');
  }

  return new PrivateKey(Topic.fromString(identifier).toUint8Array());
}
