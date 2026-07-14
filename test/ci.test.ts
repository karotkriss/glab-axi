import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// Mock the delay so `ci watch` polls instantly instead of waiting real seconds.
vi.mock("../src/sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { ciCommand } from "../src/commands/ci.js";
import { glApi, glRaw } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glRawMock = glRaw as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

beforeEach(() => {
  glApiMock.mockReset();
  glRawMock.mockReset();
  // `ci watch` signals a failed pipeline via process.exitCode; keep tests isolated.
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    iid: 7,
    status: "failed",
    ref: "main",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    source: "push",
    web_url: "https://gitlab.example.com/group/project/-/pipelines/12345",
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "build",
    status: "success",
    stage: "build",
    allow_failure: false,
    web_url: "https://gitlab.example.com/group/project/-/jobs/1",
    ...overrides,
  };
}

// A mixed job set that exercises every branch of classifyJob.
function mixedJobs() {
  return [
    job({ id: 1, name: "compile", status: "success" }),
    job({ id: 2, name: "lint", status: "failed", allow_failure: false }),
    job({ id: 3, name: "flaky", status: "failed", allow_failure: true }),
    job({ id: 4, name: "deploy", status: "canceled" }),
    job({ id: 5, name: "test", status: "running" }),
    job({ id: 6, name: "package", status: "pending" }),
    job({ id: 7, name: "release", status: "manual" }),
    job({ id: 8, name: "docs", status: "skipped" }),
  ];
}

describe("ci list", () => {
  it("requests pipelines with default limit and renders a TOON list", async () => {
    glApiMock.mockResolvedValueOnce([pipeline(), pipeline({ id: 12346 })]);
    const out = await ciCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/pipelines`);
    expect(path).toContain("per_page=20");
    expect(path).toContain("order_by=updated_at");
    expect(out).toContain("count: 2");
    expect(out).toContain("pipelines[2]");
  });

  it("renders an 8-char short sha (custom slice)", async () => {
    glApiMock.mockResolvedValueOnce([pipeline()]);
    const out = await ciCommand(["list"], ctx);
    expect(out).toContain("abcdef01");
    expect(out).not.toContain("abcdef0123456789");
  });

  it("passes --ref and --status as query params", async () => {
    glApiMock.mockResolvedValueOnce([pipeline()]);
    await ciCommand(["list", "--ref", "feature-1", "--status", "failed"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("ref=feature-1");
    expect(path).toContain("status=failed");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await ciCommand(["list"], ctx);
    expect(out).toContain("0 pipelines found");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await ciCommand(["list", "--limit", "abc"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("per_page=20");
    expect(path).not.toContain("per_page=NaN");
  });
});

describe("ci bucketing / summary + verdict", () => {
  it("buckets a mixed job set exactly per the GetChecks contract", async () => {
    glApiMock.mockResolvedValueOnce(pipeline()); // pipeline
    glApiMock.mockResolvedValueOnce(mixedJobs()); // jobs
    const out = await ciCommand(["view", "12345"], ctx);
    // success + allow_failure failed => 2 passed
    // failed(not allowed) + canceled => 2 failed
    // running + pending => 2 running
    // manual + skipped => neutral (excluded from passed/failed/running)
    expect(out).toContain("checks: 2 passed, 2 failed, 2 running");
    expect(out).toContain("verdict: failing");
  });

  it("counts GitLab's other in-progress statuses (preparing/scheduled/waiting_for_resource) as running", async () => {
    glApiMock.mockResolvedValueOnce([
      job({ id: 1, status: "success" }),
      job({ id: 2, status: "preparing" }),
      job({ id: 3, status: "waiting_for_resource" }),
      job({ id: 4, status: "scheduled" }),
    ]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(out).toContain("checks: 1 passed, 0 failed, 3 running");
    expect(out).toContain("verdict: running");
  });

  it("verdict is passing when only passes (incl. allowed failures) and neutrals", async () => {
    glApiMock.mockResolvedValueOnce([
      job({ id: 1, status: "success" }),
      job({ id: 2, status: "failed", allow_failure: true }),
      job({ id: 3, status: "manual" }),
      job({ id: 4, status: "skipped" }),
    ]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(out).toContain("checks: 2 passed, 0 failed");
    expect(out).not.toContain("running");
    expect(out).toContain("verdict: passing");
  });

  it("verdict is running when no failures but some running and omits passed-only edge", async () => {
    glApiMock.mockResolvedValueOnce([
      job({ id: 1, status: "success" }),
      job({ id: 2, status: "running" }),
      job({ id: 3, status: "created" }),
    ]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(out).toContain("checks: 1 passed, 0 failed, 2 running");
    expect(out).toContain("verdict: running");
  });

  it("verdict is no jobs when only neutral jobs exist", async () => {
    glApiMock.mockResolvedValueOnce([
      job({ id: 1, status: "manual" }),
      job({ id: 2, status: "skipped" }),
    ]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(out).toContain("checks: 0 passed, 0 failed");
    expect(out).toContain("verdict: no jobs");
  });

  it("canceled counts as a failure", async () => {
    glApiMock.mockResolvedValueOnce([job({ id: 1, status: "canceled" })]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(out).toContain("checks: 0 passed, 1 failed");
    expect(out).toContain("verdict: failing");
  });
});

describe("ci view", () => {
  it("fetches the pipeline and its jobs and renders detail + jobs list", async () => {
    glApiMock.mockResolvedValueOnce(pipeline());
    glApiMock.mockResolvedValueOnce([job(), job({ id: 2, name: "test" })]);
    const out = await ciCommand(["view", "12345"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}/pipelines/12345`);
    expect(glApiMock.mock.calls[1][0]).toBe(
      `projects/${PID}/pipelines/12345/jobs`,
    );
    expect(out).toContain("pipeline");
    expect(out).toContain("jobs[2]");
    expect(out).toContain("bucket");
  });
});

describe("ci status", () => {
  it("--mr uses head_pipeline when present", async () => {
    glApiMock.mockResolvedValueOnce({
      head_pipeline: {
        id: 999,
        status: "running",
        ref: "main",
        sha: "x",
        web_url: "u",
      },
    });
    glApiMock.mockResolvedValueOnce([job({ status: "running" })]);
    const out = await ciCommand(["status", "--mr", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/42`,
    );
    expect(glApiMock.mock.calls[1][0]).toBe(
      `projects/${PID}/pipelines/999/jobs`,
    );
    expect(out).toContain("verdict: running");
  });

  it("--mr falls back to /pipelines when head_pipeline is null", async () => {
    glApiMock.mockResolvedValueOnce({ head_pipeline: null });
    glApiMock.mockResolvedValueOnce([pipeline({ id: 555 })]);
    glApiMock.mockResolvedValueOnce([job({ status: "success" })]);
    const out = await ciCommand(["status", "--mr", "42"], ctx);
    expect(glApiMock.mock.calls[1][0]).toBe(
      `projects/${PID}/merge_requests/42/pipelines`,
    );
    expect(glApiMock.mock.calls[2][0]).toBe(
      `projects/${PID}/pipelines/555/jobs`,
    );
    expect(out).toContain("verdict: passing");
  });

  it("--branch uses ref + per_page=1 then fetches jobs", async () => {
    glApiMock.mockResolvedValueOnce([pipeline({ id: 777 })]);
    glApiMock.mockResolvedValueOnce([job({ status: "success" })]);
    await ciCommand(["status", "--branch", "feature-1"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("ref=feature-1");
    expect(path).toContain("per_page=1");
    expect(glApiMock.mock.calls[1][0]).toBe(
      `projects/${PID}/pipelines/777/jobs`,
    );
  });

  it("--branch gives a definitive empty state when no pipeline", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await ciCommand(["status", "--branch", "ghost"], ctx);
    expect(out).toContain("no pipeline found for branch ghost");
  });

  it("throws when neither --mr nor --branch is given", async () => {
    await expect(ciCommand(["status"], ctx)).rejects.toThrow(/--mr|--branch/);
  });
});

describe("ci watch", () => {
  it("blocks through running polls, returns on a terminal state, exits 0 on success", async () => {
    glApiMock
      .mockResolvedValueOnce(pipeline({ status: "running" })) // poll 1
      .mockResolvedValueOnce(pipeline({ status: "running" })) // poll 2
      .mockResolvedValueOnce(pipeline({ status: "success" })) // poll 3: terminal
      .mockResolvedValueOnce([job({ status: "success" })]); // final jobs
    const out = await ciCommand(["watch", "12345"], ctx);

    // Polled the pipeline 3 times, then fetched jobs once.
    expect(glApiMock.mock.calls.length).toBe(4);
    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}/pipelines/12345`);
    expect(glApiMock.mock.calls[3][0]).toBe(
      `projects/${PID}/pipelines/12345/jobs`,
    );
    expect(out).toContain("status: success");
    expect(out).toContain("verdict: passing");
    expect(process.exitCode).toBe(0);
  });

  it("returns immediately when the pipeline is already terminal", async () => {
    glApiMock
      .mockResolvedValueOnce(pipeline({ status: "failed" }))
      .mockResolvedValueOnce([job({ status: "failed", allow_failure: false })]);
    const out = await ciCommand(["watch", "12345"], ctx);
    expect(glApiMock.mock.calls.length).toBe(2);
    expect(out).toContain("verdict: failing");
    expect(process.exitCode).toBe(1);
  });

  it("exit code follows the pipeline status, not the job verdict", async () => {
    // A canceled pipeline whose recorded jobs all passed still exits non-zero.
    glApiMock
      .mockResolvedValueOnce(pipeline({ status: "canceled" }))
      .mockResolvedValueOnce([job({ status: "success" })]);
    const out = await ciCommand(["watch", "12345"], ctx);
    expect(out).toContain("verdict: passing");
    expect(process.exitCode).toBe(1);
  });

  it("times out after the bounded number of polls and never spins forever", async () => {
    // interval 5s / timeout 10s => at most 2 polls, both still running.
    glApiMock
      .mockResolvedValueOnce(pipeline({ status: "running" }))
      .mockResolvedValueOnce(pipeline({ status: "running" }));
    await expect(
      ciCommand(["watch", "12345", "--interval", "5", "--timeout", "10"], ctx),
    ).rejects.toThrow(/Timed out/);
    expect(glApiMock.mock.calls.length).toBe(2);
  });
});

describe("ci jobs", () => {
  it("GETs the pipeline jobs and renders summary + list", async () => {
    glApiMock.mockResolvedValueOnce([job(), job({ id: 2 })]);
    const out = await ciCommand(["jobs", "12345"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/pipelines/12345/jobs`,
    );
    expect(out).toContain("jobs[2]");
    expect(out).toContain("checks:");
  });
});

describe("ci log", () => {
  it("tails the last 20000 chars by default and flags truncation", async () => {
    const big = "a".repeat(25000) + "TAIL_END";
    glRawMock.mockResolvedValueOnce(big);
    const out = await ciCommand(["log", "67890"], ctx);
    expect(glRawMock.mock.calls[0][0]).toBe(`projects/${PID}/jobs/67890/trace`);
    expect(out).toContain("truncated: true");
    expect(out).toContain(`original_length: ${big.length}`);
    expect(out).toContain("TAIL_END");
    expect(out).toContain("--full");
  });

  it("--full returns the entire trace, untruncated", async () => {
    const big = "b".repeat(25000);
    glRawMock.mockResolvedValueOnce(big);
    const out = await ciCommand(["log", "67890", "--full"], ctx);
    expect(out).toContain("truncated: false");
    expect(out).not.toContain("original_length");
  });

  it("does not truncate short logs", async () => {
    glRawMock.mockResolvedValueOnce("short log");
    const out = await ciCommand(["log", "67890"], ctx);
    expect(out).toContain("truncated: false");
    expect(out).toContain("short log");
  });
});

describe("ci retry", () => {
  it("POSTs to /retry and renders pipeline id + status", async () => {
    glApiMock.mockResolvedValueOnce(pipeline({ id: 12345, status: "running" }));
    const out = await ciCommand(["retry", "12345"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/pipelines/12345/retry`,
    );
    expect(glApiMock.mock.calls[0][1].method).toBe("POST");
    expect(out).toContain("id: 12345");
    expect(out).toContain("status: running");
  });
});

describe("ci router", () => {
  it("returns help for no subcommand", async () => {
    const out = await ciCommand([], ctx);
    expect(out).toContain("usage: glab-axi ci");
  });

  it("errors on unknown subcommand", async () => {
    const out = await ciCommand(["bogus"], ctx);
    expect(out).toContain("Unknown ci subcommand");
  });
});
