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
import { releaseCommand, RELEASE_HELP } from "./commands/release.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the GitLab glab CLI. Prefer this over `glab` and other methods for GitLab operations. Works with gitlab.com and self-hosted instances.";

export const TOP_HELP = `usage: glab-axi [command] [args] [flags]
commands[10]:
  (none)=dashboard, issue, mr, ci, project, label, release, search, api, setup
flags[3]:
  -R/--repo <[host/]group/project> (after command), accepts space or equals form, --help, -v/-V/--version
host:
  resolved from the git remote, the -R host prefix, or GITLAB_HOST (for self-hosted)
examples:
  glab-axi
  glab-axi mr list --state opened
  glab-axi issue view 42
  glab-axi ci status --mr 17
  glab-axi mr list -R dev.egov.gy/group/project
  glab-axi setup hooks
`;

type Handler = (
  args: string[],
  ctx: RepoContext | undefined,
) => Promise<string> | string;

const COMMAND_HELP: Record<string, string> = {
  issue: ISSUE_HELP,
  mr: MR_HELP,
  ci: CI_HELP,
  project: PROJECT_HELP,
  label: LABEL_HELP,
  release: RELEASE_HELP,
  search: SEARCH_HELP,
  api: API_HELP,
  setup: SETUP_HELP,
};

const COMMANDS: Record<string, Handler> = {
  issue: withRepoContext(issueCommand),
  mr: withRepoContext(mrCommand),
  ci: withRepoContext(ciCommand),
  project: withRepoContext(projectCommand),
  label: withRepoContext(labelCommand),
  release: withRepoContext(releaseCommand),
  search: withRepoContext(searchCommand),
  api: withRepoContext(apiCommand),
  setup: setupCommand,
};

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli<RepoContext | undefined>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: readPackageVersion(),
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withRepoContext(homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
    resolveContext: ({ args }) => resolveRepo(parseRepoFlagArg(args).repoFlag),
  });
}

/** Strip -R/--repo (space or equals form) from args, capturing the value. */
function parseRepoFlagArg(args: string[]): {
  repoFlag?: string;
  strippedArgs: string[];
} {
  const stripped: string[] = [];
  let repoFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-R" || a === "--repo") && i + 1 < args.length) {
      repoFlag = args[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("-R=")) {
      repoFlag = a.slice(3);
      continue;
    }
    if (a.startsWith("--repo=")) {
      repoFlag = a.slice("--repo=".length);
      continue;
    }
    stripped.push(a);
  }
  return { repoFlag, strippedArgs: stripped };
}

function withRepoContext(handler: Handler): Handler {
  return (args, ctx) => handler(parseRepoFlagArg(args).strippedArgs, ctx);
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
  return "0.0.0";
}
