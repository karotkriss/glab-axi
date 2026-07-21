import { describe, it, expect, vi, beforeEach } from "vitest";

// This file deliberately does NOT mock ../src/gl.js. The whole point is to see
// the argument list the child process is actually spawned with, so the mock
// boundary has to sit at child_process - one layer below the executor. A test
// that stubs gl.ts cannot observe this bug at all, which is how it shipped.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

const { readStdinMock } = vi.hoisted(() => ({
  readStdinMock: vi.fn((): string => ""),
}));
vi.mock("../src/stdin.js", () => ({ readStdin: readStdinMock }));

import { execFile } from "node:child_process";
import { secretCommand } from "../src/commands/secret.js";
import { variableCommand } from "../src/commands/variable.js";
import type { RepoContext } from "../src/context.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};

/** A value that is unmistakable if it ever shows up somewhere it should not. */
const SECRET = "CanaryS3cretValue0123456789";

interface Spawn {
  args: string[];
  stdin: string | undefined;
}

/**
 * Record every spawn, answering the GET-first probe with `exists` and every
 * following write with a plausible variable body.
 */
function captureSpawns(exists: boolean): Spawn[] {
  const spawns: Spawn[] = [];
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (
        error: (Error & { code?: number }) | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      const spawn: Spawn = { args, stdin: undefined };
      spawns.push(spawn);
      const isProbe = spawns.length === 1;
      const body = JSON.stringify({
        key: "API_TOKEN",
        value: SECRET,
        masked: true,
        protected: true,
        environment_scope: "*",
      });
      queueMicrotask(() => {
        if (isProbe && !exists) {
          const err = new Error("HTTP 404") as Error & { code: number };
          err.code = 1;
          callback(err, "", "404 Not Found");
          return;
        }
        callback(null, body, "");
      });
      return {
        stdin: {
          on: () => {},
          end: (value: string) => {
            spawn.stdin = value;
          },
        },
      };
    },
  );
  return spawns;
}

/** Every argument the child was handed, across all spawns, flattened. */
function allArgv(spawns: Spawn[]): string[] {
  return spawns.flatMap((s) => s.args);
}

describe("secret values never reach the child's argument list", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    readStdinMock.mockReset();
    readStdinMock.mockReturnValue(SECRET);
  });

  // The regression. `/proc/<pid>/cmdline` is world-readable, so a secret in
  // argv is readable by every other process on the machine for as long as the
  // request is in flight. `secret set` refuses --value on exactly these
  // grounds, then passed the value to `glab` as `-f value=<secret>` anyway.
  it("keeps the value out of argv when creating a secret", async () => {
    const spawns = captureSpawns(false);

    await secretCommand(["set", "API_TOKEN"], ctx);

    for (const arg of allArgv(spawns)) {
      expect(arg).not.toContain(SECRET);
    }
  });

  it("keeps the value out of argv when updating an existing secret", async () => {
    // A stored value that differs, so the idempotent path performs the PUT.
    readStdinMock.mockReturnValue(`${SECRET}-changed`);
    const spawns = captureSpawns(true);

    await secretCommand(["set", "API_TOKEN"], ctx);

    for (const arg of allArgv(spawns)) {
      expect(arg).not.toContain(SECRET);
    }
  });

  it("hands the value to the child on stdin instead", async () => {
    const spawns = captureSpawns(false);

    await secretCommand(["set", "API_TOKEN"], ctx);

    const write = spawns.find((s) => s.stdin !== undefined);
    expect(write?.stdin).toBe(SECRET);
    // `@-` is what tells the child to read the parameter from that stdin; if
    // it went missing the value would be silently dropped rather than leaked,
    // which is a different failure worth catching here too.
    expect(write?.args).toContain("value=@-");
  });

  // The plain-variable surface shares upsertVariable, so it inherits the fix.
  // Asserting it here stops a future change from "optimising" that path back
  // onto argv and quietly reopening the hole for the shared helper.
  it("keeps a plain variable's value out of argv too", async () => {
    const spawns = captureSpawns(false);

    await variableCommand(["set", "SOME_KEY", "--value", SECRET], ctx);

    // The flag is on OUR argv by the caller's own choice, but the child still
    // receives it on stdin - the shared helper makes no exception.
    const write = spawns.find((s) => s.stdin !== undefined);
    expect(write?.stdin).toBe(SECRET);
    for (const arg of allArgv(spawns)) {
      expect(arg).not.toContain(SECRET);
    }
  });
});
