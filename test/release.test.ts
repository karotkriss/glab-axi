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

import { releaseCommand, RELEASE_HELP } from "../src/commands/release.js";
import { glApi, glApiResult } from "../src/gl.js";
import { AxiError } from "../src/errors.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

beforeEach(() => {
  glApiMock.mockReset();
  glApiResultMock.mockReset();
});

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.0.0",
    name: "Release 1.0.0",
    description: "Release notes body",
    created_at: "2024-01-01T00:00:00Z",
    released_at: "2024-01-02T00:00:00Z",
    author: { username: "alice" },
    commit: { short_id: "abc1234" },
    assets: { count: 3, sources: [], links: [] },
    ...overrides,
  };
}

describe("release list", () => {
  it("requests releases and renders a TOON list with a count", async () => {
    glApiMock.mockResolvedValueOnce([
      release(),
      release({ tag_name: "v0.9.0" }),
    ]);
    const out = await releaseCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/releases`);
    expect(path).toContain("per_page=30");
    expect(out).toContain("count: 2");
    expect(out).toContain("releases[2]");
    expect(out).toContain("alice");
  });

  it("honors a numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([release()]);
    await releaseCommand(["list", "--limit", "5"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=5");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await releaseCommand(["list"], ctx);
    expect(out).toContain("0 releases found");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await releaseCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=30");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });
});

describe("release view", () => {
  it("GETs the encoded tag path and truncates by default", async () => {
    glApiMock.mockResolvedValueOnce(release());
    const out = await releaseCommand(["view", "v1.0.0"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/releases/${encodeURIComponent("v1.0.0")}`,
    );
    expect(out).toContain("release");
    expect(out).toContain("Release notes body");
  });

  it("encodes tags with special characters", async () => {
    glApiMock.mockResolvedValueOnce(release({ tag_name: "release/1.0" }));
    await releaseCommand(["view", "release/1.0"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/releases/${encodeURIComponent("release/1.0")}`,
    );
  });

  it("--full shows the complete description while default truncates", async () => {
    const longBody = "x".repeat(900);
    glApiMock.mockResolvedValueOnce(release({ description: longBody }));
    const full = await releaseCommand(["view", "v1.0.0", "--full"], ctx);
    expect(full).toContain("x".repeat(900));

    glApiMock.mockResolvedValueOnce(release({ description: longBody }));
    const def = await releaseCommand(["view", "v1.0.0"], ctx);
    expect(def).toContain("truncated");
    expect(def).not.toContain("x".repeat(900));
  });

  it("surfaces the assets count", async () => {
    glApiMock.mockResolvedValueOnce(release({ assets: { count: 7 } }));
    const out = await releaseCommand(["view", "v1.0.0"], ctx);
    expect(out).toContain("assets: 7");
  });
});

describe("release create", () => {
  it("requires the tag positional", async () => {
    await expect(
      releaseCommand(["create", "--name", "x"], ctx),
    ).rejects.toThrow("Missing release tag");
  });

  it("sends tag_name, name, and description as rawFields", async () => {
    glApiMock.mockResolvedValueOnce(release());
    await releaseCommand(
      ["create", "v1.0.0", "--name", "Release 1.0.0", "--body", "Notes here"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/releases`);
    expect(call[1].method).toBe("POST");
    expect(call[1].rawFields).toContain("tag_name=v1.0.0");
    expect(call[1].rawFields).toContain("name=Release 1.0.0");
    expect(call[1].rawFields).toContain("description=Notes here");
  });

  it("includes ref when --ref is provided", async () => {
    glApiMock.mockResolvedValueOnce(release());
    await releaseCommand(["create", "v2.0.0", "--ref", "main"], ctx);
    expect(glApiMock.mock.calls[0][1].rawFields).toContain("ref=main");
  });

  it("is idempotent: an existing tag (409) becomes a no-op", async () => {
    glApiMock.mockRejectedValueOnce(
      new AxiError("Release already exists", "CONFLICT"),
    );
    const out = await releaseCommand(["create", "v1.0.0"], ctx);
    expect(out).toContain("already: true");
  });
});

describe("release delete", () => {
  it("GETs then DELETEs the encoded tag path on success", async () => {
    // GET existence check (release present), then the DELETE.
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ tag_name: "v1.0.0" }),
    });
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    const out = await releaseCommand(["delete", "v1.0.0"], ctx);
    const encoded = `projects/${PID}/releases/${encodeURIComponent("v1.0.0")}`;
    expect(glApiResultMock.mock.calls[0][0]).toBe(encoded); // GET
    expect(glApiResultMock.mock.calls[1][0]).toBe(encoded); // DELETE
    expect(glApiResultMock.mock.calls[1][1].method).toBe("DELETE");
    expect(out).toContain("status: ok");
  });

  it("is idempotent: a missing release (404 on GET) becomes a no-op", async () => {
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "404 Not Found",
      stdout: "",
    });
    const out = await releaseCommand(["delete", "v9.9.9"], ctx);
    expect(out).toContain("already_absent: true");
    // Only the GET ran — no DELETE attempted.
    expect(glApiResultMock.mock.calls.length).toBe(1);
  });

  it("throws on non-404 lookup failures", async () => {
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "500 Internal Server Error",
      stdout: "",
    });
    await expect(releaseCommand(["delete", "v1.0.0"], ctx)).rejects.toThrow();
  });
});

describe("release router", () => {
  it("returns help for no subcommand", async () => {
    const out = await releaseCommand([], ctx);
    expect(out).toBe(RELEASE_HELP);
    expect(out).toContain("usage: glab-axi release");
  });

  it("errors on unknown subcommand", async () => {
    const out = await releaseCommand(["bogus"], ctx);
    expect(out).toContain("Unknown release subcommand");
  });
});
