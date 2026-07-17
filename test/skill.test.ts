import { describe, it, expect } from "vitest";
import { createSkillMarkdown } from "../src/skill.js";
import { VERSION } from "../src/cli.js";

// The published skill is a security surface: an unpinned `npx -y glab-axi`
// fetches whatever is latest at run time, which the skills.sh audit flags as an
// unbounded remote download. Every invocation must pin the exact version, and
// the pin must track package.json so a release can never leave a stale pin.
describe("skill markdown", () => {
  const md = createSkillMarkdown();

  it("pins every npx invocation to the current version", () => {
    expect(md).toContain(`npx -y glab-axi@${VERSION}`);
    // No bare, unpinned invocation survives (the char after the name is never @).
    expect(md).not.toMatch(/npx -y glab-axi(?!@)/);
  });
});
