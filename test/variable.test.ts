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

import { variableCommand } from "../src/commands/variable.js";
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
    key: "NODE_ENV",
    value: "production",
    protected: false,
    masked: false,
    environment_scope: "*",
    ...overrides,
  };
}

describe("variable list", () => {
  it("requests variables and renders a TOON list with a count", async () => {
    glApiMock.mockResolvedValueOnce([
      variable(),
      variable({ key: "LOG_LEVEL", value: "info" }),
    ]);
    const out = await variableCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/variables`);
    expect(path).toContain("per_page=100");
    expect(out).toContain("count: 2");
    expect(out).toContain("variables[2]");
    expect(out).toContain("NODE_ENV");
  });

  it("hides masked variables (those belong to `secret list`)", async () => {
    glApiMock.mockResolvedValueOnce([
      variable(),
      variable({ key: "API_KEY", masked: true, value: "sk-secret" }),
    ]);
    const out = await variableCommand(["list"], ctx);
    expect(out).toContain("count: 1");
    expect(out).toContain("NODE_ENV");
    expect(out).not.toContain("API_KEY");
    expect(out).not.toContain("sk-secret");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await variableCommand(["list"], ctx);
    expect(out).toContain("variables: 0 variables found");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await variableCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=100");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("flags truncation when the raw page is full, even after filtering shrinks the count", async () => {
    // Raw page hits --limit 2, but one of those is masked and filtered out,
    // so the visible count (1) must not be mistaken for the full result set.
    glApiMock.mockResolvedValueOnce([
      variable(),
      variable({ key: "API_KEY", masked: true, value: "sk-secret" }),
    ]);
    const out = await variableCommand(["list", "--limit", "2"], ctx);
    expect(out).toContain("count: 1 (showing first 1)");
  });

  it("does not flag truncation when the raw page is not full", async () => {
    glApiMock.mockResolvedValueOnce([variable()]);
    const out = await variableCommand(["list", "--limit", "2"], ctx);
    expect(out).toContain("count: 1");
    expect(out).not.toContain("showing first");
  });
});

describe("variable get", () => {
  it("fetches a single variable scoped to '*' and shows the value", async () => {
    glApiMock.mockResolvedValueOnce(variable());
    const out = await variableCommand(["get", "NODE_ENV"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/variables/NODE_ENV`);
    expect(path).toContain("filter[environment_scope]=*");
    expect(out).toContain("value: production");
  });

  it("requires a name", async () => {
    await expect(variableCommand(["get"], ctx)).rejects.toThrow(
      "Missing variable name",
    );
  });

  it("redacts the value of a masked variable and never echoes the plaintext", async () => {
    glApiMock.mockResolvedValueOnce(
      variable({ key: "API_KEY", masked: true, value: "sk-secret" }),
    );
    const out = await variableCommand(["get", "API_KEY"], ctx);
    expect(out).toContain("[masked]");
    expect(out).not.toContain("sk-secret");
    expect(out).toContain("secret list");
  });
});

describe("variable set", () => {
  it("creates an unmasked variable via POST when it does not exist", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404",
      exitCode: 22,
    });
    glApiMock.mockResolvedValueOnce(variable());
    const out = await variableCommand(
      ["set", "NODE_ENV", "--value", "production"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/variables`);
    expect(call[1].method).toBe("POST");
    expect(call[1].rawFields).toContain("key=NODE_ENV");
    expect(call[1].rawFields).toContain("value=production");
    expect(call[1].rawFields).toContain("environment_scope=*");
    expect(call[1].fields).toContain("masked=false");
    expect(call[1].fields).toContain("protected=false");
    expect(out).toContain("created");
    expect(out).toContain("NODE_ENV");
  });

  it("updates via PUT when the variable already exists", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "{}",
      stderr: "",
      exitCode: 0,
    });
    glApiMock.mockResolvedValueOnce(variable({ value: "staging" }));
    const out = await variableCommand(
      ["set", "NODE_ENV", "--value", "staging"],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toContain(`projects/${PID}/variables/NODE_ENV`);
    expect(call[1].method).toBe("PUT");
    expect(call[1].rawFields).toContain("value=staging");
    expect(call[1].rawFields).not.toContain("key=NODE_ENV");
    expect(out).toContain("updated");
  });

  it("is a no-op when the stored value and flags already match", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(variable({ value: "production" })),
      stderr: "",
      exitCode: 0,
    });
    const out = await variableCommand(
      ["set", "NODE_ENV", "--value", "production"],
      ctx,
    );
    // No write at all - the GET already proved the target state.
    expect(glApiMock).not.toHaveBeenCalled();
    expect(out).toContain("already: true");
    expect(out).not.toContain("updated");
  });

  it("still PUTs when only a flag differs from the stored variable", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(
        variable({ value: "production", protected: false }),
      ),
      stderr: "",
      exitCode: 0,
    });
    glApiMock.mockResolvedValueOnce(variable({ protected: true }));
    const out = await variableCommand(
      ["set", "NODE_ENV", "--value", "production", "--protected"],
      ctx,
    );
    expect(glApiMock.mock.calls[0][1].method).toBe("PUT");
    expect(out).toContain("updated");
  });

  it("falls through to a PUT when the stored body is not usable JSON", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    });
    glApiMock.mockResolvedValueOnce(variable({ value: "production" }));
    await variableCommand(["set", "NODE_ENV", "--value", "production"], ctx);
    expect(glApiMock.mock.calls[0][1].method).toBe("PUT");
  });

  it("passes --protected through as a typed boolean", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404",
      exitCode: 22,
    });
    glApiMock.mockResolvedValueOnce(variable({ protected: true }));
    await variableCommand(
      ["set", "NODE_ENV", "--value", "production", "--protected"],
      ctx,
    );
    expect(glApiMock.mock.calls[0][1].fields).toContain("protected=true");
  });

  it("requires a value", async () => {
    await expect(variableCommand(["set", "NODE_ENV"], ctx)).rejects.toThrow(
      "A value is required",
    );
  });
});

describe("variable delete", () => {
  it("DELETEs the scoped key", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await variableCommand(["delete", "NODE_ENV"], ctx);
    const call = glApiResultMock.mock.calls[0];
    expect(call[0]).toContain(`projects/${PID}/variables/NODE_ENV`);
    expect(call[0]).toContain("filter[environment_scope]=*");
    expect(call[1].method).toBe("DELETE");
    expect(out).toContain("deleted");
    expect(out).toContain("status: ok");
  });

  it("is idempotent on a 404 (already absent)", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404 Not Found",
      exitCode: 22,
    });
    const out = await variableCommand(["delete", "GHOST"], ctx);
    expect(out).toContain("already_absent: true");
    expect(out).toContain("GHOST");
  });
});

describe("variable router", () => {
  it("returns help for no subcommand", async () => {
    const out = await variableCommand([], ctx);
    expect(out).toContain("usage: glab-axi variable");
  });

  it("errors on unknown subcommand", async () => {
    await expect(variableCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown variable subcommand",
    );
  });
});
