import { execFileSync } from "node:child_process";

export interface RepoContext {
  /** Self-hosted host, when known. Undefined means "use the CLI's default host". */
  host?: string;
  /** Full namespace path: "group/project" or "group/subgroup/project". */
  project: string;
  /** How the project was resolved. */
  source: "flag" | "git";
}

/**
 * Resolve the target project.
 *
 * Priority for the PROJECT path: --repo flag > git remote origin.
 * GITLAB_HOST only OVERRIDES the host of an already-resolved project; by
 * itself it does NOT resolve a project (there is no namespace to infer from
 * a bare hostname).
 */
export function resolveRepo(flagValue?: string): RepoContext | undefined {
  let ctx: RepoContext | undefined;
  if (flagValue) {
    ctx = parseRepoArg(flagValue, "flag");
  } else {
    ctx = parseGitRemote();
  }
  if (!ctx) return undefined;
  const envHost = process.env["GITLAB_HOST"];
  if (envHost && envHost.trim()) {
    ctx.host = envHost.trim();
  }
  return ctx;
}

/**
 * Parse a `-R`/`--repo` value of the form `[host/]group/project`.
 * A first path segment containing a dot is treated as the host.
 * Nested group paths (group/subgroup/project) are supported.
 */
export function parseRepoArg(
  value: string,
  source: "flag" | "git",
): RepoContext | undefined {
  const parts = value.split("/").filter(Boolean);
  let host: string | undefined;
  if (parts[0] && parts[0].includes(".")) {
    host = parts.shift();
  }
  if (parts.length < 2) return undefined;
  return { host, project: parts.join("/"), source };
}

function parseGitRemote(): RepoContext | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseRemoteUrl(url);
  } catch {
    return undefined;
  }
}

/** Parse host + namespace path out of a git remote URL (SSH or HTTPS). */
export function parseRemoteUrl(url: string): RepoContext | undefined {
  // scp-like SSH: git@host:group/project.git
  let m = url.match(/^[^@]+@([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (m) return { host: m[1], project: m[2], source: "git" };
  // URL form: scheme://[user@]host[:port]/group/project.git
  m = url.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i,
  );
  if (m) return { host: m[1], project: m[2], source: "git" };
  return undefined;
}
