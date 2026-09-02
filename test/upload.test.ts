import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  const glApi = vi.fn();
  return {
    glApi,
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { uploadCommand } from "../src/commands/upload.js";
import { glApi } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

let dir: string;
beforeEach(() => {
  glApiMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), "glab-axi-upload-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const uploadResponse = {
  id: 7240,
  alt: "evidence",
  url: "/uploads/abc123/evidence.png",
  markdown: "![evidence](/uploads/abc123/evidence.png)",
};

describe("upload", () => {
  it("documents that retrying stores another copy", async () => {
    const out = await uploadCommand(["--help"], ctx);
    expect(out).toContain("Retrying upload stores a new copy");
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("sends a multipart file part and returns the embed markdown, url, and alt", async () => {
    glApiMock.mockResolvedValueOnce(uploadResponse);
    // A byte sequence that would be corrupted by a lossy UTF-8 decode.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const file = join(dir, "evidence.png");
    writeFileSync(file, bytes);

    const out = await uploadCommand([file], ctx);

    const [path, opts] = glApiMock.mock.calls[0];
    expect(path).toBe(`projects/${PID}/uploads`);
    expect(opts.method).toBe("POST");
    // A real multipart/form-data body, not a form field.
    expect(opts.body.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body: Buffer = opts.body.content;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString("latin1")).toContain(
      'name="file"; filename="evidence.png"',
    );
    // The raw bytes survive intact (binary-safe).
    expect(body.includes(bytes)).toBe(true);

    expect(out).toContain("![evidence](/uploads/abc123/evidence.png)");
    expect(out).toContain("url: /uploads/abc123/evidence.png");
    expect(out).toContain("alt: evidence");
  });

  it("uses --name to override the stored filename", async () => {
    glApiMock.mockResolvedValueOnce(uploadResponse);
    const file = join(dir, "local-name.png");
    writeFileSync(file, Buffer.from([1, 2, 3]));

    await uploadCommand([file, "--name", "failure-before.png"], ctx);

    const body: Buffer = glApiMock.mock.calls[0][1].body.content;
    expect(body.toString("latin1")).toContain('filename="failure-before.png"');
  });

  it("rejects --name without a value before uploading", async () => {
    const file = join(dir, "local-name.png");
    writeFileSync(file, Buffer.from([1, 2, 3]));
    await expect(uploadCommand([file, "--name"], ctx)).rejects.toThrow(
      /Missing value for `--name`/,
    );
    await expect(
      uploadCommand([file, "--name", "--bogus"], ctx),
    ).rejects.toThrow(/Missing value for `--name`/);
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("errors on a missing file rather than uploading nothing", async () => {
    await expect(uploadCommand([join(dir, "nope.png")], ctx)).rejects.toThrow(
      /File not found/,
    );
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("requires --name when reading from stdin", async () => {
    await expect(uploadCommand(["-"], ctx)).rejects.toThrow(
      /--name is required when reading the upload from stdin/,
    );
  });

  it("rejects an unknown flag rather than silently ignoring it (clause 6)", async () => {
    const file = join(dir, "x.png");
    writeFileSync(file, Buffer.from([1]));
    await expect(uploadCommand([file, "--bogus"], ctx)).rejects.toThrow(
      /Unknown flag/,
    );
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("requires a resolved project", async () => {
    const file = join(dir, "x.png");
    writeFileSync(file, Buffer.from([1]));
    await expect(uploadCommand([file], undefined)).rejects.toThrow();
  });
});
