import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoContext } from "../src/context.js";
import { AxiError } from "../src/errors.js";

// Mock the glab executor so tests never shell out. projectId is kept real-ish.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glExec: vi.fn(),
  glRaw: vi.fn(),
  projectId: (ctx: RepoContext) => encodeURIComponent(ctx.project),
}));

import { glApi } from "../src/gl.js";
import { releaseCommand } from "../src/commands/release.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const sampleRelease = {
  tag_name: "v1.2.0",
  name: "1.2.0",
  description: "Initial stable release.",
  released_at: "2024-01-01T00:00:00.000Z",
  created_at: "2024-01-01T00:00:00.000Z",
  author: { username: "alice" },
  commit: { short_id: "abc1234" },
  _links: { self: "https://dev.egov.gy/group/proj/-/releases/v1.2.0" },
};

describe("release list", () => {
  it("renders list TOON with count and help", async () => {
    api.mockResolvedValueOnce([sampleRelease]);
    const out = await releaseCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("releases[1]{tag,name,released_at,author}:");
    expect(out).toContain("v1.2.0,1.2.0,");
    expect(out).toContain("alice");
    expect(out).toContain("help[1]:");
  });

  it("passes --limit to per_page", async () => {
    api.mockResolvedValueOnce([sampleRelease]);
    await releaseCommand(["list", "--limit", "5"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("per_page=5");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await releaseCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("to publish a release");
  });
});

describe("release view", () => {
  it("renders a detail with truncated description and no help noise", async () => {
    const longBody = "x".repeat(1500);
    api.mockResolvedValueOnce({ ...sampleRelease, description: longBody });
    const out = await releaseCommand(["view", "v1.2.0"], ctx);
    expect(out).toContain("release:");
    expect(out).toContain("tag: v1.2.0");
    expect(out).toContain("commit: abc1234");
    expect(out).toContain("truncated");
    expect(out).not.toContain("help[");
    // URL-encoded tag in the API path.
    expect(api.mock.calls[0][0]).toContain("releases/v1.2.0");
  });

  it("--full leaves the description untruncated", async () => {
    const longBody = "y".repeat(1500);
    api.mockResolvedValueOnce({ ...sampleRelease, description: longBody });
    const out = await releaseCommand(["view", "v1.2.0", "--full"], ctx);
    expect(out).not.toContain("truncated");
  });
});

describe("release create", () => {
  it("requires a <tag> positional", async () => {
    await expect(releaseCommand(["create"], ctx)).rejects.toThrow(
      /release tag is required/,
    );
  });

  it("posts tag_name and notes as description", async () => {
    api.mockResolvedValueOnce(sampleRelease);
    await releaseCommand(
      ["create", "v1.2.0", "--name", "1.2.0", "--notes", "Hello"],
      ctx,
    );
    const call = api.mock.calls[0];
    expect(
      (call[1] as { fields: Record<string, unknown> }).fields.tag_name,
    ).toBe("v1.2.0");
    expect(
      (call[1] as { fields: Record<string, unknown> }).fields.description,
    ).toBe("Hello");
  });
});

describe("release delete", () => {
  it("requires a <tag> positional", async () => {
    await expect(releaseCommand(["delete"], ctx)).rejects.toThrow(
      /release tag is required/,
    );
  });

  it("is idempotent on a 404 (NOT_FOUND) - already-deleted no-op", async () => {
    api.mockRejectedValueOnce(
      new AxiError("Resource not found in this project", "NOT_FOUND"),
    );
    const out = await releaseCommand(["delete", "v9.9.9"], ctx);
    expect(out).toContain("deleted:");
    expect(out).toContain("already deleted");
  });

  it("reports ok on a successful delete", async () => {
    api.mockResolvedValueOnce(undefined);
    const out = await releaseCommand(["delete", "v1.2.0"], ctx);
    expect(out).toContain("status: ok");
    const call = api.mock.calls[0];
    expect((call[1] as { method: string }).method).toBe("DELETE");
  });
});
