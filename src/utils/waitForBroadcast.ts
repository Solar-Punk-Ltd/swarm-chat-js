import { sleep } from './common';

export interface BroadcastWaiterOptions<T> {
  condition: () => Promise<boolean> | boolean;
  broadcast: () => Promise<T>;
  maxRetries?: number;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  checkCount?: number;
}

/**
 * Waits for a condition to become true, retrying broadcast if needed.
 * Starts by broadcasting first, then waits and checks condition.
 */
export async function waitForBroadcast<T>(options: BroadcastWaiterOptions<T>): Promise<void> {
  const {
    condition,
    broadcast,
    maxRetries = 2,
    initialDelayMs = 2000,
    checkIntervalMs = 1000,
    checkCount = 10,
  } = options;

  return new Promise<void>((resolve, reject) => {
    let retryCount = 0;

    const runCycle = async () => {
      await sleep(initialDelayMs);

      for (let i = 0; i < checkCount; i++) {
        const isReady = await Promise.resolve(condition());
        if (isReady) {
          return resolve();
        }
        await sleep(checkIntervalMs);
      }

      if (++retryCount >= maxRetries) {
        return reject(new Error('Broadcast wait timeout'));
      }

      console.warn(`Retrying broadcast... Attempt ${retryCount} of ${maxRetries}`);
      await broadcast();
      runCycle();
    };

    console.log('Starting broadcast...');
    broadcast()
      .then(() => runCycle())
      .catch(reject);
  });
}
