import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  return {
    glApi: vi.fn(),
    glRaw: vi.fn(),
    glApiResult: vi.fn(),
    projectId: (ctx?: { project: string }) =>
      ctx ? encodeURIComponent(ctx.project) : "{project}",
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { mrCommand } from "../src/commands/mr.js";
import { glApi } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

beforeEach(() => {
  glApiMock.mockReset();
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
    glApiMock.mockResolvedValueOnce(mr({ state: "closed" }));
    await mrCommand(["update", "42", "--close"], ctx);
    expect(glApiMock.mock.calls[0][1].fields).toContain("state_event=close");
  });
});

describe("mr approve / comment", () => {
  it("approve POSTs to /approve", async () => {
    glApiMock.mockResolvedValueOnce({ approved_by: [{ username: "alice" }] });
    const out = await mrCommand(["approve", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("/approve");
    expect(out).toContain("approved");
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
