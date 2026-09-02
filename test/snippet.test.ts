import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glRaw: vi.fn(),
}));

import { snippetCommand } from "../src/commands/snippet.js";
import { glApi, glRaw } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glRawMock = glRaw as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = { host: "gitlab.example.com", source: "flag" };

let dir: string;
beforeEach(() => {
  glApiMock.mockReset();
  glRawMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), "glab-axi-snippet-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
      "snippets/13/files/master/install.sh/raw",
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
    const f = join(dir, "install.sh");
    writeFileSync(f, "echo v2\n");

    await snippetCommand(
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
  });

  it("refuses to delete a file the snippet does not have", async () => {
    glApiMock.mockResolvedValueOnce(current);
    await expect(
      snippetCommand(["edit", "13", "--delete-file", "ghost.sh"], ctx),
    ).rejects.toThrow(/no file named ghost.sh to delete/);
  });

  it("errors when no change is provided", async () => {
    await expect(snippetCommand(["edit", "13"], ctx)).rejects.toThrow(
      "No changes provided",
    );
  });
});

describe("snippet router", () => {
  it("returns help for no subcommand", async () => {
    const out = await snippetCommand([], ctx);
    expect(out).toContain("usage: glab-axi snippet");
  });

  it("errors on an unknown subcommand", async () => {
    await expect(snippetCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown snippet subcommand",
    );
  });
});
