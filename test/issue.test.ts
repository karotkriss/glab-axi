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

import { issueCommand } from "../src/commands/issue.js";
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

function issue(overrides: Record<string, unknown> = {}) {
  return {
    iid: 42,
    title: "Fix the bug",
    state: "opened",
    author: { username: "alice" },
    labels: ["bug", "p1"],
    milestone: { title: "v1.0" },
    assignees: [{ username: "bob" }],
    user_notes_count: 3,
    description: "Issue body",
    web_url: "https://gitlab.example.com/group/project/-/issues/42",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    ...overrides,
  };
}

describe("issue list", () => {
  it("requests opened issues and renders a TOON list with a count", async () => {
    glApiMock.mockResolvedValueOnce([
      issue(),
      issue({ iid: 43, title: "Second" }),
    ]);
    const out = await issueCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/issues`);
    expect(path).toContain("state=opened");
    expect(path).toContain("per_page=30");
    expect(path).toContain("order_by=updated_at");
    expect(out).toContain("count: 2");
    expect(out).toContain("issues[2]");
    expect(out).toContain("alice");
    expect(out).toContain("bug");
  });

  it("maps --state open to opened and all drops the filter", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await issueCommand(["list", "--state", "all"], ctx);
    expect(glApiMock.mock.calls[0][0]).not.toContain("state=");
  });

  it("passes label/author/assignee filters", async () => {
    glApiMock.mockResolvedValueOnce([issue()]);
    await issueCommand(
      ["list", "--label", "bug", "--author", "alice", "--assignee", "bob"],
      ctx,
    );
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("labels=bug");
    expect(path).toContain("author_username=alice");
    expect(path).toContain("assignee_username=bob");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await issueCommand(["list"], ctx);
    expect(out).toContain("0 matching issues");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await issueCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=30");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("supports --fields extras (url, assignees)", async () => {
    glApiMock.mockResolvedValueOnce([issue()]);
    const out = await issueCommand(["list", "--fields", "url,assignees"], ctx);
    expect(out).toContain("url");
    expect(out).toContain("bob");
  });
});

describe("issue view", () => {
  it("renders default detail with truncated body and comment hint", async () => {
    glApiMock.mockResolvedValueOnce(issue());
    const out = await issueCommand(["view", "42"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}/issues/42`);
    expect(out).toContain("issue");
    expect(out).toContain("use --comments to read them");
    expect(out).toContain("v1.0");
  });

  it("--comments fetches notes and filters system notes", async () => {
    glApiMock.mockResolvedValueOnce(issue());
    glApiMock.mockResolvedValueOnce([
      {
        author: { username: "bob" },
        body: "looks good",
        created_at: "x",
        system: false,
      },
      {
        author: { username: "sysbot" },
        body: "changed state",
        created_at: "y",
        system: true,
      },
    ]);
    const out = await issueCommand(["view", "42", "--comments"], ctx);
    expect(glApiMock.mock.calls[1][0]).toContain("/notes");
    expect(glApiMock.mock.calls[1][0]).toContain("sort=asc");
    expect(out).toContain("bob");
    expect(out).not.toContain("sysbot");
  });
});

describe("issue create", () => {
  it("requires --title", async () => {
    await expect(issueCommand(["create", "--body", "x"], ctx)).rejects.toThrow(
      "--title is required",
    );
  });

  it("POSTs title/description as rawFields", async () => {
    glApiMock.mockResolvedValueOnce(issue({ iid: 7 }));
    await issueCommand(
      ["create", "--title", "T", "--body", "B", "--label", "bug"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/issues`);
    expect(call[1].method).toBe("POST");
    expect(call[1].rawFields).toContain("title=T");
    expect(call[1].rawFields).toContain("description=B");
    expect(call[1].rawFields).toContain("labels=bug");
  });

  it("--confidential adds a typed field", async () => {
    glApiMock.mockResolvedValueOnce(issue({ iid: 7 }));
    await issueCommand(["create", "--title", "T", "--confidential"], ctx);
    expect(glApiMock.mock.calls[0][1].fields).toContain("confidential=true");
  });

  it("resolves --milestone and --assignee to ids", async () => {
    glApiMock.mockResolvedValueOnce([{ id: 11 }]); // resolveUserId
    glApiMock.mockResolvedValueOnce([{ id: 5 }]); // resolveMilestoneId
    glApiMock.mockResolvedValueOnce(issue({ iid: 7 })); // create POST
    await issueCommand(
      ["create", "--title", "T", "--assignee", "carol", "--milestone", "v1.0"],
      ctx,
    );
    const createCall = glApiMock.mock.calls[2];
    expect(createCall[1].fields).toContain("assignee_ids=11");
    expect(createCall[1].fields).toContain("milestone_id=5");
  });
});

describe("issue edit", () => {
  it("PUTs changed fields", async () => {
    glApiMock.mockResolvedValueOnce(issue({ title: "New title" }));
    await issueCommand(
      ["edit", "42", "--title", "New title", "--label", "p2"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/issues/42`);
    expect(call[1].method).toBe("PUT");
    expect(call[1].rawFields).toContain("title=New title");
    expect(call[1].rawFields).toContain("labels=p2");
  });

  it("requires at least one update flag", async () => {
    await expect(issueCommand(["edit", "42"], ctx)).rejects.toThrow(
      "No update flags",
    );
  });
});

describe("issue close / reopen", () => {
  it("closes an opened issue with state_event=close", async () => {
    glApiMock.mockResolvedValueOnce(issue({ state: "opened" })); // GET
    glApiMock.mockResolvedValueOnce(issue({ state: "closed" })); // PUT
    await issueCommand(["close", "42"], ctx);
    expect(glApiMock.mock.calls[1][1].fields).toContain("state_event=close");
  });

  it("is a no-op when already closed (only one glApi call)", async () => {
    glApiMock.mockResolvedValueOnce(issue({ state: "closed" }));
    const out = await issueCommand(["close", "42"], ctx);
    expect(out).toContain("already: true");
    expect(glApiMock.mock.calls.length).toBe(1);
  });

  it("reopens a closed issue with state_event=reopen", async () => {
    glApiMock.mockResolvedValueOnce(issue({ state: "closed" })); // GET
    glApiMock.mockResolvedValueOnce(issue({ state: "opened" })); // PUT
    await issueCommand(["reopen", "42"], ctx);
    expect(glApiMock.mock.calls[1][1].fields).toContain("state_event=reopen");
  });

  it("reopen is a no-op when already opened (only one glApi call)", async () => {
    glApiMock.mockResolvedValueOnce(issue({ state: "opened" }));
    const out = await issueCommand(["reopen", "42"], ctx);
    expect(out).toContain("already: true");
    expect(glApiMock.mock.calls.length).toBe(1);
  });
});

describe("issue comment", () => {
  it("requires a body", async () => {
    await expect(issueCommand(["comment", "42"], ctx)).rejects.toThrow(
      "is required",
    );
  });

  it("POSTs a note", async () => {
    glApiMock.mockResolvedValueOnce({});
    await issueCommand(["comment", "42", "--body", "hi"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("/notes");
    expect(glApiMock.mock.calls[0][1].rawFields).toContain("body=hi");
  });
});

describe("issue router", () => {
  it("returns help for no subcommand", async () => {
    const out = await issueCommand([], ctx);
    expect(out).toContain("usage: glab-axi issue");
  });

  it("errors on unknown subcommand", async () => {
    const out = await issueCommand(["bogus"], ctx);
    expect(out).toContain("Unknown issue subcommand");
  });
});
