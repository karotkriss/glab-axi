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
      if (!ctx)
        throw new Error("Could not determine the target GitLab project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { projectCommand, PROJECT_HELP } from "../src/commands/project.js";
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

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    path_with_namespace: "group/project",
    name: "project",
    name_with_namespace: "group / project",
    description: "A sample project",
    default_branch: "main",
    visibility: "private",
    star_count: 3,
    forks_count: 1,
    open_issues_count: 5,
    last_activity_at: "2026-06-20T00:00:00Z",
    web_url: "https://gitlab.example.com/group/project",
    topics: ["a", "b"],
    archived: false,
    http_url_to_repo: "https://gitlab.example.com/group/project.git",
    ...overrides,
  };
}

describe("project view", () => {
  it("GETs the encoded project path", async () => {
    glApiMock.mockResolvedValueOnce(project());
    await projectCommand(["view"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}`);
  });

  it("renders the detail fields with renamed keys", async () => {
    glApiMock.mockResolvedValueOnce(project());
    const out = await projectCommand(["view"], ctx);
    expect(out).toContain("project");
    expect(out).toContain("group/project");
    expect(out).toContain("default_branch: main");
    expect(out).toContain("visibility: private");
    expect(out).toContain("stars: 3");
    expect(out).toContain("forks: 1");
    expect(out).toContain("open_issues: 5");
    expect(out).toContain("https://gitlab.example.com/group/project");
  });

  it("includes project suggestions (issues/mr)", async () => {
    glApiMock.mockResolvedValueOnce(project());
    const out = await projectCommand(["view"], ctx);
    expect(out).toContain("issue list");
    expect(out).toContain("mr list");
  });

  it("throws an actionable error when the project is unresolved", async () => {
    await expect(projectCommand(["view"])).rejects.toThrow(
      "Could not determine the target GitLab project",
    );
  });
});

describe("project list", () => {
  it("requests membership projects ordered by last activity", async () => {
    glApiMock.mockResolvedValueOnce([
      project(),
      project({ path_with_namespace: "group/other" }),
    ]);
    await projectCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("projects?");
    expect(path).toContain("membership=true");
    expect(path).toContain("order_by=last_activity_at");
    expect(path).toContain("per_page=30");
  });

  it("renders a TOON list with a count line", async () => {
    glApiMock.mockResolvedValueOnce([
      project(),
      project({ path_with_namespace: "group/other" }),
    ]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("count: 2");
    expect(out).toContain("projects[2]");
    expect(out).toContain("group/project");
  });

  it("passes --search as the search= param", async () => {
    glApiMock.mockResolvedValueOnce([project()]);
    await projectCommand(["list", "--search", "platform"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("search=platform");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("projects: 0 projects found");
  });

  it("falls back to the default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await projectCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=30");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("honors a numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await projectCommand(["list", "--limit", "50"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=50");
  });
});

describe("project router", () => {
  it("returns help for no subcommand", async () => {
    const out = await projectCommand([], ctx);
    expect(out).toBe(PROJECT_HELP);
    expect(out).toContain("usage: glab-axi project");
  });

  it("errors on an unknown subcommand", async () => {
    const out = await projectCommand(["bogus"], ctx);
    expect(out).toContain("Unknown project subcommand");
  });
});
