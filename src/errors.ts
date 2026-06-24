import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

interface Pattern {
  pattern: RegExp;
  code: string;
  message: (m: RegExpMatchArray, stderr: string) => string;
  suggestions?: (m: RegExpMatchArray) => string[];
}

const patterns: Pattern[] = [
  {
    pattern:
      /not authenticated|no token|401 unauthorized|authentication required/i,
    code: "AUTH_REQUIRED",
    message: () =>
      "GitLab auth required - run `glab auth login --hostname <host>` first",
    suggestions: () => [
      "For self-hosted instances pass --hostname (e.g. glab auth login --hostname dev.egov.gy)",
    ],
  },
  {
    pattern: /404 (not found|project not found)|GET .*?: 404/i,
    code: "NOT_FOUND",
    message: () => "Resource not found in this project",
    suggestions: () => [],
  },
  {
    pattern: /403 forbidden|insufficient_scope|you don't have permission/i,
    code: "FORBIDDEN",
    message: () => "Insufficient permissions for this action",
  },
  {
    pattern: /could not determine.*?repo|no\.git remote|not a git repository/i,
    code: "VALIDATION_ERROR",
    message: () =>
      "Could not determine the GitLab project - pass --repo <group/project> or run inside a git checkout",
  },
  {
    pattern: /429|rate limit/i,
    code: "RATE_LIMITED",
    message: () => "GitLab rate limit hit - wait and retry",
    suggestions: () => ["Wait ~60s before retrying"],
  },
];

function firstErrorLine(stderr: string): string {
  return (
    stderr
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("?"))[0] ?? ""
  );
}

/** Translate raw glab stderr into a structured AxiError. Never leaks "glab". */
export function mapGlabError(stderr: string, exitCode: number): AxiError {
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
  if (/not found/i.test(stderr)) {
    return new AxiError(
      firstErrorLine(stderr) || "Resource not found",
      "NOT_FOUND",
    );
  }
  return new AxiError(
    firstErrorLine(stderr) || `command exited with code ${exitCode}`,
    "UNKNOWN",
  );
}

export function glabNotInstalledError(): AxiError {
  return new AxiError(
    "glab CLI is not installed - see https://gitlab.com/gitlab-org/cli",
    "GLAB_NOT_INSTALLED",
    ["Install glab, then run `glab auth login --hostname <host>`"],
  );
}
