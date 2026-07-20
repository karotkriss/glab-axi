import { AxiError, glNotInstalledError } from "../errors.js";
import { glApi, glCredential } from "../gl.js";
import { knownHosts } from "../hosts.js";
import { readStdin } from "../stdin.js";
import { renderHelp, renderOutput } from "../toon.js";
import type { RepoContext } from "../context.js";

export const AUTH_HELP = `usage: glab-axi auth <subcommand> [flags]
subcommands[2]:
  status          report whether a working GitLab credential exists for a host
  git-credential  git credential helper passthrough (for git, not for agents)
flags{status}:
  --host <host> (global) the host to check; also settable via -R host/group/project
notes:
  A credential is HOST-scoped, so both subcommands are host-addressed, never project-addressed.
  \`status\` never prints the credential. It reports presence plus the account the
  credential authenticated as, which is what proves the credential actually works.
  \`git-credential\` speaks git's credential protocol on stdin/stdout: it is the
  ONLY surface that emits a password, and it is meant to be wired into git, not
  read by an agent. Whatever runs it owns keeping that output out of logs.
  Credentials are read from the store the GitLab CLI already manages. This command
  never writes, rotates, or caches one - \`store\`/\`erase\` are passed through untouched.
  GITLAB_TOKEN, when set, answers for EVERY host, overriding the per-host store - so a
  credential reported under one host may be that env token, not an entry for that host.
examples:
  glab-axi auth status --host gitlab.example.com
  glab-axi auth status -R gitlab.example.com/group/project
  git -c credential.helper='!glab-axi auth git-credential' clone https://gitlab.example.com/group/project.git
  printf 'protocol=https\\nhost=gitlab.example.com\\n\\n' | glab-axi auth git-credential get
`;

/** Operations git can invoke a credential helper with. */
const OPERATIONS = new Set(["get", "store", "erase"]);

export async function authCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  if (sub === "status") return authStatus(ctx);
  if (sub === "git-credential") return gitCredential(args.slice(1));
  throw new AxiError(
    sub ? `Unknown auth subcommand: ${sub}` : "auth requires a subcommand",
    "VALIDATION_ERROR",
    [
      "Run `glab-axi auth status --host <host>` to check for a working credential",
      "Run `glab-axi auth git-credential get` to use it as a git credential helper",
    ],
  );
}

/**
 * Report whether this machine holds a credential for the host, and whether it
 * actually works.
 *
 * Presence alone is not the question an agent is asking - a stale token is
 * present and useless - so the credential is spent on a `GET /user` and the
 * account it resolves to is what gets reported. Per the never-report-unverified
 * -state rule, a failure renders as the reason it failed, never as a bare "no".
 */
async function authStatus(ctx?: RepoContext): Promise<string> {
  const host = requireHost(ctx);
  const result = await glCredential("get", credentialQuery(host));
  if (result.stderr === "ENOENT") throw glNotInstalledError();

  const username = parseCredential(result.stdout).get("username");
  // The helper exits non-zero, with nothing on stdout, when it holds no
  // credential for the host. That silence is the whole reason this verb exists.
  if (result.exitCode !== 0 || username === undefined) {
    return renderOutput([
      `credential:\n  host: ${host}\n  available: no`,
      renderHelp([
        `Set GITLAB_TOKEN in the environment to supply a credential for ${host} non-interactively`,
        `Or log in to ${host} with the GitLab CLI's interactive login, which this command deliberately does not wrap`,
        "Run `glab-axi auth status --host <host>` to check a different host",
      ]),
    ]);
  }

  const verified = await verifyCredential(host);
  return renderOutput([
    `credential:\n  host: ${host}\n  available: yes\n  username: ${username}\n  ${verified}`,
    renderHelp([
      `Run \`git -c credential.helper='!glab-axi auth git-credential' clone https://${host}/<group>/<project>.git\` to use it`,
      "Run `glab-axi auth git-credential get` to hand the credential to another git-credential consumer",
    ]),
  ]);
}

/**
 * Spend the credential on the cheapest authenticated call there is, so the
 * report describes what the server accepted rather than what is on disk.
 */
async function verifyCredential(host: string): Promise<string> {
  try {
    const user = await glApi<{ username?: string }>("user", {
      ctx: { host, source: "flag" },
    });
    const who = user?.username;
    return who
      ? `verified_as: ${who}`
      : "verified: unavailable - the host accepted the credential but named no account";
  } catch (error) {
    const reason = error instanceof AxiError ? error.message : String(error);
    // "unavailable" and "no" are opposite facts: the credential may be fine and
    // the host merely unreachable. Say which one this was.
    return `verified: unavailable - ${reason}`;
  }
}

/**
 * Pass git's credential protocol straight through to the wrapped CLI's helper.
 *
 * This subcommand deliberately does NOT emit TOON, and stays silent on failure:
 * its consumer is git, which parses stdout as `key=value` lines and treats any
 * other content as a malformed credential. A structured error here would break
 * the very operation the verb exists to serve, so the agent-facing diagnosis
 * lives in `auth status` instead, and the exit code carries the outcome.
 */
async function gitCredential(args: string[]): Promise<string> {
  const operation = args[0];
  if (operation === undefined || !OPERATIONS.has(operation)) {
    throw new AxiError(
      operation
        ? `Unknown git-credential operation: ${operation}`
        : "git-credential requires an operation",
      "VALIDATION_ERROR",
      [
        "Run `glab-axi auth git-credential get` (also: store, erase) with git's credential protocol on stdin",
        "Run `glab-axi auth status --host <host>` for a readable answer instead",
      ],
    );
  }

  // Nothing piped means no request to answer. Fail here rather than handing the
  // helper an empty request and reporting its confusion as an absent credential.
  const input = readStdin();
  if (input.trim() === "") {
    throw new AxiError(
      "git-credential expects git's credential protocol on stdin, but nothing was piped",
      "VALIDATION_ERROR",
      [
        `Pipe a request, e.g. \`printf 'protocol=https\\nhost=<host>\\n\\n' | glab-axi auth git-credential ${operation}\``,
        "Run `glab-axi auth status --host <host>` to check a credential without the protocol",
      ],
    );
  }
  const result = await glCredential(operation, input);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  // Report the helper's own outcome verbatim. `get` with no stored credential
  // exits non-zero with empty stdout, which is exactly what git expects from a
  // helper that has nothing to offer - it moves on to the next one.
  if (result.exitCode !== 0) process.exitCode = 1;
  return result.stdout;
}

/** The git credential protocol request for a host: key=value lines, blank-terminated. */
function credentialQuery(host: string): string {
  return `protocol=https\nhost=${host}\n\n`;
}

/** Parse a git credential protocol response into its key=value pairs. */
function parseCredential(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return fields;
}

/**
 * A credential is host-scoped, so a host is required and never guessed. No
 * hostname is hardcoded as a default: this tool targets any self-hosted
 * instance, and silently checking the wrong host would answer confidently
 * about a credential the caller is not asking for.
 */
function requireHost(ctx?: RepoContext): string {
  if (ctx?.host) return ctx.host;
  const configured = [...knownHosts()];
  throw new AxiError(
    "Could not determine which GitLab host to check",
    "VALIDATION_ERROR",
    [
      "Pass --host <host>, e.g. `glab-axi auth status --host gitlab.example.com`",
      ...(configured.length > 0
        ? [`Hosts this machine is configured for: ${configured.join(", ")}`]
        : []),
      "Or run inside a git repository whose origin remote points at a GitLab instance",
    ],
  );
}
