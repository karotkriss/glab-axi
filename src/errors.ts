import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

/**
 * Remove any reference to the underlying CLI binary name from a message.
 * AXI errors must never leak the wrapped dependency's name. "GitLab" (the
 * product) is preserved; only the bare CLI token is scrubbed.
 */
export function scrubTool(message: string): string {
  return message
    .replace(/^glab:\s*/i, "")
    .replace(/\bglab\b(?!-axi)/gi, "the CLI")
    .trim();
}

interface ErrorPattern {
  pattern: RegExp;
  code: string;
  message: (match: RegExpMatchArray, body: string) => string;
  suggestions?: (match: RegExpMatchArray) => string[];
}

const patterns: ErrorPattern[] = [
  {
    pattern: /401|unauthorized|authentication|missing token|not logged in/i,
    code: "AUTH_REQUIRED",
    message: () => "GitLab authentication required for this host",
    suggestions: () => [
      "Authenticate your GitLab CLI for the target host, then retry",
      "Set GITLAB_HOST to target a specific self-hosted instance",
    ],
  },
  {
    pattern: /HTTP 404|404 Not Found|not found/i,
    code: "NOT_FOUND",
    message: (_m, body) =>
      extractApiMessage(body) ?? "Resource not found in this project",
    suggestions: () => [],
  },
  {
    pattern: /HTTP 403|403 Forbidden|forbidden|insufficient/i,
    code: "FORBIDDEN",
    message: (_m, body) =>
      extractApiMessage(body) ?? "Insufficient permissions for this action",
  },
  {
    pattern: /HTTP 409|409 Conflict/i,
    code: "CONFLICT",
    message: (_m, body) => extractApiMessage(body) ?? "Conflicting request",
  },
  {
    pattern: /HTTP 429|rate limit/i,
    code: "RATE_LIMITED",
    message: () => "GitLab API rate limit hit — wait and retry",
    suggestions: () => ["Wait ~60s before retrying"],
  },
  {
    pattern: /HTTP 422|422 Unprocessable|HTTP 400|400 Bad Request/i,
    code: "VALIDATION_ERROR",
    message: (_m, body) => extractApiMessage(body) ?? "Validation error",
  },
];

/** Pull a human message out of a GitLab JSON error body. */
function extractApiMessage(body: string): string | undefined {
  // GitLab returns {"message":"..."} or {"error":"..."} or nested objects.
  const msgMatch = body.match(/"message"\s*:\s*"([^"]+)"/);
  if (msgMatch) return scrubTool(msgMatch[1]);
  const errMatch = body.match(/"error"\s*:\s*"([^"]+)"/);
  if (errMatch) return scrubTool(errMatch[1]);
  // Nested: {"message":{"base":["..."]}} or {"message":{"title":["..."]}}
  const nested = body.match(/"message"\s*:\s*\{[^}]*?\[\s*"([^"]+)"/);
  if (nested) return scrubTool(nested[1]);
  return undefined;
}

function firstErrorLine(stderr: string): string {
  return scrubTool(stderr.trim().split("\n")[0] ?? "");
}

/** Translate raw CLI stderr into a structured AxiError. */
export function mapGlError(stderr: string, exitCode: number): AxiError {
  for (const { pattern, code, message, suggestions } of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      return new AxiError(
        message(match, stderr),
        code,
        suggestions?.(match) ?? [],
      );
    }
  }
  const line = firstErrorLine(stderr);
  return new AxiError(
    line || `Request failed with code ${exitCode}`,
    "UNKNOWN",
  );
}

export function glNotInstalledError(): AxiError {
  return new AxiError(
    "GitLab CLI is not installed — see https://gitlab.com/gitlab-org/cli",
    "CLI_NOT_INSTALLED",
  );
}
