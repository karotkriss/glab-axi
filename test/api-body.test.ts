import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { readStdinMock } = vi.hoisted(() => ({
  readStdinMock: vi.fn((): string => ""),
}));
vi.mock("../src/stdin.js", () => ({ readStdin: readStdinMock }));

vi.mock("../src/gl.js", () => ({
  glApiResult: vi.fn(),
  projectId: (ctx?: { project: string }) =>
    ctx ? encodeURIComponent(ctx.project) : "{project}",
  errorBody: (result: { stderr: string; stdout: string }) =>
    [result.stderr, result.stdout].filter(Boolean).join("\n"),
}));

import { apiCommand } from "../src/commands/api.js";
import { glApiResult } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

const BASE_SHA = "a".repeat(40);
const START_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const OLD_PATH = "src/Old.php";
const NEW_PATH = "src/New.php";

function draftPosition() {
  return {
    position_type: "text",
    base_sha: BASE_SHA,
    start_sha: START_SHA,
    head_sha: HEAD_SHA,
    old_path: OLD_PATH,
    new_path: NEW_PATH,
    new_line: 85,
  };
}

function draftBody() {
  return { note: "review", position: draftPosition() };
}

function ok(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

let dir: string;

beforeEach(() => {
  glApiResultMock.mockReset();
  readStdinMock.mockReset();
  readStdinMock.mockReturnValue("");
  dir = mkdtempSync(join(tmpdir(), "glab-axi-api-body-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sentBody(): {
  content: string;
  parsed: ReturnType<typeof JSON.parse>;
} {
  const [, opts] = glApiResultMock.mock.calls[0];
  expect(opts.fields).toBeUndefined();
  expect(opts.rawFields).toBeUndefined();
  expect(opts.body.contentType).toBe("application/json");
  return { content: opts.body.content, parsed: JSON.parse(opts.body.content) };
}

describe("api nested fields", () => {
  it("keeps the three SHAs, both paths, and the integer line", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "POST",
        "projects/{project}/merge_requests/5/draft_notes",
        "--raw-field",
        "note=review",
        "--raw-field",
        "position[position_type]=text",
        "--raw-field",
        `position[base_sha]=${BASE_SHA}`,
        "--raw-field",
        `position[start_sha]=${START_SHA}`,
        "--raw-field",
        `position[head_sha]=${HEAD_SHA}`,
        "--raw-field",
        `position[old_path]=${OLD_PATH}`,
        "--raw-field",
        `position[new_path]=${NEW_PATH}`,
        "--field",
        "position[new_line]=85",
      ],
      ctx,
    );
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/5/draft_notes`,
    );
    const { parsed } = sentBody();
    expect(parsed).toEqual(draftBody());
    expect(parsed.position.new_line).toBe(85);
  });

  it("keeps a --raw-field nested value as a literal string", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "POST",
        "projects/{project}/merge_requests/5/draft_notes",
        "--raw-field",
        "position[new_line]=85",
        "--raw-field",
        "position[position_type]=text",
      ],
      ctx,
    );
    expect(sentBody().parsed.position).toEqual({
      new_line: "85",
      position_type: "text",
    });
  });

  it("parses a --field JSON object and leaves a lone --raw-field JSON value as a string", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "POST",
        "x",
        "--field",
        `position=${JSON.stringify(draftPosition())}`,
        "--raw-field",
        "note=review",
      ],
      ctx,
    );
    const { parsed } = sentBody();
    expect(parsed.position).toEqual(draftPosition());
    expect(parsed.position.new_line).toBe(85);
    expect(parsed.note).toBe("review");

    glApiResultMock.mockResolvedValueOnce(ok({ id: 2 }));
    await apiCommand(
      ["POST", "x", "--raw-field", 'position={"new_line":85}'],
      ctx,
    );
    const [, opts] = glApiResultMock.mock.calls[1];
    expect(opts.rawFields).toEqual(['position={"new_line":85}']);
    expect(opts.body).toBeUndefined();
  });

  it("leaves a GET bracket name as a query parameter", async () => {
    glApiResultMock.mockResolvedValueOnce(ok([]));
    await apiCommand(
      ["projects/{project}/x", "--raw-field", `position[base_sha]=${BASE_SHA}`],
      ctx,
    );
    const [, opts] = glApiResultMock.mock.calls[0];
    expect(opts.rawFields).toEqual([`position[base_sha]=${BASE_SHA}`]);
    expect(opts.body).toBeUndefined();
  });

  it("rejects a bracket name that is not closed", async () => {
    await expect(
      apiCommand(
        ["POST", "x", "--raw-field", `position[base_sha=${BASE_SHA}`],
        ctx,
      ),
    ).rejects.toThrow("invalid parameter name");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });
});

describe("api --input", () => {
  it("sends a file body with the integer line intact and not on a field", async () => {
    const file = join(dir, "note.json");
    const text = `${JSON.stringify(draftBody())}\n`;
    writeFileSync(file, text);
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "POST",
        "projects/{project}/merge_requests/5/draft_notes",
        "--input",
        file,
      ],
      ctx,
    );
    const { content, parsed } = sentBody();
    expect(content).toBe(text);
    expect(parsed.position.new_line).toBe(85);
    expect(parsed.position.base_sha).toBe(BASE_SHA);
    expect(parsed.position.start_sha).toBe(START_SHA);
    expect(parsed.position.head_sha).toBe(HEAD_SHA);
    expect(parsed.position.old_path).toBe(OLD_PATH);
    expect(parsed.position.new_path).toBe(NEW_PATH);
    expect(readStdinMock).not.toHaveBeenCalled();
  });

  it("forwards stdin and does not treat the --input value as the path", async () => {
    const text = JSON.stringify(draftBody());
    readStdinMock.mockReturnValue(text);
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "--input",
        "-",
        "POST",
        "projects/{project}/merge_requests/5/draft_notes",
      ],
      ctx,
    );
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/5/draft_notes`,
    );
    expect(sentBody().content).toBe(text);
    expect(sentBody().parsed.position.new_line).toBe(85);
    expect(readStdinMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON before any request", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{");
    await expect(
      apiCommand(["POST", "x", "--input", file], ctx),
    ).rejects.toThrow("JSON body is not valid JSON");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("rejects a repeated --input and --input combined with a field", async () => {
    await expect(
      apiCommand(["POST", "x", "--input", "a.json", "--input", "b.json"], ctx),
    ).rejects.toThrow("--input was given more than once");
    await expect(
      apiCommand(
        ["POST", "x", "--input", "a.json", "--raw-field", "note=review"],
        ctx,
      ),
    ).rejects.toThrow("--input cannot be combined with --field or --raw-field");
    await expect(apiCommand(["POST", "x", "--input"], ctx)).rejects.toThrow(
      "--input requires a file path or -",
    );
    expect(glApiResultMock).not.toHaveBeenCalled();
    expect(readStdinMock).not.toHaveBeenCalled();
  });

  it("rejects an empty stdin body", async () => {
    await expect(
      apiCommand(["POST", "x", "--input", "-"], ctx),
    ).rejects.toThrow("No JSON body was piped on stdin");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });
});
