import { readFileSync } from "node:fs";

/**
 * Read piped stdin synchronously as UTF-8. Returns "" when stdin is an
 * interactive TTY (nothing piped) or unreadable. Backs the value fallback for
 * `variable set` / `secret set`, so a value can be piped instead of passed on
 * the command line (`printf %s "$TOKEN" | glab-axi secret set NAME`).
 */
export function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
