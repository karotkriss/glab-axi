import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the known-host lookup so these never read the machine's real glab config.
vi.mock("../src/hosts.js", () => ({ knownHosts: vi.fn() }));
// Mock both sides of remote resolution: the git remote lookup and the CLI's
// per-host config probe. No real git repo or glab config is touched.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("../src/gl.js", () => ({ glConfigGet: vi.fn() }));

import { execFileSync } from "node:child_process";
import { glConfigGet } from "../src/gl.js";
import { glNotInstalledError } from "../src/errors.js";
import { parseRepoArg, resolveRepo, parseRemoteUrl } from "../src/context.js";
import { knownHosts } from "../src/hosts.js";

const knownHostsMock = knownHosts as unknown as ReturnType<typeof vi.fn>;
const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const configMock = glConfigGet as unknown as ReturnType<typeof vi.fn>;

function configured(...hosts: string[]) {
  knownHostsMock.mockReturnValue(new Set(hosts));
}

/** Hosts the CLI is configured for; anything else reads back "". */
function configuredHosts(...hosts: string[]) {
  configMock.mockImplementation((_key: string, host: string) =>
    hosts.includes(host) ? host : "",
  );
}

describe("parseRepoArg", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configured("gitlab.com", "dev.example.gy");
  });

  it("resolves a dotted namespace as group/project, not as a host", () => {
    // The bug: "christopher.mckay" was eaten as a hostname, leaving one
    // segment, which failed the length guard and returned undefined.
    expect(parseRepoArg("christopher.mckay/my-project", "flag")).toEqual({
      host: undefined,
      project: "christopher.mckay/my-project",
      source: "flag",
    });
  });

  it("never reads a host out of a two-segment value", () => {
    expect(parseRepoArg("dev.example.gy/my-project", "flag")).toEqual({
      host: undefined,
      project: "dev.example.gy/my-project",
      source: "flag",
    });
  });

  it("leads with a host when the first segment is a known host", () => {
    expect(
      parseRepoArg("dev.example.gy/christopher.mckay/my-project", "flag"),
    ).toEqual({
      host: "dev.example.gy",
      project: "christopher.mckay/my-project",
      source: "flag",
    });
  });

  it("leads with a bare configured hostname that has no dot to find", () => {
    configured("gitlab");
    expect(parseRepoArg("gitlab/group/project", "flag")).toEqual({
      host: "gitlab",
      project: "group/project",
      source: "flag",
    });
  });

  it("still leads with a dotted host we are not configured for", () => {
    // Reachable via GITLAB_TOKEN without a config entry, so it must keep working.
    configured("gitlab.com");
    expect(parseRepoArg("gitlab.other.com/group/project", "flag")).toEqual({
      host: "gitlab.other.com",
      project: "group/project",
      source: "flag",
    });
  });

  it("supports nested group paths", () => {
    expect(parseRepoArg("group/subgroup/project", "flag")).toEqual({
      host: undefined,
      project: "group/subgroup/project",
      source: "flag",
    });
    expect(
      parseRepoArg("dev.example.gy/group/subgroup/project", "flag"),
    ).toEqual({
      host: "dev.example.gy",
      project: "group/subgroup/project",
      source: "flag",
    });
  });

  it("falls back to the shape check when nothing is configured", () => {
    // A token-only CI runner: no config and no GITLAB_HOST to consult.
    configured();
    expect(parseRepoArg("gitlab.example.com/group/project", "flag")).toEqual({
      host: "gitlab.example.com",
      project: "group/project",
      source: "flag",
    });
    expect(parseRepoArg("christopher.mckay/my-project", "flag")).toEqual({
      host: undefined,
      project: "christopher.mckay/my-project",
      source: "flag",
    });
  });

  it("rejects a value with no namespace", () => {
    expect(parseRepoArg("project", "flag")).toBeUndefined();
    expect(parseRepoArg("dev.example.gy", "flag")).toBeUndefined();
    expect(parseRepoArg("", "flag")).toBeUndefined();
  });

  it("tolerates surrounding slashes", () => {
    expect(parseRepoArg("/christopher.mckay/my-project/", "flag")).toEqual({
      host: undefined,
      project: "christopher.mckay/my-project",
      source: "flag",
    });
  });
});

describe("resolveRepo from a git remote", () => {
  beforeEach(() => {
    execMock.mockReset();
    configMock.mockReset();
    delete process.env["GITLAB_HOST"];
  });

  afterEach(() => {
    delete process.env["GITLAB_HOST"];
  });

  it("resolves a remote on a configured GitLab host", () => {
    execMock.mockReturnValue("git@gitlab.example.com:group/project.git\n");
    configuredHosts("gitlab.example.com");

    expect(resolveRepo()).toEqual({
      host: "gitlab.example.com",
      project: "group/project",
      source: "git",
    });
  });

  // The bug this guards: any forge's remote parsed cleanly and was reported as
  // a GitLab project that never existed.
  it.each([
    ["github.com", "git@github.com:karotkriss/glab-axi.git"],
    ["bitbucket.org", "git@bitbucket.org:someteam/someproj.git"],
    ["https github", "https://github.com/karotkriss/glab-axi.git"],
  ])("does not resolve a %s remote as a GitLab project", (_label, url) => {
    execMock.mockReturnValue(`${url}\n`);
    configuredHosts("gitlab.example.com", "dev.example.gy");

    expect(resolveRepo()).toBeUndefined();
  });

  // GITLAB_HOST only overrides an already-resolved project's host. It must not
  // launder a foreign remote into a GitLab project: this is the audit's
  // decisive case, where a GitHub checkout aimed at a real GitLab host printed
  // a confident "0 open" for a project that was never there.
  it("does not let GITLAB_HOST validate a foreign remote", () => {
    execMock.mockReturnValue("git@github.com:karotkriss/glab-axi.git\n");
    configuredHosts("dev.example.gy");
    process.env["GITLAB_HOST"] = "dev.example.gy";

    expect(resolveRepo()).toBeUndefined();
  });

  // Covers a token-from-environment setup (e.g. CI) that has no config file.
  it("accepts a remote whose host GITLAB_HOST names explicitly", () => {
    execMock.mockReturnValue("git@gitlab.internal:group/project.git\n");
    configuredHosts(); // nothing configured on disk
    process.env["GITLAB_HOST"] = "gitlab.internal";

    expect(resolveRepo()).toMatchObject({
      host: "gitlab.internal",
      project: "group/project",
    });
  });

  it("resolves nothing when there is no remote", () => {
    execMock.mockImplementation(() => {
      throw new Error("no origin");
    });

    expect(resolveRepo()).toBeUndefined();
  });

  // A missing glab binary must reach the caller as an actionable error, not be
  // swallowed by this function's catch-all into a misleading "no project".
  it("propagates a not-installed error instead of resolving to no project", () => {
    execMock.mockReturnValue("git@gitlab.example.com:group/project.git\n");
    configMock.mockImplementation(() => {
      throw glNotInstalledError();
    });

    expect(() => resolveRepo()).toThrow("GitLab CLI is not installed");
  });

  it("does not probe the host config for an explicit -R target", () => {
    expect(resolveRepo("dev.example.gy/group/project")).toMatchObject({
      host: "dev.example.gy",
      project: "group/project",
      source: "flag",
    });
    expect(configMock).not.toHaveBeenCalled();
  });
});

describe("parseRemoteUrl", () => {
  // Stays a pure parser: host validation belongs at the resolution boundary,
  // so this keeps answering "what does this URL say" for any host.
  it("parses a URL without judging its host", () => {
    expect(parseRemoteUrl("git@bitbucket.org:someteam/someproj.git")).toEqual({
      host: "bitbucket.org",
      project: "someteam/someproj",
      source: "git",
    });
  });
});
