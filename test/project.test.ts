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
      if (!ctx)
        throw new Error("Could not determine the target GitLab project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { projectCommand, PROJECT_HELP } from "../src/commands/project.js";
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
const NOT_FOUND = { stdout: "", stderr: "HTTP 404 Not Found", exitCode: 22 };

beforeEach(() => {
  glApiMock.mockReset();
  glApiResultMock.mockReset();
  // Default past whatever a test queues explicitly: the project is gone. The
  // delete path reads the project back after the DELETE to see whether the
  // instance purged it or merely scheduled it, and a purge is the plain case.
  glApiResultMock.mockResolvedValue(NOT_FOUND);
});

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    path_with_namespace: "group/project",
    name: "project",
    name_with_namespace: "group / project",
    description: "A sample project",
    default_branch: "main",
    visibility: "private",
    star_count: 3,
    forks_count: 1,
    open_issues_count: 5,
    last_activity_at: "2026-06-20T00:00:00Z",
    web_url: "https://gitlab.example.com/group/project",
    topics: ["a", "b"],
    archived: false,
    http_url_to_repo: "https://gitlab.example.com/group/project.git",
    ...overrides,
  };
}

describe("project view", () => {
  it("GETs the encoded project path", async () => {
    glApiMock.mockResolvedValueOnce(project());
    await projectCommand(["view"], ctx);
    expect(glApiMock.mock.calls[0][0]).toBe(`projects/${PID}`);
  });

  it("renders the detail fields with renamed keys", async () => {
    glApiMock.mockResolvedValueOnce(project());
    const out = await projectCommand(["view"], ctx);
    expect(out).toContain("project");
    expect(out).toContain("group/project");
    expect(out).toContain("default_branch: main");
    expect(out).toContain("visibility: private");
    expect(out).toContain("stars: 3");
    expect(out).toContain("forks: 1");
    expect(out).toContain("open_issues: 5");
    expect(out).toContain("https://gitlab.example.com/group/project");
  });

  it("includes project suggestions (issues/mr)", async () => {
    glApiMock.mockResolvedValueOnce(project());
    const out = await projectCommand(["view"], ctx);
    expect(out).toContain("issue list");
    expect(out).toContain("mr list");
  });

  it("throws an actionable error when the project is unresolved", async () => {
    await expect(projectCommand(["view"])).rejects.toThrow(
      "Could not determine the target GitLab project",
    );
  });
});

describe("project list", () => {
  it("requests membership projects ordered by last activity", async () => {
    glApiMock.mockResolvedValueOnce([
      project(),
      project({ path_with_namespace: "group/other" }),
    ]);
    await projectCommand(["list"], ctx);
    const path = glApiMock.mock.calls[0][0] as string;
    expect(path).toContain("projects?");
    expect(path).toContain("membership=true");
    expect(path).toContain("order_by=last_activity_at");
    expect(path).toContain("per_page=30");
  });

  it("renders a TOON list with a count line", async () => {
    glApiMock.mockResolvedValueOnce([
      project(),
      project({ path_with_namespace: "group/other" }),
    ]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("count: 2");
    expect(out).toContain("projects[2]");
    expect(out).toContain("group/project");
  });

  it("passes --search as the search= param", async () => {
    glApiMock.mockResolvedValueOnce([project()]);
    await projectCommand(["list", "--search", "platform"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("search=platform");
  });

  it("gives a definitive empty state", async () => {
    glApiMock.mockResolvedValueOnce([]);
    const out = await projectCommand(["list"], ctx);
    expect(out).toContain("projects: 0 projects found");
  });

  it("falls back to the default limit on non-numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await projectCommand(["list", "--limit", "abc"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=30");
    expect(glApiMock.mock.calls[0][0]).not.toContain("per_page=NaN");
  });

  it("honors a numeric --limit", async () => {
    glApiMock.mockResolvedValueOnce([]);
    await projectCommand(["list", "--limit", "50"], ctx);
    expect(glApiMock.mock.calls[0][0]).toContain("per_page=50");
  });
});

describe("project create", () => {
  it("refuses --clone with guidance", async () => {
    await expect(
      projectCommand(["create", "svc", "--clone"], ctx),
    ).rejects.toThrow("Cloning after create is not supported");
  });

  it("refuses --template with guidance", async () => {
    await expect(
      projectCommand(["create", "svc", "--template", "org/tpl"], ctx),
    ).rejects.toThrow("template repository is not supported");
  });

  it("rejects conflicting visibility flags", async () => {
    await expect(
      projectCommand(["create", "svc", "--public", "--private"], ctx),
    ).rejects.toThrow("single visibility");
  });

  it("requires a project name", async () => {
    await expect(projectCommand(["create"], ctx)).rejects.toThrow(
      "Missing project name",
    );
  });

  it("creates under the user's own namespace, defaulting to private", async () => {
    glApiMock.mockResolvedValueOnce({ username: "alice" }); // GET /user
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND); // GET-first check
    glApiMock.mockResolvedValueOnce(
      project({ path_with_namespace: "alice/svc", visibility: "private" }),
    ); // POST

    const out = await projectCommand(["create", "svc"], ctx);

    expect(glApiMock.mock.calls[0][0]).toBe("user");
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${encodeURIComponent("alice/svc")}`,
    );
    const post = glApiMock.mock.calls[1];
    expect(post[0]).toBe("projects");
    expect(post[1].method).toBe("POST");
    expect(post[1].rawFields).toContain("name=svc");
    expect(post[1].rawFields).toContain("path=svc");
    expect(post[1].rawFields).toContain("visibility=private");
    expect(post[1].fields).toEqual([]); // no namespace_id, no readme
    expect(out).toContain("created");
    expect(out).toContain("alice/svc");
    expect(out).toContain("visibility: private");
  });

  it("resolves a group namespace to namespace_id", async () => {
    glApiMock.mockResolvedValueOnce({ id: 42, full_path: "my-group" }); // namespaces
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce(
      project({ path_with_namespace: "my-group/svc", visibility: "internal" }),
    );

    const out = await projectCommand(
      ["create", "my-group/svc", "--internal"],
      ctx,
    );

    expect(glApiMock.mock.calls[0][0]).toBe(
      `namespaces/${encodeURIComponent("my-group")}`,
    );
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${encodeURIComponent("my-group/svc")}`,
    );
    const post = glApiMock.mock.calls[1];
    expect(post[1].fields).toContain("namespace_id=42");
    expect(post[1].rawFields).toContain("visibility=internal");
    expect(out).toContain("my-group/svc");
  });

  it("maps --readme and --description onto API fields", async () => {
    glApiMock.mockResolvedValueOnce({ username: "alice" });
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);
    glApiMock.mockResolvedValueOnce(
      project({ path_with_namespace: "alice/svc" }),
    );

    await projectCommand(
      ["create", "svc", "--readme", "--description", "Payments service"],
      ctx,
    );

    const post = glApiMock.mock.calls[1];
    expect(post[1].fields).toContain("initialize_with_readme=true");
    expect(post[1].rawFields).toContain("description=Payments service");
  });

  it("is idempotent when the project already exists (no POST)", async () => {
    glApiMock.mockResolvedValueOnce({ username: "alice" }); // GET /user
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(
        project({ path_with_namespace: "alice/svc", visibility: "private" }),
      ),
      stderr: "",
      exitCode: 0,
    });

    const out = await projectCommand(["create", "svc"], ctx);

    expect(out).toContain("already: true");
    expect(out).toContain("alice/svc");
    // Only GET /user ran; no POST to projects.
    expect(glApiMock.mock.calls.length).toBe(1);
  });

  it("gives an actionable error when the namespace is missing", async () => {
    glApiMock.mockRejectedValueOnce(new AxiError("not found", "NOT_FOUND"));
    await expect(
      projectCommand(["create", "ghost-group/svc"], ctx),
    ).rejects.toThrow("Namespace not found: ghost-group");
  });
});

describe("project delete", () => {
  it("requires a project positional", async () => {
    await expect(projectCommand(["delete", "--yes"], ctx)).rejects.toThrow(
      "Missing project",
    );
  });

  it("refuses without --yes and names the target", async () => {
    await expect(
      projectCommand(["delete", "my-group/svc"], ctx),
    ).rejects.toThrow("Refusing to delete project my-group/svc");
    expect(glApiResultMock.mock.calls.length).toBe(0);
  });

  it("suggests the --yes re-run in the refusal", async () => {
    const err = await projectCommand(["delete", "my-group/svc"], ctx).catch(
      (e) => e as AxiError,
    );
    expect(err.suggestions).toContain(
      "Re-run with --yes: `glab-axi project delete my-group/svc --yes`",
    );
  });

  it("rejects a positional that is neither an id nor a group/project path", async () => {
    await expect(
      projectCommand(["delete", "just-a-name", "--yes"], ctx),
    ).rejects.toThrow("Invalid project: just-a-name");
  });

  it("DELETEs the encoded path after confirming it exists", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    }); // GET-first
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    const encoded = encodeURIComponent("my-group/svc");
    expect(glApiResultMock.mock.calls[0][0]).toBe(`projects/${encoded}`);
    expect(glApiResultMock.mock.calls[0][1].method).toBeUndefined();
    expect(glApiResultMock.mock.calls[1][0]).toBe(`projects/${encoded}`);
    expect(glApiResultMock.mock.calls[1][1].method).toBe("DELETE");
    expect(out).toContain("deleted");
    expect(out).toContain("project: my-group/svc");
    expect(out).toContain("status: ok");
  });

  it("accepts -y as the confirmation flag", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await projectCommand(["delete", "my-group/svc", "-y"], ctx);
    expect(out).toContain("status: ok");
  });

  it("accepts both --yes and -y together without misreading -y as the target", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await projectCommand(
      ["delete", "--yes", "-y", "my-group/svc"],
      ctx,
    );
    expect(out).toContain("status: ok");
    expect(out).toContain("project: my-group/svc");
  });

  it("accepts -y before --yes in the same call", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await projectCommand(
      ["delete", "-y", "--yes", "my-group/svc"],
      ctx,
    );
    expect(out).toContain("status: ok");
    expect(out).toContain("project: my-group/svc");
  });

  it("addresses a numeric id directly, unencoded", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const out = await projectCommand(["delete", "1234", "--yes"], ctx);

    expect(glApiResultMock.mock.calls[0][0]).toBe("projects/1234");
    expect(glApiResultMock.mock.calls[1][0]).toBe("projects/1234");
    // TOON quotes a numeric-looking string, keeping the id a string not a number.
    expect(out).toContain('project: "1234"');
  });

  it("takes the host from a host-qualified positional", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // No -R: the positional's own host targets the request.
    const out = await projectCommand([
      "delete",
      "gitlab.other.com/my-group/svc",
      "--yes",
    ]);

    expect(glApiResultMock.mock.calls[0][1].ctx).toMatchObject({
      host: "gitlab.other.com",
      project: "my-group/svc",
    });
    expect(out).toContain("project: my-group/svc");
  });

  it("lets an explicit -R host win over the positional's host", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await projectCommand(
      ["delete", "gitlab.other.com/my-group/svc", "--yes"],
      ctx, // source: "flag", host: gitlab.example.com
    );

    expect(glApiResultMock.mock.calls[0][1].ctx).toMatchObject({
      host: "gitlab.example.com",
      project: "my-group/svc",
    });
  });

  it("is a no-op when the project is already absent (no DELETE)", async () => {
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND);

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("already_absent: true");
    expect(glApiResultMock.mock.calls.length).toBe(1); // GET only
  });

  it("throws a scrubbed error when the lookup fails for a non-404 reason", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 403 Forbidden",
      exitCode: 22,
    });
    await expect(
      projectCommand(["delete", "my-group/svc", "--yes"], ctx),
    ).rejects.toThrow("HTTP 403 Forbidden");
  });

  it("throws when the DELETE itself fails", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 403 Forbidden",
      exitCode: 22,
    });
    await expect(
      projectCommand(["delete", "my-group/svc", "--yes"], ctx),
    ).rejects.toThrow("HTTP 403 Forbidden");
  });

  // The instance, not the caller, decides whether a delete purges or defers.
  // `status` must be read back from the server rather than asserted, so these
  // pin the outcome to what the read-back actually said.
  it("reports scheduled, not ok, when the instance only marked the project", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project({ id: 571 })),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE
    // Read-back by numeric id: the project survives, renamed and marked.
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(
        project({
          id: 571,
          path_with_namespace: "my-group/svc-deletion_scheduled-571",
          marked_for_deletion_on: "2026-07-15",
        }),
      ),
      stderr: "",
      exitCode: 0,
    });

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: scheduled");
    expect(out).toContain("purge_after: 2026-07-15");
    expect(out).not.toContain("status: ok");
    // Read back by id, because the DELETE renamed the path out from under us.
    expect(glApiResultMock.mock.calls[2][0]).toBe("projects/571");
  });

  it("reports ok when the instance really purged the project", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project({ id: 571 })),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE
    glApiResultMock.mockResolvedValueOnce(NOT_FOUND); // read-back: really gone

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: ok");
    expect(out).not.toContain("scheduled");
  });

  // A failed read-back (500, auth, timeout, ...) must not be reported the same
  // as a confirmed purge - that would reintroduce the exact "confident lie"
  // this command's read-back exists to prevent.
  it("reports unknown, not ok, when the read-back fails for a non-404 reason", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project({ id: 571 })),
      stderr: "",
      exitCode: 0,
    }); // GET-first
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "HTTP 500 Internal Server Error",
      exitCode: 22,
    }); // read-back fails for a reason other than "not found"

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: unknown");
    expect(out).not.toContain("status: ok");
    expect(out).not.toContain("scheduled");
    expect(out).toContain("HTTP 500 Internal Server Error");
  });

  it("scrubs the wrapped CLI's name out of an unverifiable read-back reason", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project({ id: 571 })),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "glab: something failed",
      exitCode: 1,
    });

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: unknown");
    expect(out).not.toMatch(/\bglab\b(?!-axi)/i);
  });

  it("reports unknown when no numeric id was captured before deletion", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    }); // GET-first returns an unparseable body
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }); // DELETE

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: unknown");
    expect(out).not.toContain("status: ok");
    // No numeric id was captured, so no read-back call could even be made.
    expect(glApiResultMock.mock.calls.length).toBe(2);
  });

  it("is a no-op on an already-marked project (no second DELETE)", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(
        project({ id: 571, marked_for_deletion_on: "2026-07-15" }),
      ),
      stderr: "",
      exitCode: 0,
    });

    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);

    expect(out).toContain("status: scheduled");
    expect(out).toContain("already: true");
    expect(glApiResultMock.mock.calls.length).toBe(1); // GET only, no DELETE
  });

  it("suggests project list, without a -R naming the deleted project", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: JSON.stringify(project()),
      stderr: "",
      exitCode: 0,
    });
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const out = await projectCommand(["delete", "my-group/svc", "--yes"], ctx);
    expect(out).toContain("glab-axi project list");
    expect(out).not.toContain("-R my-group/svc");
  });
});

describe("project router", () => {
  it("returns help for no subcommand", async () => {
    const out = await projectCommand([], ctx);
    expect(out).toBe(PROJECT_HELP);
    expect(out).toContain("usage: glab-axi project");
  });

  it("errors on an unknown subcommand", async () => {
    await expect(projectCommand(["bogus"], ctx)).rejects.toThrow(
      "Unknown project subcommand",
    );
  });
});
