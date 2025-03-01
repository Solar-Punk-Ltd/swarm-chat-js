/**
 * Pauses the execution of an asynchronous function for a specified duration.
 * @param delay - The delay duration in milliseconds.
 * @returns A promise that resolves after the specified delay.
 */
export function sleep(delay: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Generic function to merge two arrays while ensuring uniqueness and sorting.
 * @param remoteItems - The remote array of items.
 * @param localItems - The local array of items.
 * @param getKey - A function to generate a unique key for each item.
 * @param sortComparator - A comparator function to sort the final array.
 * @returns A merged, unique, and sorted array.
 */
export function mergeUnique<T>(
  remoteItems: T[],
  localItems: T[],
  getKey: (item: T) => string | number,
  sortComparator: (a: T, b: T) => number,
): T[] {
  const itemMap = new Map<string | number, T>();

  remoteItems.forEach((item) => {
    itemMap.set(getKey(item), item);
  });

  localItems.forEach((item) => {
    itemMap.set(getKey(item), item);
  });

  return Array.from(itemMap.values()).sort(sortComparator);
}

export function remove0x(hex: string) {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
}
