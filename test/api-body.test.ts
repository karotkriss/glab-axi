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

  it("rejects malformed JSON before any request and names the position", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{");
    await expect(
      apiCommand(["POST", "x", "--input", file], ctx),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/JSON body is not valid JSON: .*position/),
      suggestions: expect.arrayContaining([expect.stringContaining("--input")]),
    });
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid UTF-8 file with a re-encode hint", async () => {
    const binary = join(dir, "binary.json");
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x7b]));
    await expect(
      apiCommand(["POST", "x", "--input", binary], ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining("not valid UTF-8"),
      suggestions: expect.arrayContaining([
        expect.stringContaining("Re-encode the file as UTF-8"),
      ]),
    });

    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("accepts a UTF-8 BOM in a body file and sends the JSON without it", async () => {
    const bom = join(dir, "bom.json");
    writeFileSync(
      bom,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
    );
    glApiResultMock.mockResolvedValue({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });
    await apiCommand(["POST", "x", "--input", bom], ctx);
    expect(sentBody().content).toBe('{"a":1}');
  });

  it("sends the caller Content-Type once and keeps other headers", async () => {
    const file = join(dir, "note.json");
    writeFileSync(file, '{"a":1}\n');
    glApiResultMock.mockResolvedValueOnce(ok({}));
    await apiCommand(
      [
        "POST",
        "x",
        "--input",
        file,
        "--header",
        "Content-Type: application/merge-patch+json",
        "--header",
        "X-Trace: 1",
      ],
      ctx,
    );
    const [, opts] = glApiResultMock.mock.calls[0];
    expect(opts.body.contentType).toBe("application/merge-patch+json");
    expect(opts.headers).toEqual(["X-Trace: 1"]);
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

describe("api review regressions", () => {
  it("keeps a multi-line draft-note line_range", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    const startCode = "abc_10_10";
    const endCode = "abc_10_14";
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
        "position[new_line]=14",
        "--raw-field",
        `position[line_range][start][line_code]=${startCode}`,
        "--raw-field",
        "position[line_range][start][type]=new",
        "--field",
        "position[line_range][start][new_line]=10",
        "--raw-field",
        `position[line_range][end][line_code]=${endCode}`,
        "--raw-field",
        "position[line_range][end][type]=new",
        "--field",
        "position[line_range][end][new_line]=14",
      ],
      ctx,
    );
    expect(sentBody().parsed.position.line_range).toEqual({
      start: { line_code: startCode, type: "new", new_line: 10 },
      end: { line_code: endCode, type: "new", new_line: 14 },
    });
    expect(sentBody().parsed.position.new_line).toBe(14);
  });

  it("parses a JSON object under a bracket name", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      [
        "POST",
        "x",
        "--field",
        'position[line_range]={"start":{"line_code":"abc_10_10"}}',
      ],
      ctx,
    );
    expect(sentBody().parsed.position.line_range).toEqual({
      start: { line_code: "abc_10_10" },
    });
  });

  it("rejects a name that is both a scalar and a nested field", async () => {
    await expect(
      apiCommand(
        [
          "POST",
          "x",
          "--raw-field",
          "position=text",
          "--raw-field",
          `position[base_sha]=${BASE_SHA}`,
        ],
        ctx,
      ),
    ).rejects.toThrow("parameter position is both a value and a nested field");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("refuses actions[][action] and points at --input", async () => {
    await expect(
      apiCommand(["POST", "x", "--raw-field", "actions[][action]=update"], ctx),
    ).rejects.toThrow("nests inside an array");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --field JSON value and names --raw-field", async () => {
    await expect(
      apiCommand(["POST", "x", "--field", "labels=[bug]"], ctx),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /--field value is not valid JSON: Unexpected token/,
      ),
      suggestions: ["Use --raw-field to send the text as a literal string"],
    });
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("leaves graphql fields for the wrapped CLI to nest under variables", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ data: {} }));
    await apiCommand(
      [
        "POST",
        "graphql",
        "--raw-field",
        "query=query { project { id } }",
        "--field",
        'input={"projectPath":"group/project"}',
      ],
      ctx,
    );
    const [path, opts] = glApiResultMock.mock.calls[0];
    expect(path).toBe("graphql");
    expect(opts.body).toBeUndefined();
    expect(opts.fields).toEqual(['input={"projectPath":"group/project"}']);
    expect(opts.rawFields).toEqual(["query=query { project { id } }"]);
  });
});
