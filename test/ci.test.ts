import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoContext } from "../src/context.js";

// Mock the glab executor so tests never shell out. projectId is kept real-ish.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glExec: vi.fn(),
  glRaw: vi.fn(),
  projectId: (ctx: RepoContext) => encodeURIComponent(ctx.project),
}));

import { glApi, glRaw } from "../src/gl.js";
import { ciCommand } from "../src/commands/ci.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);
const raw = vi.mocked(glRaw);

beforeEach(() => {
  api.mockReset();
  raw.mockReset();
});

const samplePipeline = {
  id: 12345,
  iid: 42,
  status: "failed",
  ref: "feature-demo",
  sha: "abc123",
  source: "push",
  web_url: "https://dev.egov.gy/group/proj/-/pipelines/12345",
  created_at: "2026-06-24T10:00:00Z",
  updated_at: "2026-06-24T10:05:00Z",
};

// A realistic mix exercising every bucket:
//  - build success -> passed
//  - test failed (blocking) -> failed
//  - flaky failed but allow_failure -> NOT a failure (passed-ish)
//  - deploy manual -> neutral (ignored)
//  - lint skipped -> neutral (ignored)
//  - integration running -> running
const sampleJobs = [
  {
    id: 1,
    name: "build",
    stage: "build",
    status: "success",
    allow_failure: false,
  },
  {
    id: 2,
    name: "test",
    stage: "test",
    status: "failed",
    allow_failure: false,
  },
  {
    id: 3,
    name: "flaky",
    stage: "test",
    status: "failed",
    allow_failure: true,
  },
  {
    id: 4,
    name: "deploy",
    stage: "deploy",
    status: "manual",
    allow_failure: false,
  },
  {
    id: 5,
    name: "lint",
    stage: "test",
    status: "skipped",
    allow_failure: false,
  },
  {
    id: 6,
    name: "integration",
    stage: "test",
    status: "running",
    allow_failure: false,
  },
];

describe("ci list", () => {
  it("renders pipeline list TOON with count and help", async () => {
    api.mockResolvedValueOnce([samplePipeline]);
    const out = await ciCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("pipelines[1]{id,status,ref,source,updated}:");
    expect(out).toContain("12345,failed,feature-demo,push,");
    expect(out).toContain("help[2]:");
  });

  it("passes --ref and --status to the API", async () => {
    api.mockResolvedValueOnce([samplePipeline]);
    await ciCommand(["list", "--ref", "main", "--status", "failed"], ctx);
    const path = api.mock.calls[0][0] as string;
    expect(path).toContain("ref=main");
    expect(path).toContain("status=failed");
    expect(path).toContain("order_by=id");
    expect(path).toContain("sort=desc");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await ciCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("No pipelines found");
  });
});

describe("ci status --mr", () => {
  it("resolves head_pipeline then aggregates jobs into the bucket summary", async () => {
    // 1) GET merge_requests/:iid -> head_pipeline
    api.mockResolvedValueOnce({
      iid: 17,
      head_pipeline: { id: 12345, status: "failed" },
    });
    // 2) GET pipelines/:pid/jobs
    api.mockResolvedValueOnce(sampleJobs);

    const out = await ciCommand(["status", "--mr", "17"], ctx);

    // build(success)+flaky(allow_failure) => 2 passed
    // test(failed,blocking) => 1 failed; manual/skipped excluded
    // integration(running) => 1 running
    expect(out).toContain("checks: 2 passed, 1 failed, 1 running (6 jobs)");
    expect(out).toContain("result: failed");
    expect(out).toContain("pipeline: 12345");

    // Confirm it resolved via the MR endpoint then the jobs endpoint.
    expect(api.mock.calls[0][0]).toContain("/merge_requests/17");
    expect(api.mock.calls[1][0]).toContain("/pipelines/12345/jobs");

    // Help should steer the agent toward the failing jobs.
    expect(out).toContain("--scope failed");
  });

  it("does NOT count allow_failure failures, manual, or skipped as failures (green path)", async () => {
    api.mockResolvedValueOnce({
      iid: 18,
      head_pipeline: { id: 999, status: "success" },
    });
    api.mockResolvedValueOnce([
      {
        id: 10,
        name: "build",
        stage: "build",
        status: "success",
        allow_failure: false,
      },
      {
        id: 11,
        name: "flaky",
        stage: "test",
        status: "failed",
        allow_failure: true,
      },
      {
        id: 12,
        name: "deploy",
        stage: "deploy",
        status: "manual",
        allow_failure: false,
      },
      {
        id: 13,
        name: "lint",
        stage: "test",
        status: "skipped",
        allow_failure: false,
      },
    ]);
    const out = await ciCommand(["status", "--mr", "18"], ctx);
    expect(out).toContain("checks: 2 passed, 0 failed, 0 running (4 jobs)");
    expect(out).toContain("result: passed");
  });

  it("falls back to MR pipeline list when head_pipeline is absent", async () => {
    api.mockResolvedValueOnce({ iid: 19, head_pipeline: null });
    api.mockResolvedValueOnce([{ id: 777, status: "success" }]); // /merge_requests/19/pipelines
    api.mockResolvedValueOnce([
      {
        id: 20,
        name: "build",
        stage: "build",
        status: "success",
        allow_failure: false,
      },
    ]);
    const out = await ciCommand(["status", "--mr", "19"], ctx);
    expect(api.mock.calls[1][0]).toContain("/merge_requests/19/pipelines");
    expect(out).toContain("pipeline: 777");
    expect(out).toContain("checks: 1 passed, 0 failed, 0 running (1 jobs)");
  });

  it("errors clearly when an MR has no pipeline (not a crash)", async () => {
    api.mockResolvedValueOnce({ iid: 20, head_pipeline: null });
    api.mockResolvedValueOnce([]); // no MR pipelines
    await expect(ciCommand(["status", "--mr", "20"], ctx)).rejects.toThrow(
      /no pipeline found for MR !20/,
    );
  });
});

describe("ci status --branch", () => {
  it("resolves the latest pipeline for a branch then summarizes", async () => {
    api.mockResolvedValueOnce([{ id: 555, status: "running" }]); // pipelines?ref=...&per_page=1
    api.mockResolvedValueOnce([
      {
        id: 30,
        name: "build",
        stage: "build",
        status: "running",
        allow_failure: false,
      },
    ]);
    const out = await ciCommand(["status", "--branch", "main"], ctx);
    const firstPath = api.mock.calls[0][0] as string;
    expect(firstPath).toContain("ref=main");
    expect(firstPath).toContain("per_page=1");
    expect(out).toContain("pipeline: 555");
    expect(out).toContain("result: running");
  });

  it("errors clearly when no pipeline exists for the branch", async () => {
    api.mockResolvedValueOnce([]);
    await expect(
      ciCommand(["status", "--branch", "nope"], ctx),
    ).rejects.toThrow(/no pipeline found for nope/);
  });

  it("requires --mr or --branch", async () => {
    await expect(ciCommand(["status"], ctx)).rejects.toThrow(/needs a target/);
  });
});

describe("ci view", () => {
  it("shows pipeline detail plus its jobs and a summary", async () => {
    api.mockResolvedValueOnce(samplePipeline); // pipeline
    api.mockResolvedValueOnce(sampleJobs); // jobs
    const out = await ciCommand(["view", "12345"], ctx);
    expect(out).toContain("pipeline:");
    expect(out).toContain("id: 12345");
    expect(out).toContain("https://dev.egov.gy/group/proj/-/pipelines/12345");
    expect(out).toContain("checks: 2 passed, 1 failed, 1 running (6 jobs)");
    expect(out).toContain("jobs[6]{id,name,stage,status}:");
  });
});

describe("ci jobs", () => {
  it("passes --scope to the API and lists jobs", async () => {
    api.mockResolvedValueOnce([sampleJobs[1]]); // failed only
    const out = await ciCommand(["jobs", "12345", "--scope", "failed"], ctx);
    const path = api.mock.calls[0][0] as string;
    expect(path).toContain("/pipelines/12345/jobs");
    expect(path).toContain("scope=failed");
    expect(out).toContain("count: 1");
    expect(out).toContain("2,test,test,failed");
  });
});

describe("ci log", () => {
  it("tails the trace and marks it truncated by default", async () => {
    const big = "X".repeat(25000) + "FATAL: boom at the end";
    raw.mockResolvedValueOnce({ stdout: big, stderr: "", exitCode: 0 });
    const out = await ciCommand(["log", "67890"], ctx);
    expect(raw).toHaveBeenCalledWith(
      ["api", "projects/group%2Fproj/jobs/67890/trace"],
      ctx,
    );
    expect(out).toContain("ci_log:");
    expect(out).toContain("job: 67890");
    expect(out).toContain("truncated: true");
    expect(out).toContain(`original_length: ${big.length}`);
    // The tail (with the failure) is kept; the head is dropped.
    expect(out).toContain("FATAL: boom at the end");
  });

  it("--full returns the whole log untruncated", async () => {
    const big = "Y".repeat(25000) + "DONE";
    raw.mockResolvedValueOnce({ stdout: big, stderr: "", exitCode: 0 });
    const out = await ciCommand(["log", "67890", "--full"], ctx);
    expect(out).toContain("truncated: false");
    expect(out).toContain(`original_length: ${big.length}`);
  });

  it("errors clearly when the trace cannot be fetched", async () => {
    raw.mockResolvedValueOnce({ stdout: "", stderr: "404", exitCode: 1 });
    await expect(ciCommand(["log", "1"], ctx)).rejects.toThrow(
      /could not fetch trace for job 1/,
    );
  });
});

describe("ci retry", () => {
  it("POSTs to the retry endpoint", async () => {
    api.mockResolvedValueOnce({ ...samplePipeline, status: "running" });
    await ciCommand(["retry", "12345"], ctx);
    expect(api.mock.calls[0][0]).toContain("/pipelines/12345/retry");
    expect((api.mock.calls[0][1] as { method: string }).method).toBe("POST");
  });
});

describe("ci dispatch", () => {
  it("returns help with no subcommand", async () => {
    const out = await ciCommand([], ctx);
    expect(out).toContain("usage: glab-axi ci");
  });

  it("errors on an unknown subcommand", async () => {
    const out = await ciCommand(["bogus"], ctx);
    expect(out).toContain("unknown ci subcommand: bogus");
  });
});
