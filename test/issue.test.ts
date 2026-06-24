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
import { issueCommand } from "../src/commands/issue.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const sampleIssue = {
  iid: 42,
  title: "Fix login",
  state: "opened",
  author: { username: "alice" },
  labels: ["bug", "ui"],
  milestone: { title: "v1.0" },
  created_at: "2026-06-20T10:00:00Z",
  updated_at: "2026-06-23T10:00:00Z",
  web_url: "https://dev.egov.gy/group/proj/-/issues/42",
  description: "Login is broken.",
  user_notes_count: 2,
};

describe("issue list", () => {
  it("renders list TOON with count and help", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    const out = await issueCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("issues[1]{iid,title,state,author,created}:");
    expect(out).toContain("42,Fix login,opened,alice,");
    expect(out).toContain("help[2]:");
  });

  it("passes filters to the API", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    await issueCommand(["list", "--state", "opened", "--label", "bug"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("state=opened");
    expect(calledPath).toContain("labels=bug");
  });

  it("offers extra columns via --fields", async () => {
    api.mockResolvedValueOnce([sampleIssue]);
    const out = await issueCommand(
      ["list", "--fields", "labels,milestone"],
      ctx,
    );
    expect(out).toContain("labels");
    expect(out).toContain("milestone");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await issueCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("to open an issue");
  });
});

describe("issue view", () => {
  it("renders detail with labels, milestone and no help", async () => {
    api.mockResolvedValueOnce(sampleIssue);
    const out = await issueCommand(["view", "42"], ctx);
    expect(out).toContain("state: opened");
    expect(out).toContain('labels: "bug,ui"');
    expect(out).toContain("milestone: v1.0");
    expect(out).not.toContain("help[");
  });

  it("fetches and filters system notes when --comments", async () => {
    api.mockResolvedValueOnce(sampleIssue);
    api.mockResolvedValueOnce([
      {
        author: { username: "bob" },
        created_at: "2026-06-22T10:00:00Z",
        body: "Real comment",
        system: false,
      },
      {
        author: { username: "system" },
        created_at: "2026-06-22T11:00:00Z",
        body: "changed state",
        system: true,
      },
    ]);
    const out = await issueCommand(["view", "42", "--comments"], ctx);
    expect(out).toContain("comments[1]");
    expect(out).toContain("Real comment");
    expect(out).not.toContain("changed state");
  });
});

describe("issue create", () => {
  it("requires --title", async () => {
    await expect(issueCommand(["create", "--body", "x"], ctx)).rejects.toThrow(
      /--title is required/,
    );
  });

  it("posts title and description", async () => {
    api.mockResolvedValueOnce({ ...sampleIssue, iid: 99 });
    const out = await issueCommand(
      ["create", "--title", "New bug", "--body", "details"],
      ctx,
    );
    const call = api.mock.calls[0];
    expect(call[0]).toContain("/issues");
    const fields = (call[1] as { fields: Record<string, unknown> }).fields;
    expect(fields.title).toBe("New bug");
    expect(fields.description).toBe("details");
    expect(out).toContain("created");
  });
});

describe("issue close", () => {
  it("is idempotent when already closed", async () => {
    api.mockResolvedValueOnce({ ...sampleIssue, state: "closed" });
    const out = await issueCommand(["close", "42"], ctx);
    expect(out).toContain("Already closed");
    expect(api).toHaveBeenCalledTimes(1); // no PUT issued
  });

  it("closes an open issue", async () => {
    api.mockResolvedValueOnce({ ...sampleIssue, state: "opened" }); // current
    api.mockResolvedValueOnce({ ...sampleIssue, state: "closed" }); // put result
    const out = await issueCommand(["close", "42"], ctx);
    const putCall = api.mock.calls[1];
    expect(
      (putCall[1] as { fields: Record<string, unknown> }).fields.state_event,
    ).toBe("close");
    expect(out).toContain("state: closed");
  });
});

describe("issue reopen", () => {
  it("is idempotent when already open", async () => {
    api.mockResolvedValueOnce({ ...sampleIssue, state: "opened" });
    const out = await issueCommand(["reopen", "42"], ctx);
    expect(out).toContain("Already open");
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe("issue comment", () => {
  it("requires a body", async () => {
    await expect(issueCommand(["comment", "42"], ctx)).rejects.toThrow(
      /body is required/,
    );
  });

  it("posts a note", async () => {
    api.mockResolvedValueOnce({
      author: { username: "alice" },
      created_at: "2026-06-24T10:00:00Z",
      body: "On it",
    });
    const out = await issueCommand(["comment", "42", "--body", "On it"], ctx);
    const call = api.mock.calls[0];
    expect(call[0]).toContain("/issues/42/notes");
    expect(out).toContain("On it");
  });
});
