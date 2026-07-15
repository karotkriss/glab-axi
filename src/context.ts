import { execFileSync } from "node:child_process";
import { knownHosts } from "./hosts.js";

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
 * Nested group paths (group/subgroup/project) are supported.
 *
 * Disambiguation is by segment count and known hosts, never by punctuation: a
 * dotted first segment used to be read as a host, which broke every
 * `firstname.lastname` namespace (the standard username shape on LDAP/SSO
 * instances) and any group with a dot in its path.
 */
export function parseRepoArg(
  value: string,
  source: "flag" | "git",
): RepoContext | undefined {
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  let host: string | undefined;
  if (parts.length > 2 && isHostSegment(parts[0])) {
    host = parts.shift();
  }
  return { host, project: parts.join("/"), source };
}

/**
 * Decide whether the leading segment of a 3+-segment path is a host.
 *
 * `host/group/project` and `group/subgroup/project` are the same shape, so the
 * string alone cannot settle it. Ask what we know first, and only then guess.
 */
function isHostSegment(segment: string): boolean {
  // A host we are configured for is definitive, and it is the only way to spot
  // a bare intranet hostname ("gitlab", "localhost") that has no dot to find.
  if (knownHosts().has(segment)) return true;
  // Otherwise a dot is the only signal left, and it is what keeps a host we are
  // not yet configured for (GITLAB_TOKEN in the environment) addressable.
  // Residual ambiguity: a dotted TOP-LEVEL group that also has subgroups reads
  // as a host. Personal namespaces cannot have subgroups, so the dotted-user
  // case this fix is about is unaffected.
  return segment.includes(".");
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
