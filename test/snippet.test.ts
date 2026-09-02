import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glApiList: vi.fn(),
  glApiResult: vi.fn(),
  glRaw: vi.fn(),
  errorBody: (result: { stderr: string; stdout: string }) =>
    [result.stderr, result.stdout].filter(Boolean).join("\n"),
}));

import { snippetCommand } from "../src/commands/snippet.js";
import { glApi, glApiList, glApiResult, glRaw } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiListMock = glApiList as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const glRawMock = glRaw as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = { host: "gitlab.example.com", source: "flag" };

let dir: string;
beforeEach(() => {
  glApiMock.mockReset();
  glApiListMock.mockReset();
  glApiResultMock.mockReset();
  glRawMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), "glab-axi-snippet-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("snippet list", () => {
  it("keeps the selected host in its empty-state create command", async () => {
    glApiListMock.mockResolvedValueOnce({ data: [], total: 0 });
    const out = await snippetCommand(["list"], ctx);
    expect(out).toContain("--host gitlab.example.com");
  });

  it("reports the verified total when the first page is truncated", async () => {
    glApiListMock.mockResolvedValueOnce({
      data: Array.from({ length: 30 }, (_, index) => ({
        id: index + 1,
        title: `Snippet ${index + 1}`,
      })),
      total: 42,
    });
    const out = await snippetCommand(["list", "--limit", "30"], ctx);
    expect(glApiListMock).toHaveBeenCalledWith("snippets?per_page=30", { ctx });
    expect(out).toContain("count: 30 of 42 total");
    expect(out).toContain("--host gitlab.example.com");
  });
});

describe("snippet create", () => {
  it("sends the files[] array as a JSON body, not form fields", async () => {
    glApiMock.mockResolvedValueOnce({
      id: 25,
      title: "Installer",
      visibility: "private",
      web_url: "https://gitlab.example.com/-/snippets/25",
    });
    const f = join(dir, "install.sh");
    writeFileSync(f, "echo hi\n");

    const out = await snippetCommand(
      [
        "create",
        "--title",
        "Installer",
        "--file",
        `install.sh=@${f}`,
        "--file",
        "README.md=# Installer",
      ],
      ctx,
    );

    const [path, opts] = glApiMock.mock.calls[0];
    expect(path).toBe("snippets");
    expect(opts.method).toBe("POST");
    expect(opts.body.contentType).toBe("application/json");
    const payload = JSON.parse(opts.body.content);
    expect(payload.title).toBe("Installer");
    expect(payload.visibility).toBe("private");
    // A nested files[] array - the thing -f/-F cannot express.
    expect(payload.files).toEqual([
      { file_path: "install.sh", content: "echo hi\n" },
      { file_path: "README.md", content: "# Installer" },
    ]);
    expect(out).toContain("id: 25");
    expect(out).toContain("--host gitlab.example.com");
  });

  it("requires a title and at least one file", async () => {
    await expect(snippetCommand(["create"], ctx)).rejects.toThrow(
      "--title is required",
    );
    await expect(
      snippetCommand(["create", "--title", "T"], ctx),
    ).rejects.toThrow("At least one --file is required");
  });
});

describe("snippet view", () => {
  const snippet = {
    id: 13,
    title: "Installer",
    visibility: "public",
    files: [
      {
        path: "install.sh",
        raw_url:
          "https://gitlab.example.com/-/snippets/13/raw/master/install.sh",
      },
      {
        path: "README.md",
        raw_url:
          "https://gitlab.example.com/-/snippets/13/raw/master/README.md",
      },
    ],
    web_url: "https://gitlab.example.com/-/snippets/13",
  };

  it("lists the files without printing their content", async () => {
    glApiMock.mockResolvedValueOnce(snippet);
    const out = await snippetCommand(["view", "13"], ctx);
    expect(out).toContain("install.sh");
    expect(out).toContain("README.md");
    expect(out).toContain("--host gitlab.example.com");
    expect(glRawMock).not.toHaveBeenCalled();
  });

  it("--file prints one file's raw content, using the ref from its raw_url", async () => {
    glApiMock.mockResolvedValueOnce(snippet);
    glRawMock.mockResolvedValueOnce("echo hi\n");
    const out = await snippetCommand(
      ["view", "13", "--file", "install.sh"],
      ctx,
    );
    // ref 'master' is parsed out of the file's raw_url.
    expect(glRawMock.mock.calls[0][0]).toBe(
      "snippets/13/files/master/install.sh/raw?line_ending=raw",
    );
    expect(out).toContain("echo hi");
  });

  it("errors listing the available files when --file names an unknown file", async () => {
    glApiMock.mockResolvedValueOnce(snippet);
    await expect(
      snippetCommand(["view", "13", "--file", "missing.txt"], ctx),
    ).rejects.toThrow(/no file named missing.txt/);
  });
});

describe("snippet edit", () => {
  const current = {
    id: 13,
    files: [{ path: "install.sh" }, { path: "old.sh" }],
  };

  it("sets action=update for an existing file, create for a new one, delete for --delete-file", async () => {
    glApiMock.mockResolvedValueOnce(current); // GET current files
    glApiMock.mockResolvedValueOnce({ id: 13, title: "Installer" }); // PUT
    glRawMock.mockResolvedValueOnce("echo v1\n");
    const f = join(dir, "install.sh");
    writeFileSync(f, "echo v2\n");

    const out = await snippetCommand(
      [
        "edit",
        "13",
        "--file",
        `install.sh=@${f}`,
        "--file",
        "new.sh=echo new",
        "--delete-file",
        "old.sh",
      ],
      ctx,
    );

    const putOpts = glApiMock.mock.calls[1][1];
    const payload = JSON.parse(putOpts.body.content);
    expect(payload.files).toEqual([
      { action: "update", file_path: "install.sh", content: "echo v2\n" },
      { action: "create", file_path: "new.sh", content: "echo new" },
      { action: "delete", file_path: "old.sh" },
    ]);
    expect(out).toContain("--host gitlab.example.com");
  });

  it("skips the PUT when every requested change is already satisfied", async () => {
    glApiMock.mockResolvedValueOnce({
      id: 13,
      title: "Installer",
      description: "Notes",
      visibility: "private",
      files: [
        {
          path: "install.sh",
          raw_url:
            "https://gitlab.example.com/-/snippets/13/raw/master/install.sh",
        },
      ],
    });
    glRawMock.mockResolvedValueOnce("echo hi\n");
    const out = await snippetCommand(
      [
        "edit",
        "13",
        "--title",
        "Installer",
        "--description",
        "Notes",
        "--visibility",
        "private",
        "--file",
        "install.sh=echo hi\n",
        "--delete-file",
        "already-gone.sh",
      ],
      ctx,
    );
    expect(out).toContain("already: true");
    expect(glApiMock).toHaveBeenCalledTimes(1);
    expect(glRawMock).toHaveBeenCalledTimes(1);
  });

  it("preserves CRLF while comparing an unchanged file", async () => {
    glApiMock.mockResolvedValueOnce({
      id: 13,
      title: "Installer",
      visibility: "private",
      files: [
        {
          path: "install.sh",
          raw_url:
            "https://gitlab.example.com/-/snippets/13/raw/master/install.sh",
        },
      ],
    });
    glRawMock.mockResolvedValueOnce("echo one\r\necho two\r\n");
    const out = await snippetCommand(
      ["edit", "13", "--file", "install.sh=echo one\r\necho two\r\n"],
      ctx,
    );
    expect(out).toContain("already: true");
    expect(glApiMock).toHaveBeenCalledTimes(1);
    expect(glRawMock).toHaveBeenCalledWith(
      "snippets/13/files/master/install.sh/raw?line_ending=raw",
      { ctx },
    );
  });

  it("accepts an explicit empty description and clears it", async () => {
    glApiMock.mockResolvedValueOnce({
      id: 13,
      title: "Installer",
      description: "Old description",
      visibility: "private",
      files: [],
    });
    glApiMock.mockResolvedValueOnce({
      id: 13,
      title: "Installer",
      description: "",
      visibility: "private",
      files: [],
    });
    await snippetCommand(["edit", "13", "--description="], ctx);
    const payload = JSON.parse(glApiMock.mock.calls[1][1].body.content);
    expect(payload.description).toBe("");
  });

  it("errors when no change is provided", async () => {
    await expect(snippetCommand(["edit", "13"], ctx)).rejects.toThrow(
      "No changes provided",
    );
  });
});

describe("snippet delete", () => {
  it("keeps the selected host in its follow-up command", async () => {
    glApiResultMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const out = await snippetCommand(["delete", "13"], ctx);
    expect(out).toContain("--host gitlab.example.com");
    expect(glApiResultMock.mock.calls[0][0]).toBe("snippets/13");
    expect(glApiResultMock.mock.calls[1][1].method).toBe("DELETE");
  });

  it("reports an already-absent snippet as a successful no-op", async () => {
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "404 Not Found",
    });
    const out = await snippetCommand(["delete", "13"], ctx);
    expect(out).toContain("already_absent: true");
    expect(glApiResultMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a forbidden pre-delete lookup as FORBIDDEN", async () => {
    glApiResultMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "403 Forbidden",
    });
    const err = (await snippetCommand(["delete", "13"], ctx).catch(
      (error) => error,
    )) as { code: string };
    expect(err.code).toBe("FORBIDDEN");
    expect(glApiResultMock).toHaveBeenCalledTimes(1);
  });
});

describe("snippet router", () => {
  it("returns help for no subcommand", async () => {
    const out = await snippetCommand([], ctx);
    expect(out).toContain("usage: glab-axi snippet");
    expect(out).toContain("retrying create makes another new snippet");
  });

  it("errors on an unknown subcommand", async () => {
    await expect(snippetCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown snippet subcommand",
    );
  });
});
