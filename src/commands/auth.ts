import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { AxiError, glNotInstalledError } from "../errors.js";
import { glApi, glConfigGet, glCredential, glInstalls } from "../gl.js";
import { configPath, knownHosts } from "../hosts.js";
import { readStdin } from "../stdin.js";
import { refuseSubcommand } from "../refusals.js";
import {
  field,
  renderDetail,
  renderHelp,
  renderList,
  renderOutput,
} from "../toon.js";
import type { RepoContext } from "../context.js";

export const AUTH_HELP = `usage: glab-axi auth <subcommand> [flags]
subcommands[2]:
  status, git-credential <get|store|erase>
flags{status}:
  --host <host> (global) scope the report to one host; omit it to report every configured host
notes:
  A credential is HOST-scoped, so both subcommands are host-addressed, never project-addressed.
  \`status\` answers what this machine is set up to talk to: which binary this tool
  shells out to and its version, which config file the answers came from, which host
  a call that omits --host lands on, and which hosts hold a credential that works.
  It never prints a credential - token is reported as present/absent and nothing
  more, alongside the account the credential authenticated as, which is what proves
  the credential actually works.
  A \`shadowed\` section appears only when PATH holds more than one CLI install. That
  is a real failure mode: two installs, separate config files, different default
  hosts, and every call silently driving whichever comes first on PATH.
  \`git-credential\` is a git credential helper passthrough (for git, not for agents).
  It speaks git's credential protocol on stdin/stdout: it is the ONLY surface that
  emits a password, and it is meant to be wired into git, not read by an agent.
  Whatever runs it owns keeping that output out of logs.
  Credentials are read from the store the GitLab CLI already manages. This command
  never writes, rotates, or caches one - \`store\`/\`erase\` are passed through untouched.
  GITLAB_TOKEN, when set, answers for EVERY host, overriding the per-host store - so a
  credential reported under one host may be that env token, not an entry for that host.
examples:
  glab-axi auth status
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
  if (sub === undefined) {
    throw new AxiError("auth requires a subcommand", "VALIDATION_ERROR", [
      "Run `glab-axi auth status --host <host>` to check for a working credential",
      "Run `glab-axi auth git-credential get` to use it as a git credential helper",
    ]);
  }
  return refuseSubcommand("auth", sub, AUTH_HELP);
}

/**
 * Report what this machine is actually set up to talk to: which binary answers,
 * which config it reads, which host it defaults to, and which hosts hold a
 * credential that works.
 *
 * The install block is not garnish. A tool that shells out to another binary
 * owes its caller the identity of that binary, because "which one answered" is
 * otherwise undiagnosable from the agent surface - see `glInstalls`.
 *
 * Presence alone is not the question either - a stale token is present and
 * useless - so each credential is spent on a `GET /user` and the account it
 * resolves to is what gets reported. Per the never-report-unverified-state
 * rule, a failure renders as the reason it failed, never as a bare "no".
 */
async function authStatus(ctx?: RepoContext): Promise<string> {
  const installs = glInstalls();
  if (installs.length === 0) throw glNotInstalledError();

  const config = configPath();
  // The default host decides where a call that omits --host lands, which makes
  // it the single most load-bearing setting here and the one nothing else
  // reports. Read globally: this is the fallback, not any host's own setting.
  const defaultHost = glConfigGet("host");
  const blocks = [
    renderDetail(
      "install",
      {
        bin: installs[0].path,
        version: installs[0].version ?? "unknown",
        config_file: existsSync(config)
          ? tilde(config)
          : `${tilde(config)} (not found)`,
        default_host: defaultHost || "unset",
      },
      [
        field("bin"),
        field("version"),
        field("config_file"),
        field("default_host"),
      ],
    ),
  ];

  // Only ever rendered when there is a genuine conflict, so its mere presence
  // is the finding - an agent does not have to compare anything to spot it.
  if (installs.length > 1) {
    blocks.push(
      renderList(
        "shadowed",
        installs.map((install, index) => ({
          path: install.path,
          version: install.version ?? "unknown",
          active: index === 0 ? "yes" : "no",
        })),
        [field("path"), field("version"), field("active")],
      ),
    );
  }

  // A host given explicitly scopes the report to it. Without one, every
  // configured host is reported rather than a guessed default: enumerating
  // cannot answer confidently about the wrong host, which is the failure the
  // single-host form has to guard against.
  const hosts = ctx?.host ? [ctx.host] : [...knownHosts()];
  if (hosts.length === 0) {
    blocks.push("hosts: 0 hosts configured on this machine");
    blocks.push(
      renderHelp([
        "Set GITLAB_TOKEN and pass `--host <host>` to authenticate a host non-interactively",
        "Run `glab-axi auth status --host <host>` to check a specific host regardless of configuration",
      ]),
    );
    return renderOutput(blocks);
  }

  const rows = await Promise.all(hosts.map(checkHost));
  blocks.push(
    renderList("hosts", rows, [
      field("host"),
      field("token"),
      field("account"),
    ]),
  );

  const broken = rows.filter((row) => row.account !== null && !row.ok);
  const defaultRow = rows.find((row) => row.host === defaultHost);
  blocks.push(
    renderHelp([
      ...(defaultRow && !defaultRow.ok
        ? [
            `Default host ${defaultHost} has no working credential, so any command omitting --host targets it - pass \`--host <host>\` explicitly, or change the default`,
          ]
        : []),
      ...(installs.length > 1
        ? [
            "More than one CLI install is on PATH - the one under `bin` answers every call this tool makes; remove the others or reorder PATH if that is the wrong one",
          ]
        : []),
      ...(broken.length > 0 && !defaultRow
        ? ["Run `glab-axi auth status --host <host>` to re-check a single host"]
        : []),
      "Run `glab-axi api user --host <host>` for the full account record on a host",
      "Run `glab-axi config get <key> --host <host>` to read a configuration value",
    ]),
  );
  return renderOutput(blocks);
}

interface HostStatus {
  host: string;
  /** Presence only, never any part of the value. */
  token: string;
  account: string | null;
  ok: boolean;
}

/** Report one host: is a credential held, and does the server still accept it. */
async function checkHost(host: string): Promise<HostStatus> {
  const result = await glCredential("get", credentialQuery(host));
  if (result.stderr === "ENOENT") throw glNotInstalledError();

  const username = parseCredential(result.stdout).get("username");
  // The helper exits non-zero, with nothing on stdout, when it holds no
  // credential for the host. That silence is the whole reason this verb exists.
  if (result.exitCode !== 0 || username === undefined) {
    return { host, token: "absent", account: "no credential", ok: false };
  }
  return { host, token: "present", ...(await verifyCredential(host)) };
}

/**
 * Spend the credential on the cheapest authenticated call there is, so the
 * report describes what the server accepted rather than what is on disk.
 */
async function verifyCredential(
  host: string,
): Promise<{ account: string; ok: boolean }> {
  try {
    const user = await glApi<{ username?: string }>("user", {
      ctx: { host, source: "flag" },
    });
    const who = user?.username;
    return who
      ? { account: who, ok: true }
      : {
          account:
            "unavailable - the host accepted the credential but named no account",
          ok: false,
        };
  } catch (error) {
    const reason = error instanceof AxiError ? error.message : String(error);
    // "unavailable" and "no" are opposite facts: the credential may be fine and
    // the host merely unreachable. Say which one this was.
    return { account: `unavailable - ${reason}`, ok: false };
  }
}

/** Collapse the user's home directory to `~`, per the AXI home-view convention. */
function tilde(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
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
