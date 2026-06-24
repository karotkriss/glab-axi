import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoContext } from "../src/context.js";

// Mock the glab executor so tests never shell out. projectId is kept real-ish.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glExec: vi.fn(),
  glRaw: vi.fn(),
  projectId: (ctx: RepoContext) => encodeURIComponent(ctx.project),
}));

import { glApi } from "../src/gl.js";
import { mrCommand } from "../src/commands/mr.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const sampleMr = {
  iid: 1,
  title: "Demo MR",
  state: "opened",
  author: { username: "alice" },
  source_branch: "feature-demo",
  target_branch: "master",
  draft: false,
  detailed_merge_status: "mergeable",
  head_pipeline: { status: "success" },
  web_url: "https://dev.egov.gy/group/proj/-/merge_requests/1",
  description: "Body text.",
};

describe("mr list", () => {
  it("renders list TOON with count and help", async () => {
    api.mockResolvedValueOnce([sampleMr]);
    const out = await mrCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain(
      "merge_requests[1]{iid,title,state,author,source,draft}:",
    );
    expect(out).toContain("1,Demo MR,opened,alice,feature-demo,no");
    expect(out).toContain("help[2]:");
  });

  it("passes --source-branch to the API (find-by-branch)", async () => {
    api.mockResolvedValueOnce([sampleMr]);
    await mrCommand(["list", "--source-branch", "feature-demo"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("source_branch=feature-demo");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await mrCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("to open an MR");
  });
});

describe("mr view", () => {
  it("surfaces state, merge_status and pipeline (phase-2 contract)", async () => {
    api.mockResolvedValueOnce(sampleMr);
    const out = await mrCommand(["view", "1", "--full"], ctx);
    expect(out).toContain("merge_status: mergeable");
    expect(out).toContain("pipeline: success");
    expect(out).toContain("state: opened");
  });
});

describe("mr merge", () => {
  it("is idempotent when already merged", async () => {
    api.mockResolvedValueOnce({ ...sampleMr, state: "merged" });
    const out = await mrCommand(["merge", "1"], ctx);
    expect(out).toContain("Already merged");
    expect(api).toHaveBeenCalledTimes(1); // no merge call issued
  });

  it("squash maps to squash=true", async () => {
    api.mockResolvedValueOnce({ ...sampleMr, state: "opened" }); // current
    api.mockResolvedValueOnce({ ...sampleMr, state: "merged" }); // merge result
    await mrCommand(["merge", "1", "--method", "squash"], ctx);
    const mergeCall = api.mock.calls[1];
    expect(mergeCall[0]).toContain("/merge");
    expect(
      (mergeCall[1] as { fields: Record<string, unknown> }).fields.squash,
    ).toBe(true);
  });
});

describe("mr create", () => {
  it("requires --source-branch and --title", async () => {
    await expect(mrCommand(["create", "--title", "x"], ctx)).rejects.toThrow(
      /--source-branch is required/,
    );
  });
});
