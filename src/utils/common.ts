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

export function remove0x(hex: string) {
  return (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
}
