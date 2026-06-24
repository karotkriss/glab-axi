import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoContext } from "../src/context.js";
import { AxiError } from "../src/errors.js";

// Mock the glab executor so tests never shell out. projectId is kept real-ish.
vi.mock("../src/gl.js", () => ({
  glApi: vi.fn(),
  glExec: vi.fn(),
  glRaw: vi.fn(),
  projectId: (ctx: RepoContext) => encodeURIComponent(ctx.project),
}));

import { glApi } from "../src/gl.js";
import { labelCommand } from "../src/commands/label.js";

const ctx: RepoContext = {
  project: "group/proj",
  host: "dev.egov.gy",
  source: "flag",
};
const api = vi.mocked(glApi);

beforeEach(() => api.mockReset());

const bug = {
  id: 10,
  name: "bug",
  color: "#d9534f",
  description: "Something is broken",
  open_issues_count: 3,
};
const feature = {
  id: 11,
  name: "feature",
  color: "#5cb85c",
  description: "New capability",
  open_issues_count: 1,
};

describe("label list", () => {
  it("renders list TOON with count and help", async () => {
    api.mockResolvedValueOnce([bug, feature]);
    const out = await labelCommand(["list"], ctx);
    expect(out).toContain("count: 2");
    expect(out).toContain("labels[2]{name,color,description}:");
    expect(out).toContain("bug,#d9534f,Something is broken");
    expect(out).toContain("feature,#5cb85c,New capability");
    expect(out).toContain("help[2]:");
  });

  it("hits the labels endpoint with the limit", async () => {
    api.mockResolvedValueOnce([bug]);
    await labelCommand(["list", "--limit", "50"], ctx);
    const calledPath = api.mock.calls[0][0] as string;
    expect(calledPath).toContain("labels?per_page=50");
  });

  it("gives a definitive empty state", async () => {
    api.mockResolvedValueOnce([]);
    const out = await labelCommand(["list"], ctx);
    expect(out).toContain("count: 0");
    expect(out).toContain("to add one");
  });
});

describe("label create", () => {
  it("requires --name", async () => {
    await expect(
      labelCommand(["create", "--color", "#fff"], ctx),
    ).rejects.toThrow(/--name is required/);
  });

  it("requires --color", async () => {
    await expect(
      labelCommand(["create", "--name", "bug"], ctx),
    ).rejects.toThrow(/--color is required/);
  });

  it("creates a new label via POST", async () => {
    api.mockResolvedValueOnce([]); // existing labels: none
    api.mockResolvedValueOnce({ ...bug }); // POST result
    const out = await labelCommand(
      [
        "create",
        "--name",
        "bug",
        "--color",
        "#d9534f",
        "--description",
        "Something is broken",
      ],
      ctx,
    );
    expect(api).toHaveBeenCalledTimes(2);
    const postCall = api.mock.calls[1];
    expect(postCall[0]).toContain("/labels");
    const opts = postCall[1] as {
      method: string;
      fields: Record<string, string>;
    };
    expect(opts.method).toBe("POST");
    expect(opts.fields.name).toBe("bug");
    expect(opts.fields.color).toBe("#d9534f");
    expect(out).toContain("created:");
  });

  it("is idempotent when the label already exists (no POST issued)", async () => {
    // Existing label matches case-insensitively.
    api.mockResolvedValueOnce([{ ...bug, name: "Bug" }]);
    const out = await labelCommand(
      ["create", "--name", "bug", "--color", "#d9534f"],
      ctx,
    );
    expect(api).toHaveBeenCalledTimes(1); // only the GET, no POST
    expect(out).toContain("already exists");
  });
});

describe("label delete", () => {
  it("deletes a label", async () => {
    api.mockResolvedValueOnce(undefined);
    const out = await labelCommand(["delete", "bug"], ctx);
    const call = api.mock.calls[0];
    expect(call[0]).toContain("/labels/bug");
    expect((call[1] as { method: string }).method).toBe("DELETE");
    expect(out).toContain("deleted");
  });

  it("is idempotent when the label is already gone (404)", async () => {
    api.mockRejectedValueOnce(new AxiError("Resource not found", "NOT_FOUND"));
    const out = await labelCommand(["delete", "ghost"], ctx);
    expect(out).toContain("already deleted");
  });

  it("requires a name positional", async () => {
    await expect(labelCommand(["delete"], ctx)).rejects.toThrow(
      /name is required/,
    );
  });
});

describe("label help", () => {
  it("returns help with no subcommand", async () => {
    const out = await labelCommand([], ctx);
    expect(out).toContain("usage: glab-axi label");
  });
});
