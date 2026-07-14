/** Resolve after `ms` milliseconds. Isolated so tests can mock the delay away. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
