import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The GitLab hosts this machine is configured to talk to.
 *
 * Any hostname can be a self-hosted GitLab, so a string's shape can never
 * answer "is this a host?". The authoritative answer is the set of hosts the
 * underlying CLI is already authenticated against, plus GITLAB_HOST. An EMPTY
 * set means there is nothing to consult, not that no host exists.
 */
export function knownHosts(): Set<string> {
  const hosts = new Set<string>();
  const envHost = process.env["GITLAB_HOST"]?.trim();
  if (envHost) hosts.add(envHost);
  for (const host of Object.keys(readConfiguredHosts())) hosts.add(host);
  return hosts;
}

/** Path to the underlying CLI's config, honouring its env overrides. */
function configPath(): string {
  const explicit = process.env["GLAB_CONFIG_DIR"]?.trim();
  if (explicit) return join(explicit, "config.yml");
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return join(xdg || join(homedir(), ".config"), "glab-cli", "config.yml");
}

function readConfiguredHosts(): Record<string, unknown> {
  try {
    const parsed = parse(readFileSync(configPath(), "utf-8"));
    const hosts = parsed?.hosts;
    // Missing, unreadable, or malformed config: no authoritative answer.
    return hosts && typeof hosts === "object" ? hosts : {};
  } catch {
    return {};
  }
}
