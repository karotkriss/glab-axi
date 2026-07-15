import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownHosts } from "../src/hosts.js";

// A fake token, shaped like a real one. NEVER put a real token in a fixture.
const FAKE_TOKEN = "glpat-0000000000FAKEfixture";

let dir: string;
let warnings: string[];

/**
 * The config holds the API token, so nothing from it may reach stderr. A yaml
 * warning quotes the source line it is unhappy about, and reaches stderr through
 * process.emitWarning - so capturing emitted warnings catches the leak before it
 * is printed. Zero warnings emitted means zero printed.
 */
function captureWarnings() {
  warnings = [];
  const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
  process.on("warning", onWarning);
  return () => process.off("warning", onWarning);
}

/** Warnings are emitted on the next tick; let them land before asserting. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function writeConfig(body: string) {
  writeFileSync(join(dir, "config.yml"), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glab-axi-hosts-"));
  process.env["GLAB_CONFIG_DIR"] = dir;
  delete process.env["GITLAB_HOST"];
});

afterEach(() => {
  delete process.env["GLAB_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

describe("knownHosts config parsing", () => {
  it("never lets the token reach stderr when yaml cannot resolve its tag", async () => {
    // The real-world shape: glab wrote `token: !!null <value>`, whose tag yaml
    // cannot resolve. It warns - quoting the token's own line.
    writeConfig(
      `hosts:\n    gitlab.example.com:\n        api_host: gitlab.example.com\n        token: !!null ${FAKE_TOKEN}\n`,
    );
    const stop = captureWarnings();
    try {
      expect(knownHosts()).toEqual(new Set(["gitlab.example.com"]));
      await settle();
    } finally {
      stop();
    }
    expect(warnings).toEqual([]);
    expect(warnings.join("\n")).not.toContain(FAKE_TOKEN);
  });

  it("silences the warning channel, not just the one tag that triggered it", async () => {
    // Any future unresolvable construct on the token line would leak it again,
    // so the channel is what must be silent - not this one trigger.
    writeConfig(
      `hosts:\n    gitlab.example.com:\n        token: !!nonsensetag ${FAKE_TOKEN}\n`,
    );
    const stop = captureWarnings();
    try {
      knownHosts();
      await settle();
    } finally {
      stop();
    }
    expect(warnings).toEqual([]);
    expect(warnings.join("\n")).not.toContain(FAKE_TOKEN);
  });

  it("reports no hosts for a malformed config rather than inventing them", () => {
    // Guards the silencing: logLevel "silent" would also stop parse() throwing,
    // so broken yaml would return a half-parsed object and become a host list.
    writeConfig(`hosts:\n  a: 1\n \t badindent: 2\n  - x\n`);
    expect(knownHosts()).toEqual(new Set());
  });

  it("reads hosts from a well-formed config", () => {
    writeConfig(
      `hosts:\n    gitlab.example.com:\n        token: ${FAKE_TOKEN}\n    gitlab.internal:\n        token: ${FAKE_TOKEN}\n`,
    );
    expect(knownHosts()).toEqual(
      new Set(["gitlab.example.com", "gitlab.internal"]),
    );
  });
});
