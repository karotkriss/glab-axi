import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock at child_process, not gl.ts: the corruption happened in how the child's
// stdout was decoded, which a stub above the executor cannot observe. The fake
// honours `encoding` the way Node does - a string decoded as UTF-8 unless the
// caller asked for a buffer.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { main } from "../src/cli.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// A zip-ish payload with bytes that are not valid UTF-8.
const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28]),
  Buffer.alloc(64, 0xff),
]);

function respond(body: Buffer, exit = 0) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      opts: { encoding?: string },
      cb: (e: unknown, out: string | Buffer, err: string | Buffer) => void,
    ) => {
      const out = opts.encoding === "buffer" ? body : body.toString("utf8");
      cb(exit ? Object.assign(new Error("x"), { code: exit }) : null, out, "");
      return { stdin: { on() {}, end() {} } };
    },
  );
}

async function run(...args: string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await main({
    argv: ["api", ...args, "-R", "gitlab.example.com/group/project"],
    stdout: {
      write: (c: string | Uint8Array) => {
        chunks.push(Buffer.from(c));
      },
    },
  });
  return Buffer.concat(chunks);
}

beforeEach(() => {
  execFileMock.mockReset();
  process.exitCode = undefined;
});

describe("api binary responses", () => {
  it("--raw writes the response bytes unchanged", async () => {
    respond(ZIP);
    const out = await run("projects/{project}/jobs/1/artifacts/a.zip", "--raw");
    expect(out.equals(ZIP)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("--json writes the response bytes unchanged", async () => {
    respond(ZIP);
    const out = await run(
      "projects/{project}/jobs/1/artifacts/a.zip",
      "--json",
    );
    expect(out.equals(ZIP)).toBe(true);
  });

  it("--raw keeps a text body's surrounding whitespace byte for byte", async () => {
    const body = Buffer.from(' {"id":7}\r\n\n');
    respond(body);
    expect((await run("projects/{project}", "--raw")).equals(body)).toBe(true);
  });

  it("--raw on an empty response writes nothing", async () => {
    respond(Buffer.alloc(0));
    expect((await run("DELETE", "projects/{project}/x", "--raw")).length).toBe(
      0,
    );
  });

  it("keeps a JSON response on the TOON path without --raw", async () => {
    respond(Buffer.from('{"id":7}'));
    expect((await run("projects/{project}")).toString()).toContain("id: 7");
  });
});

describe("api binary failures", () => {
  it("reports an over-cap response as a structured error naming the cap", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: unknown, out: Buffer, err: Buffer) => void,
      ) => {
        cb(
          Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
          ZIP,
          Buffer.alloc(0),
        );
        return { stdin: { on() {}, end() {} } };
      },
    );
    const out = (
      await run("projects/{project}/jobs/1/artifacts/a.zip", "--raw")
    ).toString();
    expect(out).toContain("1024 MB output limit");
    expect(out).toContain("OUTPUT_TOO_LARGE");
    expect(out).toContain("directly over HTTP");
    expect(process.exitCode).not.toBe(0);
  });

  it("reports an over-cap text response with the 20 MB cap", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: unknown, out: Buffer, err: Buffer) => void,
      ) => {
        cb(
          Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
          ZIP,
          Buffer.alloc(0),
        );
        return { stdin: { on() {}, end() {} } };
      },
    );
    const out = (
      await run("projects/{project}/jobs/1/artifacts/a.zip", "--jq", ".")
    ).toString();
    expect(out).toContain("20 MB output limit");
    expect(out).toContain("OUTPUT_TOO_LARGE");
    expect(out).toContain("directly over HTTP");
    expect(process.exitCode).not.toBe(0);
  });

  it("never pattern-matches a partial binary body as the error", async () => {
    respond(Buffer.concat([ZIP, Buffer.from(" file not found ")]), 1);
    const out = (
      await run("projects/{project}/jobs/1/artifacts/a.zip", "--raw")
    ).toString();
    expect(out).not.toContain("NOT_FOUND");
    expect(out).toContain("Request failed with code 1");
  });

  it("still maps a JSON error body on a --raw call", async () => {
    respond(Buffer.from('{"message":"404 Not Found"}'), 1);
    const out = (
      await run("projects/{project}/jobs/1/artifacts/a.zip", "--raw")
    ).toString();
    expect(out).toContain("NOT_FOUND");
  });
});
