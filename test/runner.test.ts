import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  const glApi = vi.fn();
  return {
    glApi,
    glApiList: vi.fn(async (path: string, opts?: unknown) => ({
      data: (await glApi(path, opts)) ?? [],
      total: null,
    })),
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { runnerCommand } from "../src/commands/runner.js";
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

describe("runner list", () => {
  it("lists the project's runners with type/online/paused/status", async () => {
    glApiMock.mockResolvedValueOnce([
      {
        id: 175,
        description: "docker runner",
        runner_type: "instance_type",
        online: true,
        paused: false,
        status: "online",
      },
    ]);
    const out = await runnerCommand(["list"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain(`projects/${PID}/runners`);
    expect(out).toContain(
      "runners[1]{id,description,type,online,paused,status}",
    );
    expect(out).toContain("175,docker runner,instance_type,yes,no,online");
  });

  it("passes --status and --tag-list through as query params", async () => {
    glApiMock.mockResolvedValueOnce([{ id: 1 }]);
    await runnerCommand(
      ["list", "--status", "online", "--tag-list", "docker"],
      ctx,
    );
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("status=online");
    expect(path).toContain("tag_list=docker");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await runnerCommand(["list"], ctx);
    expect(out).toContain("0 runners found");
  });
});

describe("runner view", () => {
  it("shows the runner's tags and states, and warns the executor is not in the API", async () => {
    glApiMock.mockResolvedValueOnce({
      id: 175,
      description: "docker runner",
      runner_type: "project_type",
      tag_list: ["docker", "linux"],
      run_untagged: false,
      online: true,
      paused: false,
      status: "online",
      access_level: "not_protected",
      platform: "linux",
      version: "16.0.0",
    });
    const out = await runnerCommand(["view", "175"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe("runners/175");
    expect(out).toContain("docker,linux");
    expect(out).toContain("run_untagged: no");
    // The honest executor caveat is stated, never silently omitted.
    expect(out).toContain("executor");
  });
});

describe("runner router", () => {
  it("returns help for no subcommand", async () => {
    const out = await runnerCommand([], ctx);
    expect(out).toContain("usage: glab-axi runner");
  });

  it("errors on an unknown subcommand", async () => {
    await expect(runnerCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown runner subcommand",
    );
  });
});
