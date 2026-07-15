import { describe, it, expect } from "vitest";

import { getSuggestions, type SuggestionCtx } from "../src/suggestions.js";
import { parseRepoContextArgs } from "../src/cli.js";
import type { RepoContext } from "../src/context.js";

const repo: RepoContext = {
  host: "dev.egov.gy",
  project: "christopher.mckay/my-project",
  source: "flag",
};

/** Every (domain, action) the suggestion table can match on. */
const ACTIONS: Record<string, string[]> = {
  home: ["home"],
  issue: [
    "list",
    "view",
    "links",
    "create",
    "close",
    "reopen",
    "edit",
    "comment",
  ],
  mr: [
    "list",
    "view",
    "create",
    "merge",
    "checks",
    "diff",
    "update",
    "approve",
    "comment",
  ],
  ci: ["list", "view", "status", "watch", "jobs", "log", "retry"],
  project: ["view", "list", "create", "delete"],
  repo: ["create-file", "create-branch"],
  label: ["list", "create", "delete"],
  variable: ["list", "get", "set", "delete"],
  secret: ["list", "set", "delete"],
  release: ["list", "view", "create", "delete"],
  search: ["projects"],
  api: ["get"],
};

const STATES = [undefined, "opened", "closed", "merged", "masked"];
const EMPTY = [undefined, true, false];

function everyContext(): SuggestionCtx[] {
  const out: SuggestionCtx[] = [];
  for (const [domain, actions] of Object.entries(ACTIONS)) {
    for (const action of actions) {
      for (const state of STATES) {
        for (const isEmpty of EMPTY) {
          out.push({
            domain,
            action,
            id: "1",
            branch: "main",
            repo,
            ...(state !== undefined ? { state } : {}),
            ...(isEmpty !== undefined ? { isEmpty } : {}),
          });
        }
      }
    }
  }
  return out;
}

/** Pull the backticked command out of a "Run `...` to do X" suggestion. */
function command(line: string): string | undefined {
  return line.match(/`([^`]+)`/)?.[1];
}

describe("suggestions", () => {
  it("emits no suggestion the CLI's own parser would reject", () => {
    // The parser requires flags to come after the command, so the first
    // non-flag token of every suggested command must be the command itself.
    const rejected: string[] = [];
    for (const ctx of everyContext()) {
      for (const line of getSuggestions(ctx)) {
        const cmd = command(line);
        if (!cmd || !cmd.startsWith("glab-axi ")) continue;
        const argv = cmd.split(" ").slice(1);
        if (argv[0].startsWith("-")) rejected.push(cmd);
      }
    }
    expect(rejected).toEqual([]);
  });

  it("carries -R forward after the command, never before it", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      repo,
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(" -R dev.egov.gy/christopher.mckay/my-project");
      expect(line).not.toContain("glab-axi -R");
    }
  });

  it("emits every -R in a form the flag stripper consumes whole", () => {
    for (const ctx of everyContext()) {
      for (const line of getSuggestions(ctx)) {
        const cmd = command(line);
        if (!cmd || !cmd.includes(" -R ")) continue;
        const { repoFlag: target, strippedArgs } = parseRepoContextArgs(
          cmd.split(" "),
        );
        // Both the flag and its value must be consumed, leaving a clean command.
        expect(target, cmd).toBeTruthy();
        expect(strippedArgs, cmd).not.toContain("-R");
      }
    }
  });

  it("omits -R when the project came from the git remote", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      repo: { ...repo, source: "git" },
    });
    for (const line of lines) expect(line).not.toContain("-R");
  });
});
