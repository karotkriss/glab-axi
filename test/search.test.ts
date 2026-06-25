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

import { searchCommand, SEARCH_HELP } from "../src/commands/search.js";
import { glApi } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};

beforeEach(() => {
  glApiMock.mockReset();
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    iid: 7,
    title: "Login bug",
    state: "opened",
    project_id: 12,
    web_url: "https://gitlab.example.com/group/project/-/issues/7",
    created_at: "2026-01-01T00:00:00Z",
    author: { username: "alice" },
    ...overrides,
  };
}

function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    iid: 9,
    title: "Fix flaky test",
    state: "merged",
    project_id: 12,
    web_url: "https://gitlab.example.com/group/project/-/merge_requests/9",
    source_branch: "fix",
    target_branch: "main",
    author: { username: "bob" },
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    path_with_namespace: "group/project",
    name: "project",
    description: "A design system",
    star_count: 42,
    last_activity_at: "2026-06-01T00:00:00Z",
    web_url: "https://gitlab.example.com/group/project",
    ...overrides,
  };
}

describe("search issues", () => {
  it("builds search?scope=issues&search=<encoded>&per_page=30 with URLSearchParams encoding", async () => {
    glApiMock.mockResolvedValueOnce([issue()]);
    await searchCommand(["issues", "login", "bug"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("scope=issues");
    // URLSearchParams encodes spaces as '+'.
    expect(path).toContain("search=login+bug");
    expect(path).toContain("per_page=30");
    expect(path.startsWith("search?")).toBe(true);
  });

  it("URLSearchParams-encodes special characters in the query", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await searchCommand(["issues", "a&b c=d"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    // '&' and '=' inside the value must be percent-encoded, spaces become '+'.
    expect(path).toContain("search=a%26b+c%3Dd");
    expect(path).not.toContain("search=a&b");
  });

  it("renders the issues schema and a count line", async () => {
    glApiMock.mockResolvedValueOnce([
      issue(),
      issue({ iid: 8, title: "Second" }),
    ]);
    const out = await searchCommand(["issues", "login"], ctx);
    expect(out).toContain("count: 2");
    expect(out).toContain("issues[2]{iid,title,state,author,project}");
    expect(out).toContain("alice");
    expect(out).toContain("opened");
  });

  it("gives a definitive empty state for zero results", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await searchCommand(["issues", "nothinghere"], ctx);
    expect(out).toContain('issues: 0 results for "nothinghere"');
  });

  it("falls back to the default limit on a non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await searchCommand(["issues", "x", "--limit", "abc"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("per_page=30");
    expect(path).not.toContain("per_page=NaN");
  });

  it("honors a numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await searchCommand(["issues", "x", "--limit", "5"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=5");
  });

  it("throws when no query is provided", async () => {
    await expect(searchCommand(["issues"], ctx)).rejects.toThrow(
      "query is required",
    );
  });
});

describe("search mrs", () => {
  it("uses scope=merge_requests", async () => {
    glApiMock.mockResolvedValueOnce([mergeRequest()]);
    await searchCommand(["mrs", "flaky"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("scope=merge_requests");
  });

  it("renders the merge_requests schema and count", async () => {
    glApiMock.mockResolvedValueOnce([mergeRequest()]);
    const out = await searchCommand(["mrs", "flaky"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("merge_requests[1]{iid,title,state,author,project}");
    expect(out).toContain("bob");
    expect(out).toContain("merged");
  });
});

describe("search projects", () => {
  it("uses scope=projects", async () => {
    glApiMock.mockResolvedValueOnce([project()]);
    await searchCommand(["projects", "design"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("scope=projects");
  });

  it("renders the projects schema (path, stars, updated)", async () => {
    glApiMock.mockResolvedValueOnce([project()]);
    const out = await searchCommand(["projects", "design"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("projects[1]{project,description,stars,updated}");
    expect(out).toContain("group/project");
    expect(out).toContain("42");
    expect(out).toContain("ago");
  });
});

describe("search router", () => {
  it("returns SEARCH_HELP for no subcommand", async () => {
    const out = await searchCommand([], ctx);
    expect(out).toBe(SEARCH_HELP);
    expect(out).toContain("usage: glab-axi search");
  });

  it("returns a renderError listing valid types for an unknown type", async () => {
    const out = await searchCommand(["bogus", "x"], ctx);
    expect(out).toContain("Unknown search type: bogus");
    expect(out).toContain("issues");
    expect(out).toContain("mrs");
    expect(out).toContain("projects");
    // No API call should have been made.
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("works without ctx (global search needs no project)", async () => {
    glApiMock.mockResolvedValueOnce([issue()]);
    const out = await searchCommand(["issues", "login"]);
    expect(glApiMock.mock.calls[0][0]).toContain("scope=issues");
    expect(out).toContain("issues[1]");
  });
});
