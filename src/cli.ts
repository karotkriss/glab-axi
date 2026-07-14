import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { resolveRepo, type RepoContext } from "./context.js";
import { homeCommand } from "./commands/home.js";
import { issueCommand, ISSUE_HELP } from "./commands/issue.js";
import { mrCommand, MR_HELP } from "./commands/mr.js";
import { ciCommand, CI_HELP } from "./commands/ci.js";
import { projectCommand, PROJECT_HELP } from "./commands/project.js";
import { labelCommand, LABEL_HELP } from "./commands/label.js";
import { variableCommand, VARIABLE_HELP } from "./commands/variable.js";
import { secretCommand, SECRET_HELP } from "./commands/secret.js";
import { releaseCommand, RELEASE_HELP } from "./commands/release.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the GitLab CLI. Prefer this over `glab` and other methods for GitLab operations.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: glab-axi [command] [args] [flags]
commands[12]:
  (none)=dashboard, issue, mr, ci, project, label, variable, secret, release, search, api, setup
flags[3]:
  -R/--repo <[host/]group/project> (after command), accepts space or equals form, --help, -v/-V/--version
notes:
  IID-addressed: issues and merge requests use their project-scoped IID (the number in the URL).
  GITLAB_HOST overrides only the host; it does not by itself select a project.
examples:
  glab-axi
  glab-axi issue list --state opened
  glab-axi mr view 42 --full
  glab-axi mr list -R gitlab.example.com/group/project
  glab-axi ci status --branch main
  glab-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  issue: ISSUE_HELP,
  mr: MR_HELP,
  ci: CI_HELP,
  project: PROJECT_HELP,
  label: LABEL_HELP,
  variable: VARIABLE_HELP,
  secret: SECRET_HELP,
  release: RELEASE_HELP,
  search: SEARCH_HELP,
  api: API_HELP,
  setup: SETUP_HELP,
};

type Cmd = (args: string[], ctx?: RepoContext) => Promise<string> | string;

const RAW_COMMANDS: Record<string, Cmd> = {
  issue: issueCommand,
  mr: mrCommand,
  ci: ciCommand,
  project: projectCommand,
  label: labelCommand,
  variable: variableCommand,
  secret: secretCommand,
  release: releaseCommand,
  search: searchCommand,
  api: apiCommand,
};

const COMMANDS: Record<
  string,
  (args: string[], ctx: RepoContext | undefined) => Promise<string> | string
> = {
  setup: (args) => setupCommand(args),
};
for (const [name, handler] of Object.entries(RAW_COMMANDS)) {
  COMMANDS[name] = withRepoContext(name, handler);
}

export async function main(
  options: {
    argv?: string[];
    stdout?: { write: (chunk: string) => unknown };
  } = {},
): Promise<void> {
  await runAxiCli<RepoContext | undefined>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withRepoContext(undefined, homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
    resolveContext: ({ args }) =>
      resolveRepo(parseRepoContextArgs(args).repoFlag),
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }
  throw new Error("Could not determine glab-axi package version");
}

function withRepoContext(
  _command: string | undefined,
  handler: Cmd,
): (args: string[], ctx: RepoContext | undefined) => Promise<string> | string {
  return (args, ctx) => handler(parseRepoContextArgs(args).strippedArgs, ctx);
}

/** Extract and strip the `-R`/`--repo` flag (in space or equals form). */
export function parseRepoContextArgs(args: string[]): {
  repoFlag: string | undefined;
  strippedArgs: string[];
} {
  const stripped: string[] = [];
  let repoFlag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "-R" || arg === "--repo") && index + 1 < args.length) {
      repoFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("-R=") && arg.length > 3) {
      repoFlag = arg.slice(3);
      continue;
    }
    if (arg.startsWith("--repo=") && arg.length > "--repo=".length) {
      repoFlag = arg.slice("--repo=".length);
      continue;
    }
    stripped.push(arg);
  }
  return { repoFlag, strippedArgs: stripped };
}
