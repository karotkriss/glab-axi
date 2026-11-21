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

function respond(contentType: string, body: Buffer, exit = 0) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      opts: { encoding?: string },
      cb: (e: unknown, out: string | Buffer, err: string | Buffer) => void,
    ) => {
      const raw = Buffer.concat([
        Buffer.from(
          `HTTP/1.1 200 OK\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`,
        ),
        body,
      ]);
      const out = opts.encoding === "buffer" ? raw : raw.toString("utf8");
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
    respond("application/zip", ZIP);
    const out = await run("projects/{project}/jobs/1/artifacts/a.zip", "--raw");
    expect(out.equals(ZIP)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("without --raw prints a summary, not escaped bytes", async () => {
    respond("application/zip", ZIP);
    const out = (
      await run("projects/{project}/jobs/1/artifacts/a.zip")
    ).toString();
    expect(out).toContain("content_type: application/zip");
    expect(out).toContain(`bytes: ${ZIP.length}`);
    expect(out).toContain("--raw");
    expect(out).not.toContain("�");
  });

  it("keeps a JSON response on the TOON path", async () => {
    respond("application/json", Buffer.from('{"id":7}'));
    expect((await run("projects/{project}")).toString()).toContain("id: 7");
  });

  it("--raw on text still trims, as before", async () => {
    respond("application/json", Buffer.from('{"id":7}\n'));
    expect((await run("projects/{project}", "--raw")).toString()).toBe(
      '{"id":7}\n',
    );
  });
});
