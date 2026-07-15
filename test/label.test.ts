import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network is touched.
vi.mock("../src/gl.js", () => {
  const glApi = vi.fn();
  return {
    glApi,
    // `glApiList` is `glApi` plus GitLab's X-Total header. Delegate so the path
    // and rendering assertions below stay meaningful, and override it per-test
    // to exercise the total. Real header parsing is covered in gl.test.ts.
    glApiList: vi.fn(async (path: string, opts?: unknown) => ({
      data: (await glApi(path, opts)) ?? [],
      total: null,
    })),
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

import { labelCommand } from "../src/commands/label.js";
import { glApi, glApiResult } from "../src/gl.js";
import { AxiError } from "../src/errors.js";
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

function label(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "bug",
    color: "#d9534f",
    description: "Something is broken",
    text_color: "#FFFFFF",
    ...overrides,
  };
}

describe("label edit", () => {
  it("PUTs the changed fields and renders the response, not the request", async () => {
    glApiMock.mockResolvedValueOnce(
      label({ name: "bug", color: "#ed9121", description: "Broken behaviour" }),
    );
    const out = await labelCommand(
      [
        "edit",
        "bug",
        "--color",
        "#ed9121",
        "--description",
        "Broken behaviour",
      ],
      ctx,
    );
    const [path, opts] = glApiMock.mock.calls[0];
    expect(path).toBe(`projects/${PID}/labels/bug`);
    expect(opts.method).toBe("PUT");
    expect(opts.rawFields).toEqual([
      "color=#ed9121",
      "description=Broken behaviour",
    ]);
    expect(out).toContain("updated:");
    expect(out).toContain("#ed9121");
  });

  it("maps --name to GitLab's new_name (a rename, not the addressed label)", async () => {
    glApiMock.mockResolvedValueOnce(label({ name: "defect" }));
    await labelCommand(["edit", "bug", "--name", "defect"], ctx);
    const [path, opts] = glApiMock.mock.calls[0];
    expect(path).toBe(`projects/${PID}/labels/bug`);
    expect(opts.rawFields).toEqual(["new_name=defect"]);
  });

  it("url-encodes a label name with a slash", async () => {
    glApiMock.mockResolvedValueOnce(label({ name: "type::bug" }));
    await labelCommand(["edit", "type/bug", "--color", "#fff"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(
      `projects/${PID}/labels/type%2Fbug`,
    );
  });

  it("refuses an edit with nothing to change, before any API call", async () => {
    await expect(labelCommand(["edit", "bug"], ctx)).rejects.toThrow(
      "Nothing to edit",
    );
    expect(glApiMock).not.toHaveBeenCalled();
  });

  it("requires a label name", async () => {
    await expect(
      labelCommand(["edit", "--color", "#fff"], ctx),
    ).rejects.toThrow("Missing label name");
    expect(glApiMock).not.toHaveBeenCalled();
  });
});

describe("label list", () => {
  it("requests labels and renders a TOON list with a count", async () => {
    glApiMock.mockResolvedValueOnce([
      label(),
      label({ id: 2, name: "feature" }),
    ]);
    const out = await labelCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain(`projects/${PID}/labels`);
    expect(path).toContain("per_page=100");
    expect(out).toContain("count: 2");
    expect(out).toContain("labels[2]");
    expect(out).toContain("bug");
  });

  it("defaults the limit to 100", async () => {
    glApiMock.mockResolvedValueOnce([label()]);
    await labelCommand(["list"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=100");
  });

  it("falls back to default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await labelCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=100");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("honors a numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([label()]);
    await labelCommand(["list", "--limit", "25"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=25");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await labelCommand(["list"], ctx);
    expect(out).toContain("labels: 0 labels found");
  });
});

describe("label create", () => {
  it("requires --name", async () => {
    await expect(
      labelCommand(["create", "--color", "#ed9121"], ctx),
    ).rejects.toThrow("--name is required");
  });

  it("requires --color", async () => {
    await expect(
      labelCommand(["create", "--name", "bug"], ctx),
    ).rejects.toThrow("--color is required");
  });

  it("POSTs name and color via rawFields", async () => {
    glApiMock.mockResolvedValueOnce(label({ name: "bug", color: "#ed9121" }));
    const out = await labelCommand(
      [
        "create",
        "--name",
        "bug",
        "--color",
        "#ed9121",
        "--description",
        "broken",
      ],
      ctx,
    );
    const call = glApiMock.mock.calls[0];
    expect(call[0]).toBe(`projects/${PID}/labels`);
    expect(call[1].method).toBe("POST");
    expect(call[1].rawFields).toContain("name=bug");
    expect(call[1].rawFields).toContain("color=#ed9121");
    expect(call[1].rawFields).toContain("description=broken");
    expect(out).toContain("created");
    expect(out).toContain("bug");
  });

  it("is idempotent when the label already exists", async () => {
    glApiMock.mockRejectedValueOnce(
      new AxiError("Label already exists", "CONFLICT"),
    );
    const out = await labelCommand(
      ["create", "--name", "bug", "--color", "#ed9121"],
      ctx,
    );
    expect(out).toContain("already: true");
    expect(out).toContain("bug");
  });
});

describe("label delete", () => {
  it("DELETEs the encoded label name", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await labelCommand(["delete", "needs review"], ctx);
    const call = glApiResultMock.mock.calls[0];
    expect(call[0]).toBe(
      `projects/${PID}/labels/${encodeURIComponent("needs review")}`,
    );
    expect(call[1].method).toBe("DELETE");
    expect(out).toContain("deleted");
    expect(out).toContain("status: ok");
  });

  it("requires a label name", async () => {
    await expect(labelCommand(["delete"], ctx)).rejects.toThrow(
      "Missing label name",
    );
  });

  it("is idempotent on a 404 (already absent)", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 404 Not Found",
      exitCode: 22,
    });
    const out = await labelCommand(["delete", "ghost"], ctx);
    expect(out).toContain("already_absent: true");
    expect(out).toContain("ghost");
  });
});

describe("label router", () => {
  it("returns help for no subcommand", async () => {
    const out = await labelCommand([], ctx);
    expect(out).toContain("usage: glab-axi label");
  });

  it("errors on unknown subcommand", async () => {
    await expect(labelCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown label subcommand",
    );
  });
});
