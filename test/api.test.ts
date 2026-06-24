import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoContext } from "../src/context.js";

// Mock the glab executor so tests never shell out. projectId is kept real-ish.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glExec: vi.fn(),
  glRaw: vi.fn(),
  projectId: (ctx: RepoContext) => encodeURIComponent(ctx.project),
}));

import { glRaw } from "../src/gl.js";
import { apiCommand } from "../src/commands/api.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const raw = vi.mocked(glRaw);

beforeEach(() => raw.mockReset());

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("api passthrough", () => {
  it("defaults to GET and TOON-encodes a JSON object response", async () => {
    raw.mockResolvedValueOnce(
      ok(JSON.stringify({ version: "16.0", revision: "abc" })),
    );
    const out = await apiCommand(["version"], ctx);

    const argv = raw.mock.calls[0][0] as string[];
    expect(argv).toEqual(["api", "version"]);
    expect(out).toContain("result:");
    expect(out).toContain('version: "16.0"');
    expect(out).toContain("revision: abc");
  });

  it("encodes a JSON array response under result", async () => {
    raw.mockResolvedValueOnce(
      ok(
        JSON.stringify([
          { id: 1, status: "success" },
          { id: 2, status: "failed" },
        ]),
      ),
    );
    const out = await apiCommand(["projects/{project}/pipelines"], ctx);
    expect(out).toContain("result[2]");
    expect(out).toContain("1,success");
    expect(out).toContain("2,failed");
  });

  it("accepts an explicit POST and collects --field into form fields", async () => {
    raw.mockResolvedValueOnce(ok(JSON.stringify({ iid: 7, title: "Hi" })));
    await apiCommand(
      [
        "POST",
        "projects/{project}/issues",
        "--field",
        "title=Hi",
        "--field",
        "labels=bug",
      ],
      ctx,
    );

    const argv = raw.mock.calls[0][0] as string[];
    expect(argv).toContain("--method");
    expect(argv).toContain("POST");
    expect(argv).toContain("-f");
    expect(argv).toContain("title=Hi");
    expect(argv).toContain("labels=bug");
  });

  it("collects --field order-independently (flags before path)", async () => {
    raw.mockResolvedValueOnce(ok(JSON.stringify({ ok: true })));
    await apiCommand(
      ["--field", "a=1", "POST", "projects/{project}/issues", "--paginate"],
      ctx,
    );
    const argv = raw.mock.calls[0][0] as string[];
    expect(argv[0]).toBe("api");
    expect(argv).toContain("projects/group%2Fproj/issues");
    expect(argv).toContain("--paginate");
    expect(argv).toContain("a=1");
  });

  it("replaces {project} with the URL-encoded project id", async () => {
    raw.mockResolvedValueOnce(ok(JSON.stringify({ id: 1 })));
    await apiCommand(["projects/{project}/pipelines"], ctx);
    const argv = raw.mock.calls[0][0] as string[];
    expect(argv[1]).toBe("projects/group%2Fproj/pipelines");
  });

  it("throws VALIDATION_ERROR when path is missing", async () => {
    await expect(apiCommand([], ctx)).rejects.toThrow(/path is required/);
  });

  it("throws when {project} is used without a resolvable context", async () => {
    await expect(
      apiCommand(["projects/{project}/pipelines"], undefined),
    ).rejects.toThrow(/\{project\}/);
  });

  it("wraps a non-JSON response in a truncated text envelope", async () => {
    const longBody = "x".repeat(5000);
    raw.mockResolvedValueOnce(ok(longBody));
    const out = await apiCommand(["GET", "some/raw/path"], ctx);
    expect(out).toContain("api_response:");
    expect(out).toContain("truncated: true");
    expect(out).toContain("original_length: 5000");
  });

  it("reports ok for an empty body", async () => {
    raw.mockResolvedValueOnce(ok(""));
    const out = await apiCommand(
      ["DELETE", "projects/{project}/issues/1"],
      ctx,
    );
    expect(out).toContain("status: ok");
  });
});
