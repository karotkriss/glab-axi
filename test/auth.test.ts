import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network/credential store is touched.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glCredential: vi.fn(),
}));

// The credential helper reads git's protocol from stdin; never the real one.
const { readStdinMock } = vi.hoisted(() => ({
  readStdinMock: vi.fn((): string => ""),
}));
vi.mock("../src/stdin.js", () => ({ readStdin: readStdinMock }));

vi.mock("../src/hosts.js", () => ({
  knownHosts: () => new Set(["gitlab.example.com"]),
}));

import { authCommand } from "../src/commands/auth.js";
import { glApi, glCredential } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiMock = glApi as unknown as ReturnType<typeof vi.fn>;
const credMock = glCredential as unknown as ReturnType<typeof vi.fn>;

const ctx: RepoContext = { host: "gitlab.example.com", source: "flag" };
const TOKEN = "glpat-secret-value";
const CREDENTIAL = `protocol=https\nhost=gitlab.example.com\nusername=oauth2\npassword=${TOKEN}\n`;

function found() {
  return { stdout: CREDENTIAL, stderr: "", exitCode: 0 };
}
function missing() {
  return { stdout: "", stderr: "", exitCode: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  readStdinMock.mockReturnValue("");
  process.exitCode = undefined;
});

describe("auth status", () => {
  it("reports a verified credential without ever printing the secret", async () => {
    credMock.mockResolvedValue(found());
    glApiMock.mockResolvedValue({ username: "someuser" });

    const out = await authCommand(["status"], ctx);

    expect(out).toContain("available: yes");
    expect(out).toContain("username: oauth2");
    expect(out).toContain("verified_as: someuser");
    // The whole point of this verb: the token never reaches stdout.
    expect(out).not.toContain(TOKEN);
  });

  it("asks the credential store for the host it was given", async () => {
    credMock.mockResolvedValue(found());
    glApiMock.mockResolvedValue({ username: "someuser" });

    await authCommand(["status"], {
      host: "gitlab.other.test",
      source: "flag",
    });

    expect(credMock).toHaveBeenCalledWith(
      "get",
      "protocol=https\nhost=gitlab.other.test\n\n",
    );
  });

  it("verifies against the same host, not the default one", async () => {
    credMock.mockResolvedValue(found());
    glApiMock.mockResolvedValue({ username: "someuser" });

    await authCommand(["status"], {
      host: "gitlab.other.test",
      source: "flag",
    });

    expect(glApiMock).toHaveBeenCalledWith("user", {
      ctx: { host: "gitlab.other.test", source: "flag" },
    });
  });

  it("reports a missing credential as a definitive no, not an error", async () => {
    credMock.mockResolvedValue(missing());

    const out = await authCommand(["status"], ctx);

    expect(out).toContain("available: no");
    expect(out).toContain("Set GITLAB_TOKEN");
    // The wrapped CLI's binary name must never reach user-facing output.
    expect(out).not.toMatch(/\bglab\b(?!-axi)/);
    // Absence is a successful answer to the question, so no API call is spent.
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("distinguishes an unreachable host from an absent credential", async () => {
    credMock.mockResolvedValue(found());
    glApiMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const out = await authCommand(["status"], ctx);

    expect(out).toContain("available: yes");
    expect(out).toContain("verified: unavailable - ");
    expect(out).not.toContain("verified_as:");
    expect(out).not.toContain(TOKEN);
  });

  it("requires a host rather than guessing one", async () => {
    await expect(authCommand(["status"], undefined)).rejects.toThrow(
      /Could not determine which GitLab host/,
    );
    expect(credMock).not.toHaveBeenCalled();
  });
});

describe("auth git-credential", () => {
  it("passes git's request through and returns the helper's reply verbatim", async () => {
    readStdinMock.mockReturnValue(
      "protocol=https\nhost=gitlab.example.com\n\n",
    );
    credMock.mockResolvedValue(found());

    const out = await authCommand(["git-credential", "get"], ctx);

    expect(credMock).toHaveBeenCalledWith(
      "get",
      "protocol=https\nhost=gitlab.example.com\n\n",
    );
    // git parses this, so it must be the raw protocol - not TOON.
    expect(out).toBe(CREDENTIAL);
  });

  it("stays silent and exits non-zero when the store has nothing", async () => {
    readStdinMock.mockReturnValue(
      "protocol=https\nhost=gitlab.example.com\n\n",
    );
    credMock.mockResolvedValue(missing());

    const out = await authCommand(["git-credential", "get"], ctx);

    // A structured error here would be parsed by git as a malformed credential.
    expect(out).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it("passes store and erase through untouched", async () => {
    readStdinMock.mockReturnValue(
      "protocol=https\nhost=gitlab.example.com\n\n",
    );
    credMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    for (const op of ["store", "erase"]) {
      await authCommand(["git-credential", op], ctx);
      expect(credMock).toHaveBeenCalledWith(op, expect.any(String));
    }
  });

  it("rejects an operation git would never send", async () => {
    readStdinMock.mockReturnValue(
      "protocol=https\nhost=gitlab.example.com\n\n",
    );
    await expect(authCommand(["git-credential", "bogus"], ctx)).rejects.toThrow(
      /Unknown git-credential operation/,
    );
    expect(credMock).not.toHaveBeenCalled();
  });

  it("fails loudly when nothing was piped instead of reporting no credential", async () => {
    readStdinMock.mockReturnValue("");
    await expect(authCommand(["git-credential", "get"], ctx)).rejects.toThrow(
      /nothing was piped/,
    );
    expect(credMock).not.toHaveBeenCalled();
  });
});

describe("auth routing", () => {
  it("rejects an unknown subcommand rather than exiting 0", async () => {
    await expect(authCommand(["bogus"], ctx)).rejects.toThrow(
      /Unknown auth subcommand/,
    );
  });

  it("rejects a bare `auth` with actionable guidance", async () => {
    await expect(authCommand([], ctx)).rejects.toThrow(
      /auth requires a subcommand/,
    );
  });
});
