import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network/jq is touched.
vi.mock("../src/gl.js", () => {
  return {
    glApi: vi.fn(),
    glRaw: vi.fn(),
    glApiResult: vi.fn(),
    runJq: vi.fn(),
    projectId: (ctx?: { project: string }) =>
      ctx ? encodeURIComponent(ctx.project) : "{project}",
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
    errorBody: (result: { stderr: string; stdout: string }) =>
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
  };
});

import { mrCommand } from "../src/commands/mr.js";
import { glApi, glApiResult, runJq } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const runJqMock = runJq as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

beforeEach(() => {
  glApiMock.mockReset();
  glApiResultMock.mockReset();
  runJqMock.mockReset();
});

function mr(overrides: Record<string, unknown> = {}) {
  return {
    iid: 42,
    title: "Add feature",
    state: "opened",
    draft: false,
    source_branch: "feature",
    target_branch: "main",
    detailed_merge_status: "mergeable",
    author: { username: "alice" },
    user_notes_count: 2,
    description: "MR body",
    web_url: "https://gitlab.example.com/group/project/-/merge_requests/42",
    head_pipeline: { status: "success" },
    has_conflicts: false,
    ...overrides,
  };
}

describe("mr list", () => {
  it("requests opened MRs and renders a TOON list with a count", async () => {
    glApiMock.mockResolvedValueOnce([mr(), mr({ iid: 43, title: "Second" })]);
    const out = await mrCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/merge_requests`);
    expect(path).toContain("state=opened");
    expect(path).toContain("per_page=30");
    expect(out).toContain("count: 2");
    expect(out).toContain("merge_requests[2]");
    expect(out).toContain("alice");
  });

  it("passes --source-branch as source_branch (find-by-branch)", async () => {
    glApiMock.mockResolvedValueOnce([mr()]);
    await mrCommand(["list", "--source-branch", "feature"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("source_branch=feature");
  });

  it("accepts --head as an alias for --source-branch", async () => {
    glApiMock.mockResolvedValueOnce([mr()]);
    await mrCommand(["list", "--head", "feature"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("source_branch=feature");
  });

  it("accepts --base as an alias for --target-branch", async () => {
    glApiMock.mockResolvedValueOnce([mr()]);
    await mrCommand(["list", "--base", "main"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("target_branch=main");
  });

  it("maps --state open to opened and all drops the filter", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await mrCommand(["list", "--state", "all"], ctx);
    expect(glApiMock.mock.calls[0][0]).not.toContain("state=");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await mrCommand(["list"], ctx);
    expect(out).toContain("0 matching merge requests");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await mrCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=30");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("supports --fields extras", async () => {
    glApiMock.mockResolvedValueOnce([mr()]);
    const out = await mrCommand(
      ["list", "--fields", "source_branch,labels"],
      ctx,
    );
    expect(out).toContain("source_branch");
  });
});

describe("mr view", () => {
  it("renders default detail with truncated body and comment hint", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    const out = await mrCommand(["view", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42`,
    );
    expect(out).toContain("merge_request");
    expect(out).toContain("use --comments");
  });

  it("--full surfaces detailed_merge_status and pipeline", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    const out = await mrCommand(["view", "42", "--full"], ctx);
    expect(out).toContain("merge_status: mergeable");
    expect(out).toContain("pipeline: success");
  });

  it("--full exposes the head SHA from `sha`", async () => {
    glApiMock.mockResolvedValueOnce(mr({ sha: "abc1234def" }));
    const out = await mrCommand(["view", "42", "--full"], ctx);
    expect(out).toContain("head_sha: abc1234def");
  });

  it("--full falls back to diff_refs.head_sha for the head SHA", async () => {
    glApiMock.mockResolvedValueOnce(
      mr({ sha: undefined, diff_refs: { head_sha: "fromdiffrefs" } }),
    );
    const out = await mrCommand(["view", "42", "--full"], ctx);
    expect(out).toContain("head_sha: fromdiffrefs");
  });

  it("emits a machine-readable state", async () => {
    glApiMock.mockResolvedValueOnce(mr({ state: "merged" }));
    const out = await mrCommand(["view", "42"], ctx);
    expect(out).toContain("state: merged");
  });

  it("resolves an MR URL to its iid", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    await mrCommand(
      ["view", "https://gitlab.example.com/group/project/-/merge_requests/42"],
      ctx,
    );
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42`,
    );
  });

  it("derives project/host from the URL when no -R flag is given", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    // No ctx: the URL's own namespace must target the request.
    await mrCommand([
      "view",
      "https://gitlab.example.com/team/sub/app/-/merge_requests/7",
    ]);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${encodeURIComponent("team/sub/app")}/merge_requests/7`,
    );
  });

  it("--comments fetches notes and filters system notes", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    glApiMock.mockResolvedValueOnce([
      {
        author: { username: "bob" },
        body: "looks good",
        created_at: "x",
        system: false,
      },
      {
        author: { username: "sys" },
        body: "changed",
        created_at: "y",
        system: true,
      },
    ]);
    const out = await mrCommand(["view", "42", "--comments"], ctx);
    expect(glApiMock.mock.calls[1][0]).toContain("/notes");
    expect(out).toContain("bob");
    expect(out).not.toContain("sys");
  });
});

describe("mr create", () => {
  it("requires --title", async () => {
    await expect(
      mrCommand(["create", "--source-branch", "x"], ctx),
    ).rejects.toThrow("--title is required");
  });

  it("requires --source-branch", async () => {
    await expect(mrCommand(["create", "--title", "x"], ctx)).rejects.toThrow(
      "--source-branch is required",
    );
  });

  it("defaults target_branch to the project default branch", async () => {
    glApiMock.mockResolvedValueOnce({ default_branch: "develop" }); // project lookup
    glApiMock.mockResolvedValueOnce(mr({ iid: 7 })); // create
    await mrCommand(["create", "--title", "T", "--source-branch", "f"], ctx);
    const createCall = glApiMock.mock.calls[1];
    expect(createCall[1].rawFields).toContain("target_branch=develop");
    expect(createCall[1].rawFields).toContain("source_branch=f");
    expect(createCall[1].method).toBe("POST");
  });

  it("prefixes Draft: when --draft is set", async () => {
    glApiMock.mockResolvedValueOnce(mr({ iid: 7 })); // create (target provided)
    await mrCommand(
      [
        "create",
        "--title",
        "T",
        "--source-branch",
        "f",
        "--target-branch",
        "main",
        "--draft",
      ],
      ctx,
    );
    const createCall = glApiMock.mock.calls[0];
    expect(createCall[1].rawFields).toContain("title=Draft: T");
  });
});

describe("mr merge", () => {
  it("is idempotent when already merged", async () => {
    glApiMock.mockResolvedValueOnce(
      mr({ state: "merged", merged_by: { username: "alice" } }),
    );
    const out = await mrCommand(["merge", "42"], ctx);
    expect(out).toContain("already: true");
    // Only the state GET — no merge PUT.
    expect(glApiMock.mock.calls.length).toBe(1);
  });

  it("squash sets squash=true on the merge call", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // state check
    glApiMock.mockResolvedValueOnce(mr({ state: "merged" })); // merge
    await mrCommand(["merge", "42", "--squash"], ctx);
    const mergeCall = glApiMock.mock.calls[1];
    expect(mergeCall[0]).toContain("/merge");
    expect(mergeCall[1].fields).toContain("squash=true");
  });

  it("rebase rebases, polls, then merges", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // state check
    glApiMock.mockResolvedValueOnce({}); // rebase PUT
    glApiMock.mockResolvedValueOnce(mr({ rebase_in_progress: false })); // poll
    glApiMock.mockResolvedValueOnce(mr({ state: "merged" })); // merge
    const out = await mrCommand(["merge", "42", "--rebase"], ctx);
    expect(glApiMock.mock.calls[1][0]).toContain("/rebase");
    expect(glApiMock.mock.calls[3][0]).toContain("/merge");
    expect(out).toContain("merged");
  });

  it("rejects more than one merge method", async () => {
    await expect(
      mrCommand(["merge", "42", "--squash", "--rebase"], ctx),
    ).rejects.toThrow("only one merge method");
  });

  it("--auto sets merge_when_pipeline_succeeds and reports the scheduled state", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // state check
    glApiMock.mockResolvedValueOnce(
      mr({ state: "opened", merge_when_pipeline_succeeds: true }),
    ); // merge PUT
    const out = await mrCommand(["merge", "42", "--auto"], ctx);
    const mergeCall = glApiMock.mock.calls[1];
    expect(mergeCall[0]).toContain("/merge");
    expect(mergeCall[1].fields).toContain("merge_when_pipeline_succeeds=true");
    expect(out).toContain("auto_merge: enabled");
    expect(out).toContain("merge_when_pipeline_succeeds: yes");
    expect(out).not.toContain("merge_commit_sha");
  });

  it("--auto merges immediately when GitLab reports the MR merged", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // state check
    glApiMock.mockResolvedValueOnce(
      mr({ state: "merged", merge_commit_sha: "abc123" }),
    ); // merge PUT merged right away
    const out = await mrCommand(["merge", "42", "--auto"], ctx);
    expect(out).toContain("merged");
    expect(out).toContain("abc123");
  });

  it("--auto combines with --squash", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // state check
    glApiMock.mockResolvedValueOnce(mr({ state: "opened" })); // merge PUT
    await mrCommand(["merge", "42", "--auto", "--squash"], ctx);
    const fields = glApiMock.mock.calls[1][1].fields;
    expect(fields).toContain("squash=true");
    expect(fields).toContain("merge_when_pipeline_succeeds=true");
  });

  it("rejects --auto combined with --rebase", async () => {
    await expect(
      mrCommand(["merge", "42", "--auto", "--rebase"], ctx),
    ).rejects.toThrow("cannot be combined with --auto");
    // Rejected before any API call.
    expect(glApiMock.mock.calls.length).toBe(0);
  });
});

describe("mr list/view --json and --jq", () => {
  it("list --json prints the raw JSON response verbatim (no TOON)", async () => {
    const raw = JSON.stringify([{ iid: 42, state: "opened" }]);
    glApiResultMock.mockResolvedValueOnce({
      stdout: raw,
      stderr: "",
      exitCode: 0,
    });
    const out = await mrCommand(["list", "--json"], ctx);
    expect(out).toBe(raw);
    // Took the raw glApiResult path, not the parsed/TOON glApi path.
    expect(glApiMock).not.toHaveBeenCalled();
    expect(glApiResultMock.mock.calls[0][0]).toContain(
      `projects/${PID}/merge_requests`,
    );
  });

  it("list --jq runs jq over the raw response", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "[{}]",
      stderr: "",
      exitCode: 0,
    });
    runJqMock.mockResolvedValueOnce({
      stdout: "42\n43\n",
      stderr: "",
      exitCode: 0,
    });
    const out = await mrCommand(["list", "--jq", ".[].iid"], ctx);
    expect(runJqMock.mock.calls[0][1]).toBe(".[].iid");
    expect(out).toBe("42\n43");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("view --json returns the raw MR object", async () => {
    const raw = JSON.stringify({ iid: 42, detailed_merge_status: "mergeable" });
    glApiResultMock.mockResolvedValueOnce({
      stdout: raw,
      stderr: "",
      exitCode: 0,
    });
    const out = await mrCommand(["view", "42", "--json"], ctx);
    expect(out).toBe(raw);
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42`,
    );
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("view --jq filters the raw MR object", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });
    runJqMock.mockResolvedValueOnce({
      stdout: "mergeable\n",
      stderr: "",
      exitCode: 0,
    });
    const out = await mrCommand(
      ["view", "42", "--jq", ".detailed_merge_status"],
      ctx,
    );
    expect(out).toBe("mergeable");
  });

  it("rejects --jq without an expression", async () => {
    await expect(mrCommand(["view", "42", "--jq"], ctx)).rejects.toThrow(
      "requires an expression",
    );
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("maps a jq program error to a validation error", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });
    runJqMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "jq: error: syntax error",
      exitCode: 3,
    });
    await expect(mrCommand(["view", "42", "--jq", ".["], ctx)).rejects.toThrow(
      "syntax error",
    );
  });

  it("surfaces an API error on the --json path", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "404 Not Found",
      exitCode: 1,
    });
    await expect(mrCommand(["view", "999", "--json"], ctx)).rejects.toThrow(
      "Resource not found",
    );
  });

  it("combines stdout and stderr for error mapping on the --json path", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: '{"message":"403 Forbidden"}',
      stderr: "request failed",
      exitCode: 1,
    });
    await expect(mrCommand(["view", "999", "--json"], ctx)).rejects.toThrow(
      "403 Forbidden",
    );
  });
});

describe("mr update", () => {
  it("--ready clears the Draft prefix and renders the final state", async () => {
    // No general updates; --ready re-GETs title then PUTs the cleaned title.
    glApiMock.mockResolvedValueOnce(mr({ title: "Draft: Add feature" })); // GET current
    glApiMock.mockResolvedValueOnce(mr({ title: "Add feature", draft: false })); // final PUT
    const out = await mrCommand(["update", "42", "--ready"], ctx);
    const finalPut = glApiMock.mock.calls[1];
    expect(finalPut[1].method).toBe("PUT");
    expect(finalPut[1].rawFields).toContain("title=Add feature");
    expect(out).toContain("Add feature");
    expect(out).not.toContain("Draft:");
  });

  it("--close sets state_event=close", async () => {
    glApiMock.mockResolvedValueOnce(mr({ state: "opened" })); // GET current
    glApiMock.mockResolvedValueOnce(mr({ state: "closed" })); // PUT
    await mrCommand(["update", "42", "--close"], ctx);
    expect(glApiMock.mock.calls[1][1].fields).toContain("state_event=close");
  });

  it("is idempotent: --close on an already-closed MR is a no-op", async () => {
    glApiMock.mockResolvedValueOnce(mr({ state: "closed" })); // GET current
    const out = await mrCommand(["update", "42", "--close"], ctx);
    // Only the GET — no PUT, no state_event re-issued.
    expect(glApiMock.mock.calls.length).toBe(1);
    expect(out).toContain("already: true");
  });

  it("is idempotent: --reopen on an already-open MR is a no-op", async () => {
    glApiMock.mockResolvedValueOnce(mr({ state: "opened" })); // GET current
    const out = await mrCommand(["update", "42", "--reopen"], ctx);
    expect(glApiMock.mock.calls.length).toBe(1);
    expect(out).toContain("already: true");
  });

  it("rejects contradictory --close and --reopen", async () => {
    await expect(
      mrCommand(["update", "42", "--close", "--reopen"], ctx),
    ).rejects.toThrow("only one of --close or --reopen");
  });

  it("rejects contradictory --ready and --draft", async () => {
    await expect(
      mrCommand(["update", "42", "--ready", "--draft"], ctx),
    ).rejects.toThrow("only one of --ready or --draft");
  });

  it("applies the Draft prefix to a provided --title when --draft is set", async () => {
    glApiMock.mockResolvedValueOnce(mr({ title: "New", draft: false })); // GET current
    glApiMock.mockResolvedValueOnce(mr({ title: "Draft: New", draft: true })); // PUT
    await mrCommand(["update", "42", "--title", "New", "--draft"], ctx);
    expect(glApiMock.mock.calls[1][1].rawFields).toContain("title=Draft: New");
  });

  it("takes the iid even when a numeric flag value precedes it", async () => {
    glApiMock.mockResolvedValueOnce(mr({ iid: 42, title: "old" })); // GET current
    glApiMock.mockResolvedValueOnce(mr({ iid: 42, title: "5" })); // PUT
    await mrCommand(["update", "--title", "5", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42`,
    );
    expect(glApiMock.mock.calls[1][1].rawFields).toContain("title=5");
  });
});

describe("mr approve / comment", () => {
  it("approve POSTs to /approve after confirming the user has not approved", async () => {
    glApiMock.mockResolvedValueOnce({ username: "alice" }); // GET /user
    glApiMock.mockResolvedValueOnce({ approved_by: [] }); // GET /approvals
    glApiMock.mockResolvedValueOnce({
      approved_by: [{ user: { username: "alice" } }],
    }); // POST /approve
    const out = await mrCommand(["approve", "42"], ctx);
    const postCall = glApiMock.mock.calls.find(
      (c) => c[1]?.method === "POST" && String(c[0]).endsWith("/approve"),
    );
    expect(postCall).toBeTruthy();
    expect(out).toContain("approved");
  });

  it("approve is a no-op when the current user has already approved", async () => {
    glApiMock.mockResolvedValueOnce({ username: "alice" }); // GET /user
    glApiMock.mockResolvedValueOnce({
      approved_by: [{ user: { username: "alice" } }],
    }); // GET /approvals
    const out = await mrCommand(["approve", "42"], ctx);
    expect(out).toContain("already: true");
    // Only the two GETs — no approve POST.
    expect(glApiMock.mock.calls.length).toBe(2);
    expect(glApiMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(
      false,
    );
  });

  it("comment requires a body", async () => {
    await expect(mrCommand(["comment", "42"], ctx)).rejects.toThrow(
      "is required",
    );
  });

  it("comment POSTs a note", async () => {
    glApiMock.mockResolvedValueOnce({});
    await mrCommand(["comment", "42", "--body", "hi"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("/notes");
    expect(glApiMock.mock.calls[0][1].rawFields).toContain("body=hi");
  });
});

describe("mr checks", () => {
  it("renders the aggregate pass/fail counts + verdict for the MR pipeline", async () => {
    glApiMock.mockResolvedValueOnce(
      mr({ head_pipeline: { id: 999, status: "failed" } }),
    ); // GET mr
    glApiMock.mockResolvedValueOnce([
      { status: "success" },
      { status: "success" },
      { status: "failed", allow_failure: false },
    ]); // jobs
    const out = await mrCommand(["checks", "42"], ctx);
    expect(out).toContain("checks: 2 passed, 1 failed");
    expect(out).toContain("verdict: failing");
    // Jobs fetched from the head pipeline's id.
    expect(glApiMock.mock.calls[1][0]).toContain("/pipelines/999/jobs");
  });

  it("counts running jobs and reports a running verdict", async () => {
    glApiMock.mockResolvedValueOnce(
      mr({ head_pipeline: { id: 5, status: "running" } }),
    );
    glApiMock.mockResolvedValueOnce([
      { status: "success" },
      { status: "running" },
    ]);
    const out = await mrCommand(["checks", "42"], ctx);
    expect(out).toContain("checks: 1 passed, 0 failed, 1 running");
    expect(out).toContain("verdict: running");
  });

  it("falls back to the MR's pipelines list when there is no head pipeline", async () => {
    glApiMock.mockResolvedValueOnce(mr({ head_pipeline: null })); // GET mr
    glApiMock.mockResolvedValueOnce([{ id: 77, status: "success" }]); // GET .../pipelines
    glApiMock.mockResolvedValueOnce([{ status: "success" }]); // jobs
    const out = await mrCommand(["checks", "42"], ctx);
    expect(glApiMock.mock.calls[1][0]).toContain(
      "/merge_requests/42/pipelines",
    );
    expect(glApiMock.mock.calls[2][0]).toContain("/pipelines/77/jobs");
    expect(out).toContain("checks: 1 passed, 0 failed");
    expect(out).toContain("verdict: passing");
  });

  it("gives a definitive message when the MR has no pipeline", async () => {
    glApiMock.mockResolvedValueOnce(mr({ head_pipeline: null })); // GET mr
    glApiMock.mockResolvedValueOnce([]); // GET .../pipelines (empty)
    const out = await mrCommand(["checks", "42"], ctx);
    expect(out).toContain("no pipeline found for merge request 42");
  });
});

describe("mr view --reviews", () => {
  it("surfaces approval state and thread resolution", async () => {
    glApiMock.mockResolvedValueOnce(mr()); // GET mr
    glApiMock.mockResolvedValueOnce({
      approvals_required: 2,
      approved_by: [{ user: { username: "alice" } }],
    }); // GET /approvals
    glApiMock.mockResolvedValueOnce([
      { notes: [{ resolvable: true, resolved: true }] }, // resolved thread
      { notes: [{ resolvable: true, resolved: false }] }, // unresolved thread
      { notes: [{ resolvable: false }] }, // plain comment, not a thread
    ]); // GET /discussions
    const out = await mrCommand(["view", "42", "--reviews"], ctx);
    expect(glApiMock.mock.calls[1][0]).toContain("/approvals");
    expect(glApiMock.mock.calls[2][0]).toContain("/discussions");
    expect(out).toContain("reviews:");
    // approvals_required=2, given=1 → not approved
    expect(out).toContain("approved: no");
    expect(out).toContain("approvals: 1/2");
    expect(out).toContain("approved_by: alice");
    expect(out).toContain("2 total, 1 resolved, 1 unresolved");
  });

  it("reports approved when the GitLab `approved` bool is present", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    glApiMock.mockResolvedValueOnce({
      approved: true,
      approvals_required: 1,
      approved_by: [{ user: { username: "bob" } }],
    });
    glApiMock.mockResolvedValueOnce([]);
    const out = await mrCommand(["view", "42", "--reviews"], ctx);
    expect(out).toContain("approved: yes");
    expect(out).toContain("0 total, 0 resolved, 0 unresolved");
  });

  it("shows approved_by none with no approvers", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    glApiMock.mockResolvedValueOnce({ approvals_required: 1, approved_by: [] });
    glApiMock.mockResolvedValueOnce([]);
    const out = await mrCommand(["view", "42", "--reviews"], ctx);
    expect(out).toContain("approved: no");
    expect(out).toContain("approved_by: none");
  });

  it("derives approved when no approval rule is configured", async () => {
    glApiMock.mockResolvedValueOnce(mr());
    glApiMock.mockResolvedValueOnce({ approvals_required: 0, approved_by: [] });
    glApiMock.mockResolvedValueOnce([]);
    const out = await mrCommand(["view", "42", "--reviews"], ctx);
    expect(out).toContain("approved: yes");
    expect(out).toContain("approvals: 0/0");
  });
});

describe("mr diff", () => {
  function change(overrides: Record<string, unknown> = {}) {
    return {
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: "@@ -1,2 +1,3 @@\n ctx\n-old\n+new1\n+new2\n",
      ...overrides,
    };
  }

  it("hits the /changes endpoint and renders a per-file summary with totals", async () => {
    glApiMock.mockResolvedValueOnce({
      changes: [
        change(), // +2 -1
        change({
          old_path: "new.ts",
          new_path: "new.ts",
          new_file: true,
          diff: "@@ -0,0 +1,2 @@\n+a\n+b\n", // +2 -0
        }),
      ],
    });
    const out = await mrCommand(["diff", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42/changes`,
    );
    expect(out).toContain("diff: 2 files changed, +4 -1");
    expect(out).toContain("files[2]");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("added");
    // The summary points at the complete diff.
    expect(out).toContain("mr diff 42 --full");
  });

  it("--full emits a reconstructed unified diff with git headers", async () => {
    glApiMock.mockResolvedValueOnce({
      changes: [
        change({
          old_path: "new.ts",
          new_path: "new.ts",
          new_file: true,
          diff: "@@ -0,0 +1,2 @@\n+a\n+b\n",
        }),
        change({
          old_path: "gone.ts",
          new_path: "gone.ts",
          deleted_file: true,
          diff: "@@ -1,2 +0,0 @@\n-x\n-y\n",
        }),
      ],
    });
    const out = await mrCommand(["diff", "42", "--full"], ctx);
    expect(out).toContain("merge_request_diff");
    expect(out).toContain("files_changed: 2");
    expect(out).toContain("diff --git a/new.ts b/new.ts");
    expect(out).toContain("new file mode 100644");
    expect(out).toContain("deleted file mode 100644");
    // new file: old side maps to /dev/null; deleted file: new side does.
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ /dev/null");
  });

  it("renders a rename as `old -> new`", async () => {
    glApiMock.mockResolvedValueOnce({
      changes: [
        change({
          old_path: "old.ts",
          new_path: "renamed.ts",
          renamed_file: true,
          diff: "",
        }),
      ],
    });
    const out = await mrCommand(["diff", "42"], ctx);
    expect(out).toContain("old.ts -> renamed.ts");
    expect(out).toContain("renamed");
  });

  it("--full emits rename headers with no trailing garbage for a pure rename", async () => {
    glApiMock.mockResolvedValueOnce({
      changes: [
        change({
          old_path: "old.ts",
          new_path: "renamed.ts",
          renamed_file: true,
          diff: "",
        }),
      ],
    });
    const out = await mrCommand(["diff", "42", "--full"], ctx);
    expect(out).toContain("rename from old.ts");
    expect(out).toContain("rename to renamed.ts");
    expect(out).not.toContain("--- a/old.ts");
  });

  it("gives a definitive empty state when there are no changes", async () => {
    glApiMock.mockResolvedValueOnce({ changes: [] });
    const out = await mrCommand(["diff", "42"], ctx);
    expect(out).toContain("no file changes found for merge request 42");
  });

  it("flags a server-truncated (overflow) diff in the summary", async () => {
    glApiMock.mockResolvedValueOnce({ changes: [change()], overflow: true });
    const out = await mrCommand(["diff", "42"], ctx);
    expect(out).toContain("server-truncated");
  });

  it("resolves an MR URL to its iid", async () => {
    glApiMock.mockResolvedValueOnce({ changes: [change()] });
    await mrCommand(
      ["diff", "https://gitlab.example.com/group/project/-/merge_requests/42"],
      ctx,
    );
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42/changes`,
    );
  });
});

describe("mr router", () => {
  it("returns help for no subcommand", async () => {
    const out = await mrCommand([], ctx);
    expect(out).toContain("usage: glab-axi mr");
  });

  it("errors on unknown subcommand", async () => {
    const out = await mrCommand(["bogus"], ctx);
    expect(out).toContain("Unknown mr subcommand");
  });
});
