import { installSessionStartHooks } from "axi-sdk-js";
import type { RepoContext } from "../context.js";
import { encode } from "@toon-format/toon";
import { renderError, renderHelp, renderOutput } from "../toon.js";

export const SETUP_HELP = `usage: glab-axi setup hooks
description:
  Install SessionStart hooks so agents (Claude Code, Codex, OpenCode) receive
  glab-axi's ambient project dashboard at the start of each session. Idempotent
  and path-self-repairing.
examples:
  glab-axi setup hooks`;

export async function setupCommand(
  args: string[],
  _ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || sub === "--help") return renderOutput([SETUP_HELP]);
  if (sub !== "hooks") {
    return renderError(`unknown setup subcommand: ${sub}`, "VALIDATION_ERROR", [
      "Run `glab-axi setup hooks` to install session hooks",
    ]);
  }
  installSessionStartHooks();
  return renderOutput([
    encode({
      hooks: {
        status: "installed",
        integrations: "Claude Code, Codex, OpenCode",
      },
    }),
    renderHelp([
      "Restart your agent session to receive glab-axi ambient context",
    ]),
  ]);
}
