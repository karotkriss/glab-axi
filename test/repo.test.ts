import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Mock stdin so the piped-content fallback is deterministic and never reads fd 0.
vi.mock("../src/stdin.js", () => ({ readStdin: vi.fn(() => "") }));

import { repoCommand, REPO_HELP } from "../src/commands/repo.js";
import { glApi, glApiResult } from "../src/gl.js";
import { readStdin } from "../src/stdin.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const readStdinMock = readStdin as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");
const NOT_FOUND = { stdout: "", stderr: "HTTP 404 Not Found", exitCode: 22 };
const FOUND = { stdout: "{}", stderr: "", exitCode: 0 };

beforeEach(() => {
  glApiMock.mockReset();
  glApiResultMock.mockReset();
  readStdinMock.mockReset();
  readStdinMock.mockReturnValue("");
});

/** GET /projects/:id - the default-branch lookup behind --branch/--ref. */
function projectWithDefaultBranch(branch: string | null = "main") {
  return {
    id: 1,
    path_with_namespace: "group/project",
    default_branch: branch,
  };
}

describe("repo create-file", () => {
  it("requires a file path", async () => {
    await expect(
      repoCommand(["create-file", "--content", "hi"], ctx),
    ).rejects.toThrow("Missing file path");
  });

  it("requires content", async () => {
    await expect(
      repoCommand(["create-file", "README.md"], ctx),
    ).rejects.toThrow("File content is required");
  });

  it("rejects two content sources at once", async () => {
    await expect(
      repoCommand(
        ["create-file", "README.md", "--content", "hi", "--content-file", "f"],
        ctx,
      ),
    ).rejects.toThrow("Use only one content source");
  });

  it("POSTs the URL-encoded file path with branch, content, and message", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND); // GET-first
    glApiMock.mockResolvedValueOnce({
      file_path: "src/app.ts",
      branch: "feat",
    });

    const out = await repoCommand(
      [
        "create-file",
        "src/app.ts",
        "--branch",
        "feat",
        "--content",
        "export const a = 1;",
        "--message",
        "Add app",
      ],
      ctx,
    );

    const encoded = encodeURIComponent("src/app.ts");
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/repository/files/${encoded}`,
    );
    const opts = glApiMock.mock.calls[0][1];
    expect(opts.method).toBe("POST");
    expect(opts.rawFields).toContain("branch=feat");
    expect(opts.rawFields).toContain("content=export const a = 1;");
    expect(opts.rawFields).toContain("commit_message=Add app");
    expect(out).toContain("created");
    expect(out).toContain("file: src/app.ts");
    expect(out).toContain("branch: feat");
  });

  it("defaults the commit message to Add <path>", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ file_path: "README.md", branch: "feat" });

    await repoCommand(
      ["create-file", "README.md", "--branch", "feat", "--content", "# hi"],
      ctx,
    );

    expect(glApiMock.mock.calls[0][1].rawFields).toContain(
      "commit_message=Add README.md",
    );
  });

  it("defaults --branch to the project's default branch", async () => {
    glApiMock.mockResolvedValueOnce(projectWithDefaultBranch("trunk")); // GET /projects/:id
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({
      file_path: "README.md",
      branch: "trunk",
    });

    const out = await repoCommand(
      ["create-file", "README.md", "--content", "# hi"],
      ctx,
    );

    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}`);
    expect(glApiResultMock.mock.calls[0][0]).toContain("ref=trunk");
    expect(glApiMock.mock.calls[1][1].rawFields).toContain("branch=trunk");
    expect(out).toContain("branch: trunk");
  });

  it("asks for --branch when the repository is empty", async () => {
    glApiMock.mockResolvedValueOnce(projectWithDefaultBranch(null));
    await expect(
      repoCommand(["create-file", "README.md", "--content", "# hi"], ctx),
    ).rejects.toThrow("no default branch");
  });

  it("reads content from stdin when no content flag is given", async () => {
    readStdinMock.mockReturnValue("piped body\n");
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ file_path: "a.txt", branch: "feat" });

    await repoCommand(["create-file", "a.txt", "--branch", "feat"], ctx);

    // The trailing newline belongs to the file and is preserved.
    expect(glApiMock.mock.calls[0][1].rawFields).toContain(
      "content=piped body\n",
    );
  });

  it("is a no-op when the file already exists on that branch (no POST)", async () => {
    glApiResultMock.mockResolvedValueOnce(FOUND);

    const out = await repoCommand(
      ["create-file", "README.md", "--branch", "feat", "--content", "# hi"],
      ctx,
    );

    const encoded = encodeURIComponent("README.md");
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/repository/files/${encoded}?ref=feat`,
    );
    expect(out).toContain("already: true");
    expect(out).toContain("file: README.md");
    expect(glApiMock.mock.calls.length).toBe(0);
  });

  it("suggests branching and checking the triggered pipeline", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ file_path: "README.md", branch: "feat" });

    const out = await repoCommand(
      ["create-file", "README.md", "--branch", "feat", "--content", "# hi"],
      ctx,
    );

    expect(out).toContain("repo create-branch <name> --ref feat");
    expect(out).toContain("ci list --ref feat");
    expect(out).toContain("-R gitlab.example.com/group/project");
  });

  it("throws an actionable error when the project is unresolved", async () => {
    await expect(
      repoCommand(["create-file", "README.md", "--content", "# hi"]),
    ).rejects.toThrow("Could not determine the target GitLab project");
  });

  it("passes binary-rejection options through to readStdin", async () => {
    readStdinMock.mockReturnValue("piped body\n");
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ file_path: "a.txt", branch: "feat" });

    await repoCommand(["create-file", "a.txt", "--branch", "feat"], ctx);

    expect(readStdinMock.mock.calls[0][0]).toMatchObject({
      rejectBinaryMessage: expect.stringContaining(
        "Binary content is not supported",
      ),
    });
  });
});

describe("repo create-file binary content rejection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-axi-repo-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a --content-file containing invalid UTF-8 bytes", async () => {
    const filePath = join(dir, "binary.dat");
    writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    await expect(
      repoCommand(
        [
          "create-file",
          "binary.dat",
          "--branch",
          "feat",
          "--content-file",
          filePath,
        ],
        ctx,
      ),
    ).rejects.toThrow("Binary content is not supported");
    expect(glApiMock.mock.calls.length).toBe(0);
  });

  it("accepts a --content-file that legitimately contains a U+FFFD character", async () => {
    const filePath = join(dir, "replacement-char.txt");
    writeFileSync(filePath, Buffer.from("hello � world", "utf8"));
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({
      file_path: "replacement-char.txt",
      branch: "feat",
    });

    const out = await repoCommand(
      [
        "create-file",
        "replacement-char.txt",
        "--branch",
        "feat",
        "--content-file",
        filePath,
      ],
      ctx,
    );

    expect(out).toContain("created");
    expect(glApiMock.mock.calls[0][1].rawFields).toContain(
      "content=hello � world",
    );
  });
});

describe("repo create-branch", () => {
  it("requires a branch name", async () => {
    await expect(repoCommand(["create-branch"], ctx)).rejects.toThrow(
      "Missing branch name",
    );
  });

  it("POSTs branch and ref, and reports the head commit", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND); // GET-first
    glApiMock.mockResolvedValueOnce({
      name: "feature-x",
      commit: { id: "abc123def456", short_id: "abc123d" },
    });

    const out = await repoCommand(
      ["create-branch", "feature-x", "--ref", "main"],
      ctx,
    );

    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/repository/branches`,
    );
    const opts = glApiMock.mock.calls[0][1];
    expect(opts.method).toBe("POST");
    expect(opts.rawFields).toEqual(["branch=feature-x", "ref=main"]);
    expect(out).toContain("created");
    expect(out).toContain("branch: feature-x");
    expect(out).toContain("ref: main");
    expect(out).toContain("commit: abc123d");
  });

  it("defaults --ref to the project's default branch", async () => {
    glApiMock.mockResolvedValueOnce(projectWithDefaultBranch("trunk"));
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ name: "feature-x", commit: {} });

    const out = await repoCommand(["create-branch", "feature-x"], ctx);

    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}`);
    expect(glApiMock.mock.calls[1][1].rawFields).toContain("ref=trunk");
    expect(out).toContain("ref: trunk");
  });

  it("points at seeding a file when the repository is empty", async () => {
    glApiMock.mockResolvedValueOnce(projectWithDefaultBranch(null));
    await expect(
      repoCommand(["create-branch", "feature-x"], ctx),
    ).rejects.toThrow("no default branch");
  });

  it("URL-encodes the branch name in the existence check", async () => {
    glApiResultMock.mockResolvedValueOnce(FOUND);
    await repoCommand(["create-branch", "feat/x", "--ref", "main"], ctx);
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/repository/branches/${encodeURIComponent("feat/x")}`,
    );
  });

  it("is a no-op when the branch already exists (no POST)", async () => {
    glApiResultMock.mockResolvedValueOnce(FOUND);

    const out = await repoCommand(
      ["create-branch", "feature-x", "--ref", "main"],
      ctx,
    );

    expect(out).toContain("already: true");
    expect(out).toContain("branch: feature-x");
    expect(glApiMock.mock.calls.length).toBe(0);
  });

  it("suggests adding a file and opening a merge request", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce({ name: "feature-x", commit: {} });

    const out = await repoCommand(
      ["create-branch", "feature-x", "--ref", "main"],
      ctx,
    );

    expect(out).toContain("repo create-file <path> --branch feature-x");
    expect(out).toContain("mr create --source-branch feature-x");
  });
});

describe("repo router", () => {
  it("returns help for no subcommand", async () => {
    const out = await repoCommand([], ctx);
    expect(out).toBe(REPO_HELP);
    expect(out).toContain("usage: glab-axi repo");
  });

  it("errors on an unknown subcommand", async () => {
    const out = await repoCommand(["bogus"], ctx);
    expect(out).toContain("Unknown repo subcommand");
  });
});
