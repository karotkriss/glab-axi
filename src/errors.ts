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
    pattern:
      /HTTP 401|unauthorized|authentication|missing token|not logged in/i,
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

/** Flatten a GitLab `message` value: string, `{field: [..]}` object, or array. */
function flattenMessage(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map(flattenMessage).filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  }
  if (v && typeof v === "object") {
    const parts = Object.entries(v).flatMap(([k, val]) => {
      const m = flattenMessage(val);
      return m ? [`${k} ${m}`] : [];
    });
    return parts.length ? parts.join("; ") : undefined;
  }
  return undefined;
}

/** Pull a human message out of a GitLab JSON error body. */
function extractApiMessage(body: string): string | undefined {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(body.slice(start, end + 1));
      // {"message":..} | {"error":..,"error_description":..} | {"errors":..}
      const msg = flattenMessage(o.message) ?? flattenMessage(o.errors);
      if (msg) return scrubTool(msg);
      const err = flattenMessage(o.error);
      if (err) {
        const desc = flattenMessage(o.error_description);
        return scrubTool(desc ? `${err}: ${desc}` : err);
      }
    } catch {
      // fall through to the pattern scan for a truncated or mixed body
    }
  }
  const msgMatch = body.match(/"message"\s*:\s*"([^"]+)"/);
  if (msgMatch) return scrubTool(msgMatch[1]);
  const errMatch = body.match(/"error"\s*:\s*"([^"]+)"/);
  if (errMatch) return scrubTool(errMatch[1]);
  return undefined;
}

/**
 * The glab Go client fails to unmarshal a structured (object-valued) GitLab
 * error body into its string `.Message` field, so neither the body nor (without
 * `-i`) the HTTP status ever reaches us. `gl.ts` recovers the status; the body
 * is unrecoverable through the wrapped CLI.
 */
export const UNMARSHAL_QUIRK =
  /unmarshal .*into Go struct field .*\.Message of type string/i;

const CODE_BY_STATUS: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "AUTH_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
};

function firstErrorLine(stderr: string): string {
  return scrubTool(stderr.trim().split("\n")[0] ?? "");
}

/** Translate raw CLI stderr into a structured AxiError. */
export function mapGlError(stderr: string, exitCode: number): AxiError {
  const status = stderr.match(/\(HTTP (\d{3})\)|HTTP (\d{3})/);
  const httpStatus = status ? Number(status[1] ?? status[2]) : undefined;
  const tag = httpStatus ? ` (HTTP ${httpStatus})` : "";
  if (UNMARSHAL_QUIRK.test(stderr)) {
    return new AxiError(
      `GitLab rejected the request${httpStatus ? ` with HTTP ${httpStatus} and` : " with"} a validation error whose details the installed CLI version does not pass through`,
      (httpStatus && CODE_BY_STATUS[httpStatus]) || "VALIDATION_ERROR",
      [
        "Re-check the request's field names and values against the GitLab API documentation for this endpoint",
      ],
    );
  }
  for (const { pattern, code, message, suggestions } of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      const m = message(match, stderr);
      return new AxiError(
        code === "AUTH_REQUIRED" || code === "RATE_LIMITED" || !tag
          ? m
          : `${m}${tag}`,
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

export function argumentTooLargeError(): AxiError {
  return new AxiError(
    "Content or value is too large to pass as a command-line argument",
    "VALIDATION_ERROR",
    [
      "The OS limits how much text a single argument can hold (commonly ~128KB) - reduce the size of the content or value being sent",
    ],
  );
}

export function outputTooLargeError(limitMb: number): AxiError {
  return new AxiError(
    `Response exceeds the ${limitMb} MB output limit`,
    "OUTPUT_TOO_LARGE",
    [
      "Narrow the request (a smaller page, a single file) or download a large file such as a job artifact directly over HTTP from GitLab",
    ],
  );
}
