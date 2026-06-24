/**
 * Generate skills/glab-axi/SKILL.md from the same strings the CLI prints, so the
 * skill can never drift from the tool. Run with `--check` in CI to fail when the
 * committed SKILL.md is stale.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESCRIPTION, TOP_HELP } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "skills", "glab-axi", "SKILL.md");

const SKILL_DESCRIPTION =
  "Operate GitLab through the glab-axi CLI - issues, merge requests, pipelines/CI, releases, labels, projects, search, and raw API access. Use whenever a task touches GitLab: filing or triaging issues, reviewing or merging MRs, checking pipeline status, cutting releases, or querying the GitLab API. Works with gitlab.com and self-hosted instances.";

/** Pull the `commands[N]:` block verbatim out of TOP_HELP. */
function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n?)+)/m);
  return match ? match[1].trimEnd() : "";
}

function createSkillMarkdown(): string {
  return `---
name: glab-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
author: Christopher McKay
---

# glab-axi

${DESCRIPTION}

Invoke it as \`glab-axi <command> <subcommand> [flags]\`. With no arguments it prints a live dashboard of the current project. Output is TOON (token-efficient); errors are structured on stdout with a suggested fix.

${extractCommandsBlock()}

## Targeting

Inside a checkout the project and host are auto-detected from the \`origin\` remote. Otherwise pass \`-R [host/]group/project\` after the command, or set \`GITLAB_HOST\` for self-hosted instances. Authentication is handled by \`glab\` (\`glab auth login --hostname <host>\`).

## Examples

\`\`\`sh
npx -y glab-axi issue list --state opened
npx -y glab-axi mr view 17 --full
npx -y glab-axi mr create --source-branch feat --title "Add feature" --body-file mr.md
npx -y glab-axi ci status --mr 17
npx -y glab-axi api projects/{project}/pipelines
\`\`\`

Every subcommand supports \`--help\`.
`;
}

const generated = createSkillMarkdown();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(skillPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== generated) {
    console.error(
      "SKILL.md is out of date. Run `npm run build:skill` and commit the result.",
    );
    process.exit(1);
  }
  console.error("SKILL.md is up to date.");
} else {
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, generated);
  console.error(`Wrote ${skillPath}`);
}
