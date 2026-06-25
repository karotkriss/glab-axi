import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SKILL_PATH = join(repoRoot, "skills", "glab-axi", "SKILL.md");

function build(): string {
  return createSkillMarkdown();
}

function main(): void {
  const check = process.argv.includes("--check");
  const content = build();

  if (check) {
    if (!existsSync(SKILL_PATH)) {
      console.error(
        `skill:check failed — ${SKILL_PATH} does not exist. Run \`npm run skill:build\`.`,
      );
      process.exit(1);
    }
    const current = readFileSync(SKILL_PATH, "utf-8");
    if (current !== content) {
      console.error(
        "skill:check failed — SKILL.md is stale. Run `npm run skill:build` and commit the result.",
      );
      process.exit(1);
    }
    console.log("skill:check passed — SKILL.md is up to date.");
    return;
  }

  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  writeFileSync(SKILL_PATH, content, "utf-8");
  console.log(`Wrote ${SKILL_PATH}`);
}

main();
