import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/config file is touched.
vi.mock("../src/gl.js", () => ({
  glConfigGetResult: vi.fn(() => ""),
}));

vi.mock("../src/hosts.js", () => ({
  knownHosts: () => new Set(["gitlab.example.com"]),
  configPath: () => "/home/someone/.config/glab-cli/config.yml",
}));

import { configCommand } from "../src/commands/config.js";
import { glConfigGetResult } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const readMock = glConfigGetResult as unknown as ReturnType<typeof vi.fn>;

const ctx: RepoContext = { host: "gitlab.example.com", source: "flag" };

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockReturnValue("");
});

describe("config get", () => {
  it("reports a global value and the scope that answered", () => {
    readMock.mockReturnValue("gitlab.example.com\n");

    const out = configCommand(["get", "host"], undefined);

    expect(readMock).toHaveBeenCalledWith("host", undefined);
    expect(out).toContain("key: host");
    expect(out).toContain("value: gitlab.example.com");
    expect(out).toContain("scope: global");
  });

  it("scopes the read to the host it was given", () => {
    readMock.mockReturnValue("https\n");

    const out = configCommand(["get", "git_protocol"], ctx);

    expect(readMock).toHaveBeenCalledWith("git_protocol", "gitlab.example.com");
    expect(out).toContain("scope: host gitlab.example.com");
  });

  it("points at the default host it just read, since calls without --host land there", () => {
    readMock.mockReturnValue("gitlab.example.com");

    const out = configCommand(["get", "host"], undefined);

    expect(out).toContain(
      "Any command omitting --host targets gitlab.example.com",
    );
  });

  it("states an unset key definitively rather than emitting nothing", () => {
    readMock.mockReturnValue("");

    const out = configCommand(["get", "editor"], ctx);

    expect(out).toContain("value: unset");
  });

  it("does not report a failed read as unset - they are opposite facts", () => {
    readMock.mockReturnValue(null);

    expect(() => configCommand(["get", "editor"], ctx)).toThrow(
      /Could not read configuration key/,
    );
  });
});

describe("config get credential refusal", () => {
  // The wrapped CLI answers `config get -h <host> token` with the live token,
  // so this refusal is the only thing between an agent and a leaked credential.
  it.each(["token", "TOKEN", "access_token", "token_expiry"])(
    "refuses `%s` without ever performing the read",
    (key) => {
      expect(() => configCommand(["get", key], ctx)).toThrow(
        /names a credential/,
      );
      // Refused BEFORE the read, so the value never enters the process.
      expect(readMock).not.toHaveBeenCalled();
    },
  );

  it("redirects the refusal at the verb that answers presence", () => {
    try {
      configCommand(["get", "token"], ctx);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(
        (error as { suggestions: string[] }).suggestions.join("\n"),
      ).toContain("glab-axi auth status");
    }
  });
});

describe("config routing", () => {
  it("requires a key rather than reading something arbitrary", () => {
    expect(() => configCommand(["get"], ctx)).toThrow(
      /config get requires a key/,
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown subcommand rather than exiting 0", () => {
    expect(() => configCommand(["bogus"], ctx)).toThrow(
      /Unknown config subcommand/,
    );
  });

  it("rejects a bare `config` with actionable guidance", () => {
    expect(() => configCommand([], ctx)).toThrow(
      /config requires a subcommand/,
    );
  });

  it("refuses to write, and says why", () => {
    expect(() => configCommand(["set", "host", "x"], ctx)).toThrow(
      /only reads configuration/,
    );
  });

  it("refuses a bulk dump that would carry the token", () => {
    expect(() => configCommand(["list"], ctx)).toThrow(/per-host token/);
  });
});
