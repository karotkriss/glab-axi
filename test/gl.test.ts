import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import { glApi, glRaw, glApiResult, glConfigGet } from "../src/gl.js";

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
