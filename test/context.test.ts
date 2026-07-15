import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the known-host lookup so these never read the machine's real glab config.
vi.mock("../src/hosts.js", () => ({ knownHosts: vi.fn() }));

import { parseRepoArg } from "../src/context.js";
import { knownHosts } from "../src/hosts.js";

const knownHostsMock = knownHosts as unknown as ReturnType<typeof vi.fn>;

function configured(...hosts: string[]) {
  knownHostsMock.mockReturnValue(new Set(hosts));
}

describe("parseRepoArg", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configured("gitlab.com", "dev.egov.gy");
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
    expect(parseRepoArg("dev.egov.gy/my-project", "flag")).toEqual({
      host: undefined,
      project: "dev.egov.gy/my-project",
      source: "flag",
    });
  });

  it("leads with a host when the first segment is a known host", () => {
    expect(
      parseRepoArg("dev.egov.gy/christopher.mckay/my-project", "flag"),
    ).toEqual({
      host: "dev.egov.gy",
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
    expect(parseRepoArg("dev.egov.gy/group/subgroup/project", "flag")).toEqual({
      host: "dev.egov.gy",
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
    expect(parseRepoArg("dev.egov.gy", "flag")).toBeUndefined();
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
