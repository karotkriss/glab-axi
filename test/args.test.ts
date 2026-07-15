import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched. These tests assert
// on whether a call was made at all: AXI clause 6 requires validation to land
// BEFORE any dependency call, so an unknown flag must never reach glApi.
vi.mock("../src/gl.js", () => {
  const glApi = vi.fn();
  return {
    glApi,
    glApiList: vi.fn(async (path: string, opts?: unknown) => ({
      data: (await glApi(path, opts)) ?? [],
      total: null,
    })),
    glRaw: vi.fn(),
    // `api` shells through glApiResult, so give it a real-shaped result.
    glApiResult: vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"id":1}',
      stderr: "",
    })),
    runJq: vi.fn(),
    glConfigGet: vi.fn(async () => ""),
    errorBody: (r: { stderr: string; stdout: string }) =>
      [r.stderr, r.stdout].filter(Boolean).join("\n"),
    projectId: (ctx?: { project: string }) =>
      ctx ? encodeURIComponent(ctx.project) : "{project}",
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

// Pin the target project so resolution never shells out to `glab`.
vi.mock("../src/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/context.js")>();
  return {
    ...actual,
    resolveRepo: () => ({
      host: "gitlab.example.com",
      project: "group/project",
      source: "flag" as const,
    }),
  };
});

import { main } from "../src/cli.js";
import { glApi, glApiResult } from "../src/gl.js";
import { parseHelpFlags } from "../src/args.js";
import { ISSUE_HELP } from "../src/commands/issue.js";
import { MR_HELP } from "../src/commands/mr.js";
import { CI_HELP } from "../src/commands/ci.js";
import { PROJECT_HELP } from "../src/commands/project.js";
import { REPO_HELP } from "../src/commands/repo.js";
import { LABEL_HELP } from "../src/commands/label.js";
import { VARIABLE_HELP } from "../src/commands/variable.js";
import { SECRET_HELP } from "../src/commands/secret.js";
import { RELEASE_HELP } from "../src/commands/release.js";
import { SEARCH_HELP } from "../src/commands/search.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;

/** Drive the real CLI entrypoint and capture what an agent would observe. */
async function cli(...argv: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (out += chunk) } });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, code };
}

beforeEach(() => {
  glApiMock.mockReset();
  glApiMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// The reported bug, end to end.
//
// Verified live against a public project before the fix:
//   `issue list --stat closed --limit 3` returned OPEN issues at exit 0.
// The agent asked for closed issues, got open ones, and the exit code said the
// request succeeded. That is the exact failure AXI clause 6 exists to prevent.
// ---------------------------------------------------------------------------

describe("unknown flags are rejected (AXI clause 6)", () => {
  it("rejects a typo'd flag instead of silently dropping it and returning the wrong data", async () => {
    const { out, code } = await cli("issue", "list", "--stat", "closed");

    expect(code).toBe(2);
    expect(out).toContain("--stat");
    expect(out).toContain("VALIDATION_ERROR");
    // The whole point: the wrong dataset was never fetched.
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("names the offending flag rather than a generic usage error", async () => {
    const { out } = await cli("issue", "list", "--stat", "closed");
    expect(out).toContain("Unknown flag for `glab-axi issue list`: --stat");
  });

  it("inlines the valid flag set so the error self-corrects in one turn", async () => {
    const { out } = await cli("issue", "list", "--stat", "closed");
    expect(out).toContain("Valid flags for `glab-axi issue list`");
    expect(out).toContain("--state");
    expect(out).toContain("--label");
  });

  it("points at the near-miss for a typo", async () => {
    const { out } = await cli("issue", "list", "--stat", "closed");
    expect(out).toContain("Did you mean `--state`?");
  });

  it("still honours the correctly spelled flag", async () => {
    const { code } = await cli("issue", "list", "--state", "closed");
    expect(code).toBe(0);
    expect(glApiMock).toHaveBeenCalled();
    expect(String(glApiMock.mock.calls[0][0])).toContain("state=closed");
  });

  it("rejects an unknown flag on every command that has flags", async () => {
    for (const argv of [
      ["issue", "list"],
      ["mr", "list"],
      ["mr", "view", "42"],
      ["ci", "list"],
      ["project", "view"],
      ["label", "list"],
      ["release", "list"],
      ["variable", "list"],
      ["secret", "list"],
      ["repo", "create-branch", "topic"],
      ["search", "issues", "login"],
    ]) {
      const { out, code } = await cli(...argv, "--zzz");
      expect(code, argv.join(" ")).toBe(2);
      expect(out, argv.join(" ")).toContain("--zzz");
      expect(glApiMock, argv.join(" ")).not.toHaveBeenCalled();
    }
  });

  it("rejects a flag that is real but belongs to another subcommand", async () => {
    const { out, code } = await cli("issue", "view", "42", "--state", "closed");
    expect(code).toBe(2);
    expect(out).toContain(
      "`--state` is a flag of `glab-axi issue list`, not `glab-axi issue view`",
    );
  });

  it("says so plainly when a subcommand takes no flags", async () => {
    const { out, code } = await cli("mr", "checks", "42", "--zzz");
    expect(code).toBe(2);
    expect(out).toContain("`glab-axi mr checks` takes no flags");
  });

  // The scout could not test this without an authenticated sandbox: a typo'd
  // --env would silently fall back to the "*" scope and write a CI/CD variable
  // to EVERY environment instead of the one named. It must never reach the API.
  it("rejects a typo'd --env before a variable is written to every scope", async () => {
    const { out, code } = await cli(
      "variable",
      "set",
      "K",
      "--value",
      "V",
      "--envv",
      "prod",
    );
    expect(code).toBe(2);
    expect(out).toContain("--envv");
    expect(out).toContain("Did you mean `--env`?");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("guards subcommand aliases too, not just their canonical names", async () => {
    for (const argv of [
      ["issue", "update", "1"],
      ["mr", "edit", "1"],
      ["label", "rm", "x"],
      ["variable", "view", "K"],
      ["secret", "rm", "K"],
      ["release", "update", "v1"],
    ]) {
      const { code } = await cli(...argv, "--zzz");
      expect(code, argv.join(" ")).toBe(2);
    }
  });

  it("rejects the equals form for a boolean flag instead of silently no-op'ing the filter", async () => {
    // Live evidence of the bug: `mr list --draft` filtered to drafts, but
    // `mr list --draft=true` was silently accepted and returned everything.
    const { out, code } = await cli("mr", "list", "--draft=true");
    expect(code).toBe(2);
    expect(out).toContain("--draft");
    expect(out).toContain("boolean");
    expect(glApiMock).not.toHaveBeenCalled();
  });
});

describe("what the guard must not break", () => {
  it("lets --help through on every subcommand", async () => {
    for (const argv of [
      ["issue", "list"],
      ["mr", "view"],
      ["variable", "set"],
    ]) {
      const { out, code } = await cli(...argv, "--help");
      expect(code, argv.join(" ")).toBe(0);
      expect(out, argv.join(" ")).toContain("usage: glab-axi");
    }
  });

  it("accepts a flag value that itself leads with a dash", async () => {
    const { code } = await cli("issue", "list", "--limit", "-5");
    expect(code).toBe(0);
  });

  it("accepts the equals form", async () => {
    const { code } = await cli("issue", "list", "--state=closed");
    expect(code).toBe(0);
    expect(String(glApiMock.mock.calls[0][0])).toContain("state=closed");
  });

  it("accepts a value-taking flag passed bare (no `=`)", async () => {
    const { code } = await cli("mr", "list", "--draft");
    expect(code).toBe(0);
    expect(glApiMock).toHaveBeenCalled();
  });

  // Regression: a single-dash positional (a free-text search query starting
  // with a negative number, version, or flag-shaped word) must not be treated
  // as a flag candidate - only `--`-leading tokens are. Verified live: this
  // returned `count: 30 of 47` on the parent commit and must keep working.
  it("lets a dash-leading positional flow through as free text, not a flag", async () => {
    const { code } = await cli("search", "issues", "-1 login crash");
    expect(code).toBe(0);
    expect(glApiMock).toHaveBeenCalled();
    const url = String(glApiMock.mock.calls[0][0]);
    expect(url).toContain(
      new URLSearchParams({ search: "-1 login crash" }).toString(),
    );
  });

  it("keeps the same free-text handling when the dash-leading query is unquoted", async () => {
    const { code } = await cli("search", "issues", "-1", "login", "crash");
    expect(code).toBe(0);
    expect(glApiMock).toHaveBeenCalled();
    const url = String(glApiMock.mock.calls[0][0]);
    expect(url).toContain(
      new URLSearchParams({ search: "-1 login crash" }).toString(),
    );
  });

  it("leaves `api` alone - it is the deliberate raw passthrough", async () => {
    const { code } = await cli("api", "projects/1", "--zzz");
    expect(code).toBe(0);
    // The unknown flag reached the passthrough instead of being rejected.
    expect(glApiResultMock).toHaveBeenCalled();
  });

  it("keeps a recognized-but-refused flag on its own refusal, not a generic unknown-flag error", async () => {
    const { out, code } = await cli("release", "create", "v1", "--draft");
    expect(code).toBe(2);
    expect(out).not.toContain("Unknown flag");
    expect(out).toContain("draft");
  });

  // Regression: --template takes a value (`--template owner/repo`, mirroring
  // gh) and must reach its own "template not supported" refusal in both the
  // bare and equals forms - not the boolean-equals error, which would wrongly
  // tell the caller to "pass it bare" and silently drop the flag instead.
  it("reaches its own refusal for a value-taking refused flag, not the boolean-equals error", async () => {
    const bare = await cli(
      "project",
      "create",
      "group/name",
      "--template",
      "org/tpl",
    );
    expect(bare.code).toBe(2);
    expect(bare.out).not.toContain("boolean flag");
    expect(bare.out).toContain("template");

    const equals = await cli(
      "project",
      "create",
      "group/name",
      "--template=org/tpl",
    );
    expect(equals.code).toBe(2);
    expect(equals.out).not.toContain("boolean flag");
    expect(equals.out).toContain("template");
  });
});

// ---------------------------------------------------------------------------
// Finding 2 (fixed earlier) must stay fixed.
// ---------------------------------------------------------------------------

describe("unknown subcommands", () => {
  it("exits 2, never 0 - an agent checking $? must not read a typo as success", async () => {
    for (const domain of [
      "issue",
      "mr",
      "ci",
      "project",
      "label",
      "release",
      "repo",
      "variable",
      "secret",
    ]) {
      const { code } = await cli(domain, "bogus");
      expect(code, domain).toBe(2);
    }
  });

  it("inlines the valid subcommands instead of costing a round trip to --help", async () => {
    const { out } = await cli("issue", "bogus");
    expect(out).toContain("Valid `glab-axi issue` subcommands:");
    expect(out).toContain("list");
    expect(out).toContain("view");
    expect(out).not.toContain("--help` to see available subcommands");
  });

  it("keeps a deliberate refusal's own reason and redirect", async () => {
    const { out, code } = await cli("mr", "review");
    expect(code).toBe(2);
    expect(out).toContain("mr approve");
    expect(out).not.toContain("Valid `glab-axi mr` subcommands:");
  });
});

// ---------------------------------------------------------------------------
// The help text is the guard's single source of truth, so it has to parse.
// ---------------------------------------------------------------------------

describe("parseHelpFlags", () => {
  const helps: [string, string][] = [
    ["issue", ISSUE_HELP],
    ["mr", MR_HELP],
    ["ci", CI_HELP],
    ["project", PROJECT_HELP],
    ["repo", REPO_HELP],
    ["label", LABEL_HELP],
    ["variable", VARIABLE_HELP],
    ["secret", SECRET_HELP],
    ["release", RELEASE_HELP],
    ["search", SEARCH_HELP],
  ];

  it("finds every subcommand each command documents", () => {
    for (const [domain, help] of helps) {
      expect(parseHelpFlags(help).subs.size, domain).toBeGreaterThan(0);
    }
  });

  it("reads the flags out of a per-subcommand block", () => {
    const { perSub } = parseHelpFlags(ISSUE_HELP);
    expect(perSub.get("list")).toEqual(
      new Set([
        "--state",
        "--label",
        "--author",
        "--assignee",
        "--milestone",
        "--limit",
        "--fields",
      ]),
    );
  });

  it("treats a `(none)` block as a subcommand that takes no flags", () => {
    expect(parseHelpFlags(ISSUE_HELP).perSub.get("close")).toEqual(new Set());
  });

  it("applies a bare `flags:` block to every subcommand", () => {
    const { universal, subs } = parseHelpFlags(SEARCH_HELP);
    expect(universal).toEqual(new Set(["--limit"]));
    expect(subs).toEqual(new Set(["issues", "mrs", "projects"]));
  });

  it("does not mistake a hyphenated word in prose for a flag", () => {
    // issue's `links` block prose says "related/blocking/blocked-by".
    expect(parseHelpFlags(ISSUE_HELP).perSub.get("links")).toEqual(
      new Set(["--limit"]),
    );
  });

  it("shares one flag set across a multi-subcommand block", () => {
    const { perSub } = parseHelpFlags(VARIABLE_HELP);
    for (const sub of ["get", "view", "set", "delete", "rm"]) {
      expect(perSub.get(sub), sub).toContain("--env");
    }
  });
});
