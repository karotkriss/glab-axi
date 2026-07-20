import { describe, it, expect } from "vitest";
import { refuseSubcommand, refusalTable } from "../src/refusals.js";
import { AxiError } from "../src/errors.js";

// The verbs each domain actually implements, read off its router. A refusal
// must never point at a command that does not exist - that is the failure mode
// this whole file guards, and the one that shipped once already (a help
// suggestion the CLI's own parser rejected).
const IMPLEMENTED: Record<string, string[]> = {
  auth: ["status", "git-credential"],
  issue: [
    "list",
    "view",
    "links",
    "create",
    "edit",
    "update",
    "close",
    "reopen",
    "comment",
  ],
  mr: [
    "list",
    "view",
    "create",
    "update",
    "edit",
    "merge",
    "approve",
    "unapprove",
    "checks",
    "diff",
    "comment",
  ],
  ci: [
    "list",
    "view",
    "status",
    "watch",
    "jobs",
    "log",
    "retry",
    "cancel",
    "run",
  ],
  project: ["list", "view", "create", "delete"],
  repo: ["create-file", "create-branch"],
  label: ["list", "create", "edit", "update", "delete", "rm"],
  variable: ["list", "get", "set", "delete"],
  secret: ["list", "set", "delete"],
  release: ["list", "view", "create", "edit", "update", "delete"],
  search: ["issues", "mrs", "projects"],
  api: [],
};

/** Every `glab-axi ...` command emitted inside a refusal's help lines. */
function suggestedCommands(): { domain: string; verb: string; cmd: string }[] {
  const found: { domain: string; verb: string; cmd: string }[] = [];
  for (const [domain, verbs] of Object.entries(refusalTable)) {
    for (const [verb, refusal] of Object.entries(verbs)) {
      for (const line of refusal.help) {
        for (const m of line.matchAll(/`glab-axi ([^`]+)`/g)) {
          found.push({ domain, verb, cmd: m[1] });
        }
      }
    }
  }
  return found;
}

describe("refuseSubcommand", () => {
  it("refuses a known gap with its reason and guidance", () => {
    try {
      refuseSubcommand("mr", "review");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AxiError);
      const e = err as AxiError;
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toContain("no review-submission concept");
      expect(e.suggestions?.join(" ")).toContain("glab-axi mr approve");
    }
  });

  it("falls back to the generic error for a genuinely unknown verb", () => {
    try {
      refuseSubcommand("label", "bogus");
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as AxiError;
      expect(e.message).toBe("Unknown label subcommand: bogus");
      expect(e.suggestions?.[0]).toContain("glab-axi label --help");
    }
  });

  it("uses a caller-supplied fallback when given one", () => {
    try {
      refuseSubcommand("search", "bogus", {
        message: "Unknown search type: bogus",
        help: ["Valid types: issues, mrs, projects"],
      });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as AxiError;
      expect(e.message).toBe("Unknown search type: bogus");
      expect(e.suggestions?.[0]).toContain("Valid types");
    }
  });

  // AXI clause 6: a usage error exits 2. Returning a rendered error string
  // exits 0, which reads as success to an agent that checks the exit code.
  it("always throws, so a refused verb can never exit 0", () => {
    for (const [domain, verbs] of Object.entries(refusalTable)) {
      for (const verb of Object.keys(verbs)) {
        expect(() => refuseSubcommand(domain, verb)).toThrow(AxiError);
      }
    }
  });
});

describe("refusal table integrity", () => {
  it("gives every refusal a reason and at least one runnable suggestion", () => {
    for (const [domain, verbs] of Object.entries(refusalTable)) {
      for (const [verb, refusal] of Object.entries(verbs)) {
        const where = `${domain} ${verb}`;
        expect(refusal.reason.length, where).toBeGreaterThan(20);
        expect(refusal.help.length, where).toBeGreaterThan(0);
        // A reason that only restates the verb teaches the agent nothing.
        expect(refusal.reason.toLowerCase(), where).not.toContain(
          "unknown subcommand",
        );
      }
    }
  });

  it("only suggests commands the CLI actually implements", () => {
    for (const { domain, verb, cmd } of suggestedCommands()) {
      const [suggestedDomain, suggestedVerb] = cmd.split(/\s+/);
      const where = `${domain} ${verb} -> ${cmd}`;
      expect(IMPLEMENTED, where).toHaveProperty(suggestedDomain);
      // `api <path>` and bare-domain forms take no subcommand.
      if (suggestedDomain === "api") continue;
      const known = IMPLEMENTED[suggestedDomain];
      if (suggestedVerb === undefined || suggestedVerb.startsWith("-"))
        continue;
      expect(known, where).toContain(suggestedVerb);
    }
  });

  it("never redirects to a verb that is itself refused", () => {
    for (const { domain, verb, cmd } of suggestedCommands()) {
      const [suggestedDomain, suggestedVerb] = cmd.split(/\s+/);
      if (!suggestedVerb || suggestedDomain === "api") continue;
      expect(
        refusalTable[suggestedDomain]?.[suggestedVerb],
        `${domain} ${verb} redirects to refused verb ${cmd}`,
      ).toBeUndefined();
    }
  });

  it("puts -R after the command in any suggestion that carries it", () => {
    for (const { domain, verb, cmd } of suggestedCommands()) {
      if (!cmd.includes("-R")) continue;
      expect(cmd.indexOf("-R"), `${domain} ${verb}`).toBeGreaterThan(
        cmd.indexOf(" "),
      );
    }
  });
});
