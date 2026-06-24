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
import { projectCommand } from "../src/commands/project.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const sampleProject = {
  id: 42,
  path_with_namespace: "group/proj",
  name: "Proj",
  description: "A demo project.",
  default_branch: "main",
  visibility: "private",
  star_count: 3,
  forks_count: 1,
  open_issues_count: 5,
  last_activity_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  web_url: "https://dev.egov.gy/group/proj",
  namespace: { full_path: "group" },
};

describe("project view", () => {
  it("renders detail TOON with path, default_branch and visibility", async () => {
    api.mockResolvedValueOnce(sampleProject);
    const out = await projectCommand(["view"], ctx);
    expect(out).toContain("project:");
    expect(out).toContain("path: group/proj");
    expect(out).toContain("default_branch: main");
    expect(out).toContain("visibility: private");
    // detail view stays noise-free: no help block
    expect(out).not.toContain("help[");
  });

  it("hits the project endpoint and lowercases visibility", async () => {
    api.mockResolvedValueOnce({ ...sampleProject, visibility: "PUBLIC" });
    const out = await projectCommand(["view"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toBe("projects/group%2Fproj");
    expect(out).toContain("visibility: public");
  });

  it("errors without a project context", async () => {
    await expect(projectCommand(["view"], undefined)).rejects.toThrow(
      /Could not determine the GitLab project/,
    );
  });
});

describe("project list", () => {
  it("renders list TOON with count and help", async () => {
    api.mockResolvedValueOnce([sampleProject]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain(
      "projects[1]{path,description,visibility,default_branch,stars}:",
    );
    expect(out).toContain("group/proj,A demo project.,private,main,3");
    expect(out).toContain("help[2]:");
    expect(out).toContain("project view -R");
  });

  it("works without a project context (no requireCtx)", async () => {
    api.mockResolvedValueOnce([sampleProject]);
    const out = await projectCommand(["list"], undefined);
    expect(out).toContain("count: 1");
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("membership=true");
    expect(calledPath).toContain("order_by=last_activity_at");
  });

  it("passes --owned and --search to the API", async () => {
    api.mockResolvedValueOnce([sampleProject]);
    await projectCommand(["list", "--owned", "--search", "payments"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("owned=true");
    expect(calledPath).toContain("search=payments");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("to broaden the search");
  });
});

describe("project routing", () => {
  it("shows help with no subcommand", async () => {
    const out = await projectCommand([], ctx);
    expect(out).toContain("usage: glab-axi project");
  });

  it("errors on unknown subcommand", async () => {
    const out = await projectCommand(["bogus"], ctx);
    expect(out).toContain("unknown project subcommand: bogus");
  });
});
