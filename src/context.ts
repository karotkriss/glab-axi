import { execFileSync } from "node:child_process";

export interface RepoContext {
  /** GitLab host, e.g. "gitlab.com" or "dev.egov.gy". May be undefined when
   *  relying on glab's own default host. */
  host?: string;
  /** Full project path, e.g. "group/subgroup/project". */
  project: string;
  /** Where the context came from. "git" means glab can auto-detect from cwd. */
  source: "flag" | "env" | "git";
}

function stripGit(s: string): string {
  return s.replace(/\.git$/, "");
}

/** Parse host + project path from a git remote URL (ssh, scp-like, or https). */
export function parseRemoteUrl(
  url: string,
): { host: string; project: string } | undefined {
  const u = url.trim();
  // scp-like: git@host:group/sub/project(.git)
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) {
    return { host: scp[1].toLowerCase(), project: stripGit(scp[2]) };
  }
  // URL forms: ssh://git@host[:port]/path, https://host/path
  const m = u.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);
  if (m) {
    return { host: m[1].toLowerCase(), project: stripGit(m[2]) };
  }
  return undefined;
}

/**
 * Parse a --repo flag value, which may be "group/project",
 * "host/group/project", or a full URL. A first segment containing a dot is
 * treated as a hostname.
 */
export function parseRepoFlag(value: string): {
  host?: string;
  project: string;
} {
  const v = stripGit(value.trim());
  if (/:\/\//.test(v) || /^[^@/]+@[^:/]+:/.test(v)) {
    const parsed = parseRemoteUrl(v);
    if (parsed) return parsed;
  }
  const segments = v.split("/").filter(Boolean);
  if (segments.length >= 3 && segments[0].includes(".")) {
    return {
      host: segments[0].toLowerCase(),
      project: segments.slice(1).join("/"),
    };
  }
  return { project: v };
}

function gitRemoteUrl(): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the target GitLab project.
 * Priority: --repo flag > git remote origin. GITLAB_HOST overrides the host.
 */
export function resolveRepo(flagValue?: string): RepoContext | undefined {
  const envHost = process.env["GITLAB_HOST"];
  if (flagValue) {
    const parsed = parseRepoFlag(flagValue);
    return {
      host: parsed.host ?? envHost,
      project: parsed.project,
      source: "flag",
    };
  }
  const remote = gitRemoteUrl();
  if (remote) {
    const parsed = parseRemoteUrl(remote);
    if (parsed) {
      // Inside the checkout glab auto-detects host+project from the remote, so
      // mark this "git" and let downstream skip explicit --repo/GITLAB_HOST.
      return {
        host: envHost ?? parsed.host,
        project: parsed.project,
        source: "git",
      };
    }
  }
  return undefined;
}
