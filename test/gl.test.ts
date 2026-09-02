import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  glApi,
  glApiList,
  glRaw,
  glApiResult,
  glConfigGet,
  glCredential,
} from "../src/gl.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
});

function mockSpawnError(code: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    callback(error, "", "");
  });
}

describe("stdin write errors", () => {
  // A child that exits before reading stdin makes the write fail with EPIPE.
  // An unhandled `error` on an EventEmitter throws, which took the whole
  // process down and lost the child's real exit code - reachable for real when
  // an OLD shadowed install does not implement the subcommand being invoked.
  it("survives a child that closes stdin before reading it", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const child = { stdin: new EventEmitter() as never };
      (child.stdin as unknown as { end: () => void }).end = () => {
        const epipe = new Error("write EPIPE") as Error & { code: string };
        epipe.code = "EPIPE";
        // Throws unless something is listening, exactly as the real stream does.
        (child.stdin as unknown as EventEmitter).emit("error", epipe);
      };
      queueMicrotask(() => callback(null, "", ""));
      return child;
    });

    const result = await glCredential("get", "protocol=https\n\n");

    // The child's own outcome survives, which is the point of not crashing.
    expect(result.exitCode).toBe(0);
  });
});

describe("gl error mapping", () => {
  it("maps E2BIG to an actionable VALIDATION_ERROR for glApi", async () => {
    mockSpawnError("E2BIG");
    await expect(glApi("projects/1")).rejects.toThrow(
      "too large to pass as a command-line argument",
    );
  });

  it("maps E2BIG to an actionable VALIDATION_ERROR for glRaw", async () => {
    mockSpawnError("E2BIG");
    await expect(glRaw("projects/1")).rejects.toThrow(
      "too large to pass as a command-line argument",
    );
  });

  it("maps E2BIG to an actionable VALIDATION_ERROR for glApiResult", async () => {
    mockSpawnError("E2BIG");
    await expect(glApiResult("projects/1")).rejects.toThrow(
      "too large to pass as a command-line argument",
    );
  });

  it("still maps ENOENT to the CLI-not-installed error", async () => {
    mockSpawnError("ENOENT");
    await expect(glApi("projects/1")).rejects.toThrow(
      "GitLab CLI is not installed",
    );
  });

  it("never leaks the wrapped CLI's name in the E2BIG message", async () => {
    mockSpawnError("E2BIG");
    const err = await glApi("projects/1").catch((e) => e as Error);
    expect(err.message).not.toMatch(/\bglab\b(?!-axi)/i);
  });
});

describe("host targeting and raw request body", () => {
  /** Capture the argv and any stdin the child was handed. */
  function captureCall(): { args: () => string[]; stdin: () => unknown } {
    let seenArgs: string[] = [];
    let seenStdin: unknown;
    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        seenArgs = args;
        queueMicrotask(() => callback(null, "{}", ""));
        return {
          stdin: {
            on: () => {},
            end: (value: unknown) => {
              seenStdin = value;
            },
          },
        };
      },
    );
    return { args: () => seenArgs, stdin: () => seenStdin };
  }

  const ctx = {
    host: "gitlab.example.com",
    project: "group/project",
    source: "flag" as const,
  };

  it("passes --hostname so the cwd git remote cannot silently override the target host", async () => {
    const cap = captureCall();
    await glApi("projects/1", { ctx });
    expect(cap.args()).toContain("--hostname");
    const i = cap.args().indexOf("--hostname");
    expect(cap.args()[i + 1]).toBe("gitlab.example.com");
  });

  it("adds no --hostname when no host is resolved", async () => {
    const cap = captureCall();
    await glApi("projects/1");
    expect(cap.args()).not.toContain("--hostname");
  });

  it("sends a raw body via --input - with its Content-Type, feeding the bytes on stdin", async () => {
    const cap = captureCall();
    await glApi("snippets", {
      method: "POST",
      body: { content: '{"a":1}', contentType: "application/json" },
      ctx,
    });
    const args = cap.args();
    expect(args).toContain("--input");
    expect(args[args.indexOf("--input") + 1]).toBe("-");
    expect(args).toContain("Content-Type: application/json");
    expect(cap.stdin()).toBe('{"a":1}');
  });

  it("carries a binary Buffer body through to the child's stdin intact", async () => {
    const cap = captureCall();
    const bytes = Buffer.from([0x00, 0x01, 0x89, 0x50]);
    await glApi("projects/1/uploads", {
      method: "POST",
      body: { content: bytes, contentType: "multipart/form-data; boundary=x" },
      ctx,
    });
    expect(cap.stdin()).toBe(bytes);
  });
});

describe("glConfigGet", () => {
  it("returns '' when the host has no config entry", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("exit status 1");
    });
    expect(glConfigGet("api_host", "gitlab.example.com")).toBe("");
  });

  it("returns the configured value, trimmed", () => {
    execFileSyncMock.mockReturnValue("gitlab.example.com\n");
    expect(glConfigGet("api_host", "gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });

  // A missing glab binary must surface as the actionable not-installed error,
  // not be conflated with "host has no config entry" - otherwise a machine
  // without glab on PATH silently resolves to no project instead of saying why.
  it("throws the not-installed error when glab is missing, rather than reading back ''", () => {
    const error = new Error("ENOENT") as Error & { code: string };
    error.code = "ENOENT";
    execFileSyncMock.mockImplementation(() => {
      throw error;
    });
    expect(() => glConfigGet("api_host", "gitlab.example.com")).toThrow(
      "GitLab CLI is not installed",
    );
  });
});

describe("glApiList (X-Total plumbing)", () => {
  /** Reply the way `glab api -i` does: status line, headers, blank line, body. */
  function mockResponse(raw: string) {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) =>
      callback(null, raw, ""),
    );
  }

  function headers(extra: string, body: string) {
    return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${extra}\r\n\r\n${body}`;
  }

  it("requests response headers so the total is available at all", async () => {
    mockResponse(headers("X-Total: 4", "[]"));
    await glApiList("projects/1/issues");
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain("-i");
  });

  it("parses X-Total alongside the rows", async () => {
    mockResponse(headers("X-Total: 847", '[{"iid":1},{"iid":2}]'));
    const result = await glApiList("projects/1/issues?per_page=2");
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(847);
  });

  it("reports null (never 0) when GitLab omits X-Total, as it does past 10k rows", async () => {
    mockResponse(headers("X-Next-Page: 2", '[{"iid":1}]'));
    const result = await glApiList("projects/1/issues");
    expect(result.data).toHaveLength(1);
    expect(result.total).toBeNull();
  });

  it("ignores an X-Total spelled inside the body, trusting only the header block", async () => {
    mockResponse(headers("X-Next-Page: 2", '[{"title":"\\nX-Total: 999"}]'));
    expect((await glApiList("projects/1/issues")).total).toBeNull();
  });

  it("treats a null body (some search scopes) as no rows", async () => {
    mockResponse(headers("X-Total: 0", "null"));
    const result = await glApiList("search?scope=commits");
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("maps a failed request through the shared error path", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const error = new Error("404") as Error & { code: number };
      error.code = 1;
      callback(error, '{"message":"404 Project Not Found"}', "");
    });
    await expect(glApiList("projects/1/issues")).rejects.toThrow();
  });
});
