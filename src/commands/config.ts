import { AxiError } from "../errors.js";
import { glConfigGetResult } from "../gl.js";
import { configPath, knownHosts } from "../hosts.js";
import { refuseSubcommand } from "../refusals.js";
import { field, renderDetail, renderHelp, renderOutput } from "../toon.js";
import type { RepoContext } from "../context.js";

export const CONFIG_HELP = `usage: glab-axi config <subcommand> [flags]
subcommands[1]:
  get <key>
flags{get}:
  --host <host> (global) read one host's setting instead of the global one
notes:
  Read-only. This command never writes, unsets, or rotates a configuration value.
  A setting can be global or per-host, and the two disagree in ways that decide
  where calls land - so \`get\` reports which scope answered, never just a value.
  Credential keys are refused: any key whose name contains "token" is rejected
  before the read happens. Presence is the whole question a caller needs answered,
  and \`auth status\` answers it without putting a secret on stdout.
  Useful keys: host (the default host), api_host, api_protocol, git_protocol, editor.
examples:
  glab-axi config get host
  glab-axi config get api_host --host gitlab.example.com
  glab-axi config get git_protocol --host gitlab.example.com
`;

/**
 * Configuration keys that hold a credential.
 *
 * Substring, not exact match, and deliberately so: `token` is the key that
 * exists today, but the check has to hold for whatever the wrapped CLI adds
 * next (`access_token`, `token_expiry`), because the cost of being wrong is
 * printing a live credential to stdout - unrecoverable once it reaches a log.
 */
const SECRET_KEY = /token/i;

export function configCommand(args: string[], ctx?: RepoContext): string {
  const sub = args[0];
  if (sub === "get") return configGet(args.slice(1), ctx);
  if (sub === undefined) {
    throw new AxiError("config requires a subcommand", "VALIDATION_ERROR", [
      "Run `glab-axi config get host` to see which host a call without --host targets",
      "Run `glab-axi auth status` for the full picture: binary, config file, and hosts",
    ]);
  }
  return refuseSubcommand("config", sub, CONFIG_HELP);
}

function configGet(args: string[], ctx?: RepoContext): string {
  const key = args.find((arg) => !arg.startsWith("--"));
  if (key === undefined) {
    throw new AxiError("config get requires a key", "VALIDATION_ERROR", [
      "Run `glab-axi config get host` to read the default host",
      "Run `glab-axi config get api_host --host <host>` to read one host's API endpoint",
    ]);
  }

  // Refused BEFORE the read, so the value never enters this process at all.
  if (SECRET_KEY.test(key)) {
    throw new AxiError(
      `Refusing to read \`${key}\`: it names a credential, and this command never emits one`,
      "VALIDATION_ERROR",
      [
        "Run `glab-axi auth status --host <host>` to check a credential's presence and whether it still works",
        "Run `glab-axi config get <key>` for a non-credential key, e.g. host, api_host, git_protocol",
      ],
    );
  }

  const host = ctx?.host;
  const raw = glConfigGetResult(key, host);
  if (raw === null) {
    throw new AxiError(
      `Could not read configuration key \`${key}\``,
      "UNKNOWN",
      [
        `The configuration file this reads is ${configPath()}`,
        "Run `glab-axi auth status` to check which binary and config file are in play",
      ],
    );
  }

  const value = raw.trim();
  return renderOutput([
    renderDetail(
      "config",
      {
        key,
        // A read that succeeded and found nothing is a real answer, and a
        // distinct one from a read that failed (rejected above).
        value: value === "" ? "unset" : value,
        // A colon here would make TOON quote the whole value; a space keeps the
        // field bare and reads the same.
        scope: host ? `host ${host}` : "global",
      },
      [field("key"), field("value"), field("scope")],
    ),
    renderHelp(hints(key, value, host)),
  ]);
}

function hints(key: string, value: string, host?: string): string[] {
  const configured = [...knownHosts()].filter((h) => h !== host);
  return [
    ...(value === "" && !host && configured.length > 0
      ? [
          `Unset globally - try a host scope: \`glab-axi config get ${key} --host ${configured[0]}\``,
        ]
      : []),
    ...(key === "host" && value !== ""
      ? [
          `Any command omitting --host targets ${value} - run \`glab-axi auth status\` to check it holds a working credential`,
        ]
      : []),
    "Run `glab-axi auth status` to see the resolved binary, config file, and per-host credentials",
  ];
}
