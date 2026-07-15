import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  const glApi = vi.fn();
  return {
    glApi,
    // `glApiList` is `glApi` plus GitLab's X-Total header. Delegate so the path
    // and rendering assertions below stay meaningful, and override it per-test
    // to exercise the total. Real header parsing is covered in gl.test.ts.
    glApiList: vi.fn(async (path: string, opts?: unknown) => ({
      data: (await glApi(path, opts)) ?? [],
      total: null,
    })),
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

  it("maps --target onto ref (gh-axi flag parity)", async () => {
    glApiMock.mockResolvedValueOnce(release());
    await releaseCommand(
      ["create", "v2.0.0", "--target", "release-branch"],
      ctx,
    );
    expect(glApiMock.mock.calls[0][1].rawFields).toContain(
      "ref=release-branch",
    );
  });

  it("prefers --target over --ref when both are given", async () => {
    glApiMock.mockResolvedValueOnce(release());
    await releaseCommand(
      ["create", "v2.0.0", "--ref", "main", "--target", "hotfix"],
      ctx,
    );
    const rawFields = glApiMock.mock.calls[0][1].rawFields as string[];
    expect(rawFields).toContain("ref=hotfix");
    expect(rawFields).not.toContain("ref=main");
  });

  it("--prerelease dates the release in the future so it is upcoming", async () => {
    glApiMock.mockResolvedValueOnce(release());
    const out = await releaseCommand(
      ["create", "v2.0.0-rc1", "--prerelease"],
      ctx,
    );
    const rawFields = glApiMock.mock.calls[0][1].rawFields as string[];
    const releasedAt = rawFields.find((f) => f.startsWith("released_at="));
    expect(releasedAt).toBeDefined();
    // Whatever sentinel is used, it must resolve to a future timestamp.
    expect(
      new Date(releasedAt!.slice("released_at=".length)).getTime(),
    ).toBeGreaterThan(Date.now());
    expect(out).toContain("upcoming: true");
  });

  it("attaches --asset values as GitLab asset links (name then url)", async () => {
    glApiMock.mockResolvedValueOnce(release());
    const out = await releaseCommand(
      [
        "create",
        "v2.0.0",
        "--asset",
        "https://host/dl/app.zip#App bundle",
        "--asset",
        "https://host/dl/checksums.txt",
      ],
      ctx,
    );
    const rawFields = glApiMock.mock.calls[0][1].rawFields as string[];
    // Explicit #name is used verbatim.
    expect(rawFields).toContain("assets[links][][name]=App bundle");
    expect(rawFields).toContain("assets[links][][url]=https://host/dl/app.zip");
    // No #name -> name derived from the URL's last path segment.
    expect(rawFields).toContain("assets[links][][name]=checksums.txt");
    expect(rawFields).toContain(
      "assets[links][][url]=https://host/dl/checksums.txt",
    );
    // name must precede its paired url so GitLab groups them into one link.
    const firstName = rawFields.indexOf("assets[links][][name]=App bundle");
    const firstUrl = rawFields.indexOf(
      "assets[links][][url]=https://host/dl/app.zip",
    );
    expect(firstName).toBeLessThan(firstUrl);
    expect(out).toContain("assets: 2");
  });

  it("resolves the tag correctly when --asset precedes it", async () => {
    glApiMock.mockResolvedValueOnce(release());
    const out = await releaseCommand(
      ["create", "--asset", "https://host/dl/app.zip", "v1.0.0"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[1].rawFields).toContain("tag_name=v1.0.0");
    expect(call[1].rawFields).not.toContain("tag_name=https://host/dl/app.zip");
    const rawFields = call[1].rawFields as string[];
    expect(rawFields).toContain("assets[links][][url]=https://host/dl/app.zip");
    expect(out).toContain("tag: v1.0.0");
  });

  it("rejects an --asset with no URL", async () => {
    await expect(
      releaseCommand(["create", "v2.0.0", "--asset", "#just a name"], ctx),
    ).rejects.toThrow("--asset requires a URL");
  });

  it("is idempotent: an existing tag (409) becomes a no-op", async () => {
    glApiMock.mockRejectedValueOnce(
      new AxiError("Release already exists", "CONFLICT"),
    );
    const out = await releaseCommand(["create", "v1.0.0"], ctx);
    expect(out).toContain("already: true");
  });

  it("refuses --draft with a usage error (exit 2) and never calls the API", async () => {
    await expect(
      releaseCommand(["create", "v1.0.0", "--draft"], ctx),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR", // exitCodeForError -> 2
      message: expect.stringMatching(/draft/i),
    });
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("refuses --generate-notes with a usage error (exit 2) and never calls the API", async () => {
    await expect(
      releaseCommand(["create", "v1.0.0", "--generate-notes"], ctx),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/note-generation|auto-generate/i),
    });
    expect(glApiMock).not.toHaveBeenCalled();
  });
});

describe("release edit", () => {
  it("PUTs the changed fields to the tag's release", async () => {
    glApiMock.mockResolvedValueOnce({ tag_name: "v1.0.0", name: "One" });
    const out = await releaseCommand(
      ["edit", "v1.0.0", "--name", "One", "--body", "notes"],
      ctx,
    );
    const [path, opts] = glApiMock.mock.calls[0];
    expect(path).toBe(`projects/${PID}/releases/v1.0.0`);
    expect(opts.method).toBe("PUT");
    expect(opts.rawFields).toEqual(["name=One", "description=notes"]);
    expect(out).toContain("updated:");
  });

  it("maps --prerelease to a future released_at", async () => {
    glApiMock.mockResolvedValueOnce({ tag_name: "v2", name: null });
    const out = await releaseCommand(["edit", "v2", "--prerelease"], ctx);
    expect(glApiMock.mock.calls[0][1].rawFields).toEqual([
      "released_at=9999-01-01T00:00:00Z",
    ]);
    expect(out).toContain("upcoming");
  });

  it("refuses --draft on edit, like create", async () => {
    await expect(
      releaseCommand(["edit", "v1", "--draft"], ctx),
    ).rejects.toThrow("no draft state");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("refuses --generate-notes on edit, like create", async () => {
    await expect(
      releaseCommand(["edit", "v1", "--generate-notes"], ctx),
    ).rejects.toThrow("no note-generation concept");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("refuses an edit with nothing to change, before any API call", async () => {
    await expect(releaseCommand(["edit", "v1"], ctx)).rejects.toThrow(
      "Nothing to edit",
    );
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("requires a tag", async () => {
    await expect(releaseCommand(["edit", "--body", "x"], ctx)).rejects.toThrow(
      "Missing release tag",
    );
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
    // Only the GET ran - no DELETE attempted.
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
    await expect(releaseCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown release subcommand",
    );
  });
});
