/**
 * Hand-off for a response that must reach stdout as exact bytes. A command
 * handler can only return a string, and a string cannot carry non-UTF-8 bytes,
 * so the handler parks the bytes here and `main()`'s stdout wrapper writes them
 * in place of the (empty) string the SDK is about to print.
 */
let pending: Buffer | undefined;

export function setRawOutput(bytes: Buffer): void {
  pending = bytes;
}

export function takeRawOutput(): Buffer | undefined {
  const bytes = pending;
  pending = undefined;
  return bytes;
}
