import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  projectId: (ctx?: { project: string }) =>
    ctx ? encodeURIComponent(ctx.project) : "{project}",
}));

import { homeCommand } from "../src/commands/home.js";
import { glApi } from "../src/gl.js";
import { AxiError } from "../src/errors.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "git",
};

beforeEach(() => {
  glApiMock.mockReset();
});

function issue(iid: number) {
  return {
    iid,
    title: `Issue ${iid}`,
    state: "opened",
    author: { username: "someone" },
  };
}

describe("home dashboard", () => {
  it("reports counts it actually received", async () => {
    glApiMock.mockResolvedValueOnce([issue(1), issue(2)]);
    glApiMock.mockResolvedValueOnce([]);

    const out = await homeCommand([], ctx);

    expect(out).toContain("project: group/project");
    expect(out).toContain("issues[2]");
    expect(out).toContain("merge_requests: 0 open");
  });

  // The core of the bug: a genuine zero and an unanswerable question rendered
  // as the same string, so an agent could not tell them apart.
  it("distinguishes a true zero from a failed fetch", async () => {
    glApiMock.mockRejectedValueOnce(
      new AxiError("404 Project Not Found", "NOT_FOUND"),
    );
    glApiMock.mockResolvedValueOnce([]);

    const out = await homeCommand([], ctx);

    expect(out).toContain("issues: unavailable - 404 Project Not Found");
    expect(out).not.toContain("issues: 0 open");
    expect(out).toContain("merge_requests: 0 open");
  });

  it.each([
    [
      "auth",
      new AxiError(
        "GitLab authentication required for this host",
        "AUTH_REQUIRED",
      ),
    ],
    ["network", new Error("getaddrinfo ENOTFOUND gitlab.example.com")],
  ])("never renders a count when the %s fetch fails", async (_label, err) => {
    glApiMock.mockRejectedValue(err);

    const out = await homeCommand([], ctx);

    expect(out).not.toContain("0 open");
    expect(out).toContain("issues: unavailable");
    expect(out).toContain("merge_requests: unavailable");
  });

  it("scrubs the wrapped CLI's name out of a failure reason", async () => {
    glApiMock.mockRejectedValue(new AxiError("glab: exploded", "UNKNOWN"));

    const out = await homeCommand([], ctx);

    expect(out).not.toMatch(/\bglab\b(?!-axi)/);
  });

  // A non-GitLab remote resolves to no context at all. Nothing was asked of any
  // server, so the dashboard must claim nothing about one: no project, and no
  // confident 0/0.
  it("claims nothing when no project resolved", async () => {
    const out = await homeCommand([], undefined);

    expect(out).toContain("project: none");
    expect(out).not.toContain("0 open");
    expect(out).not.toContain("unavailable");
    expect(out).toContain("No GitLab project resolved here");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("offers the full-list hints only when a page looks full", async () => {
    glApiMock.mockResolvedValueOnce([issue(1), issue(2), issue(3)]);
    glApiMock.mockResolvedValueOnce([]);

    const out = await homeCommand([], ctx);

    expect(out).toContain("glab-axi issue list");
    expect(out).not.toContain("glab-axi mr list");
  });

  it("does not offer a full-list hint for a fetch that failed", async () => {
    glApiMock.mockRejectedValue(new AxiError("boom", "UNKNOWN"));

    const out = await homeCommand([], ctx);

    expect(out).not.toContain("glab-axi issue list");
  });
});
