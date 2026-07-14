import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { glApi, glRaw, glApiResult } from "../src/gl.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execFileMock.mockReset();
});

function mockSpawnError(code: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    callback(error, "", "");
  });
}

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
