import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import { readStdin } from "../src/stdin.js";

const readFileSyncMock = readFileSync as unknown as ReturnType<typeof vi.fn>;

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  readFileSyncMock.mockReset();
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
});

describe("readStdin", () => {
  it("returns '' when stdin is a TTY, without reading", () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    expect(readStdin()).toBe("");
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns '' when the read fails", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });
    expect(readStdin()).toBe("");
  });

  it("decodes valid UTF-8 bytes", () => {
    readFileSyncMock.mockReturnValue(Buffer.from("hello\n", "utf8"));
    expect(readStdin()).toBe("hello\n");
  });

  it("lossily decodes invalid UTF-8 bytes by default", () => {
    readFileSyncMock.mockReturnValue(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(readStdin()).toContain("�");
  });

  it("throws the given message when rejectBinaryMessage is set and bytes are invalid UTF-8", () => {
    readFileSyncMock.mockReturnValue(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(() =>
      readStdin({ rejectBinaryMessage: "nope, binary", suggestions: ["x"] }),
    ).toThrow("nope, binary");
  });

  it("does not reject text that legitimately contains U+FFFD when validating strictly", () => {
    const withReplacementChar = Buffer.from("hi � there", "utf8");
    readFileSyncMock.mockReturnValue(withReplacementChar);
    expect(readStdin({ rejectBinaryMessage: "nope" })).toBe("hi � there");
  });
});
