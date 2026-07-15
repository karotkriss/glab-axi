import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  return {
    glApi: vi.fn(),
    glRaw: vi.fn(),
    glApiResult: vi.fn(),
    projectId: (ctx?: { project: string }) =>
      ctx ? encodeURIComponent(ctx.project) : "{project}",
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

// Never read the real stdin during tests; --value is always supplied.
vi.mock("../src/stdin.js", () => ({ readStdin: () => "" }));

import { secretCommand } from "../src/commands/secret.js";
import { glApi, glApiResult } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

beforeEach(() => {
  glApiMock.mockReset();
  glApiResultMock.mockReset();
});

function variable(overrides: Record<string, unknown> = {}) {
  return {
    variable_type: "env_var",
    key: "OPENAI_API_KEY",
    value: "sk-supersecretvalue",
    protected: true,
    masked: true,
    environment_scope: "*",
    ...overrides,
  };
}

describe("secret list", () => {
  it("shows only masked variables and never reveals their values", async () => {
    glApiMock.mockResolvedValueOnce([
      variable(),
      variable({ key: "NODE_ENV", value: "production", masked: false }),
    ]);
    const out = await secretCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/variables`);
    expect(out).toContain("count: 1");
    expect(out).toContain("secrets[1]");
    expect(out).toContain("OPENAI_API_KEY");
    // masked value must never appear; the plain variable must be excluded.
    expect(out).not.toContain("sk-supersecretvalue");
    expect(out).not.toContain("NODE_ENV");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([
      variable({ masked: false }), // only a plain variable exists
    ]);
    const out = await secretCommand(["list"], ctx);
    expect(out).toContain("secrets: 0 secrets found");
  });

  it("flags truncation when the raw page is full, even after filtering shrinks the count", async () => {
    // Raw page hits --limit 2, but one of those is unmasked and filtered
    // out, so the visible count (1) must not be mistaken for the full set.
    glApiMock.mockResolvedValueOnce([
      variable(),
      variable({ key: "NODE_ENV", value: "production", masked: false }),
    ]);
    const out = await secretCommand(["list", "--limit", "2"], ctx);
    expect(out).toContain("count: 1 (showing first 1)");
  });
});

describe("secret set", () => {
  it("inherits the shared no-op: an unchanged secret reports already, not updated", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        key: "API_KEY",
        value: "s3cret-value",
        masked: true,
        protected: true,
        environment_scope: "*",
      }),
      stderr: "",
      exitCode: 0,
    });
    const out = await secretCommand(
      ["set", "API_KEY", "--value", "s3cret-value"],
      ctx,
    );
    expect(glApiMock).not.toHaveBeenCalled();
    expect(out).toContain("already: true");
    // The no-op path must not leak the value either.
    expect(out).not.toContain("s3cret-value");
  });

  it("creates a masked+protected variable via POST", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404",
      exitCode: 22,
    });
    glApiMock.mockResolvedValueOnce(variable());
    const out = await secretCommand(
      ["set", "OPENAI_API_KEY", "--value", "sk-supersecretvalue"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/variables`);
    expect(call[1].method).toBe("POST");
    expect(call[1].rawFields).toContain("key=OPENAI_API_KEY");
    expect(call[1].rawFields).toContain("value=sk-supersecretvalue");
    expect(call[1].fields).toContain("masked=true");
    expect(call[1].fields).toContain("protected=true");
    expect(out).toContain("created");
    expect(out).toContain("masked: yes");
    // The set result must not echo the secret value back.
    expect(out).not.toContain("sk-supersecretvalue");
  });

  it("updates via PUT when the secret already exists", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });
    glApiMock.mockResolvedValueOnce(variable());
    const out = await secretCommand(
      ["set", "OPENAI_API_KEY", "--value", "sk-rotatedvalue"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[1].method).toBe("PUT");
    expect(call[1].fields).toContain("masked=true");
    expect(out).toContain("updated");
  });

  it("requires a value", async () => {
    await expect(secretCommand(["set", "OPENAI_API_KEY"], ctx)).rejects.toThrow(
      "A value is required",
    );
  });
});

describe("secret delete", () => {
  it("DELETEs the scoped key", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await secretCommand(["delete", "OPENAI_API_KEY"], ctx);
    const call = glApiResultMock.mock.calls[0];
    expect(call[0]).toContain(`projects/${PID}/variables/OPENAI_API_KEY`);
    expect(call[1].method).toBe("DELETE");
    expect(out).toContain("deleted");
  });

  it("is idempotent on a 404 (already absent)", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404 Not Found",
      exitCode: 22,
    });
    const out = await secretCommand(["delete", "GHOST"], ctx);
    expect(out).toContain("already_absent: true");
  });
});

describe("secret router", () => {
  it("returns help for no subcommand", async () => {
    const out = await secretCommand([], ctx);
    expect(out).toContain("usage: glab-axi secret");
  });

  it("errors on unknown subcommand", async () => {
    await expect(secretCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown secret subcommand",
    );
  });
});
