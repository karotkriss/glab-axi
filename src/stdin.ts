import { readFileSync } from "node:fs";
import { AxiError } from "./errors.js";

interface ReadStdinOptions {
  /** When set, non-UTF-8 piped bytes throw this message instead of being silently decoded lossily. */
  rejectBinaryMessage?: string;
  suggestions?: string[];
}

/**
 * Read piped stdin synchronously as UTF-8. Returns "" when stdin is an
 * interactive TTY (nothing piped) or unreadable. Backs the value fallback for
 * `variable set` / `secret set`, so a value can be piped instead of passed on
 * the command line (`printf %s "$TOKEN" | glab-axi secret set NAME`).
 */
export function readStdin(options?: ReadStdinOptions): string {
  if (process.stdin.isTTY) return "";
  let raw: Buffer;
  try {
    raw = readFileSync(0);
  } catch {
    return "";
  }
  if (!options?.rejectBinaryMessage) return raw.toString("utf8");
  // Validate the raw bytes before decoding: a lossy decode would already have
  // substituted U+FFFD for invalid sequences, making binary undetectable.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new AxiError(
      options.rejectBinaryMessage,
      "VALIDATION_ERROR",
      options.suggestions,
    );
  }
}
