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
import { searchCommand } from "../src/commands/search.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const sampleIssue = {
  iid: 7,
  title: "Login bug on submit",
  state: "opened",
  author: { username: "alice" },
  web_url: "https://dev.egov.gy/group/proj/-/issues/7",
  created_at: "2026-06-01T10:00:00Z",
};

const sampleMr = {
  iid: 12,
  title: "Refactor auth module",
  state: "opened",
  author: { username: "bob" },
  web_url: "https://dev.egov.gy/group/proj/-/merge_requests/12",
  created_at: "2026-06-02T10:00:00Z",
};

const sampleProject = {
  path_with_namespace: "group/payments",
  description: "Payment processing service",
  star_count: 9,
  last_activity_at: "2026-06-20T10:00:00Z",
};

describe("search issues", () => {
  it("renders issues TOON with count and help", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    const out = await searchCommand(["issues", "login", "bug"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("issues[1]{iid,title,state,author,url,created}:");
    expect(out).toContain("7,Login bug on submit,opened,alice,");
    expect(out).toContain("help[2]:");
    expect(out).toContain("issue view <iid>");
  });

  it("passes the query url-encoded as search= to the API", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    await searchCommand(["issues", "login", "bug"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("projects/group%2Fproj/issues?");
    expect(calledPath).toContain("search=login+bug");
    expect(calledPath).toContain("per_page=30");
  });

  it("honours --limit", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    await searchCommand(["issues", "bug", "--limit", "5"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("per_page=5");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await searchCommand(["issues", "nonexistent"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("issues: []");
    expect(out).toContain("help[1]:");
    expect(out).toContain("No issues match");
  });
});

describe("search mrs", () => {
  it("renders merge_requests TOON scoped to project", async () => {
    api.mockResolvedValueOnce([sampleMr]);
    const out = await searchCommand(["mrs", "refactor"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain(
      "merge_requests[1]{iid,title,state,author,url,created}:",
    );
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("projects/group%2Fproj/merge_requests?");
    expect(calledPath).toContain("search=refactor");
  });
});

describe("search projects", () => {
  it("does NOT require ctx and orders by last activity", async () => {
    api.mockResolvedValueOnce([sampleProject]);
    const out = await searchCommand(["projects", "payments"], undefined);
    expect(out).toContain("count: 1");
    expect(out).toContain("projects[1]{path,description,stars,activity}:");
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toMatch(/^projects\?/);
    expect(calledPath).toContain("search=payments");
    expect(calledPath).toContain("order_by=last_activity_at");
  });
});

describe("search validation", () => {
  it("throws when the query is empty", async () => {
    await expect(searchCommand(["issues"], ctx)).rejects.toThrow(
      /search requires a query/,
    );
  });

  it("throws when only the --help-less type and a bare flag are given", async () => {
    await expect(searchCommand(["issues", "--verbose"], ctx)).rejects.toThrow(
      /search requires a query/,
    );
  });

  it("returns an error listing valid types for an unknown type", async () => {
    const out = await searchCommand(["wikis", "foo"], ctx);
    expect(out).toContain("unknown search type: wikis");
    expect(out).toContain("issues, mrs, projects");
    expect(api).not.toHaveBeenCalled();
  });

  it("requires ctx for issue search", async () => {
    await expect(searchCommand(["issues", "bug"], undefined)).rejects.toThrow(
      /Could not determine the GitLab project/,
    );
  });
});
