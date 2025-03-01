import { Logger } from './logger';

const logger = Logger.getInstance();

export interface BroadcastWaiterOptions<T> {
  condition: () => boolean;
  broadcast: () => Promise<void>;
  maxRetries?: number;
  intervalMs?: number;
}

/**
 * Waits for a condition to become true, retrying an action if needed.
 * @param options - The options to control the behavior.
 * @returns A promise that resolves when the condition is met, or rejects after maxRetries.
 */
export async function waitForBroadcast<T>(options: BroadcastWaiterOptions<T>): Promise<void> {
  const { condition, broadcast, maxRetries = 3, intervalMs = 2000 } = options;

  return new Promise<void>((resolve, reject) => {
    let counter = 0;

    const checkCondition = async () => {
      const isProcessed = condition();

      if (isProcessed) {
        return resolve();
      }

      if (counter >= maxRetries) {
        return reject(new Error('Broadcast wait timeout'));
      }

      counter++;

      try {
        await broadcast();
      } catch (error) {
        logger.warn('Broadcast failed, will retry:', error);
      }

      setTimeout(checkCondition, intervalMs);
    };

    checkCondition();
  });
}
