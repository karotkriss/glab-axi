import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gl executor so no real glab/network/jq is touched.
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
    runJq: vi.fn(),
    projectId: (ctx?: { project: string }) =>
      ctx ? encodeURIComponent(ctx.project) : "{project}",
    requireProject: (ctx?: { project: string }) => {
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
    errorBody: (result: { stderr: string; stdout: string }) =>
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
  };
});

import { apiCommand, API_HELP } from "../src/commands/api.js";
import { glApiResult, runJq } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
const runJqMock = runJq as unknown as ReturnType<typeof vi.fn>;
const ctx: RepoContext = {
  host: "gitlab.example.com",
  project: "group/project",
  source: "flag",
};
const PID = encodeURIComponent("group/project");

function ok(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

beforeEach(() => {
  glApiResultMock.mockReset();
  runJqMock.mockReset();
});

describe("api method + path parsing", () => {
  it("defaults to GET when no method positional is given", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(["projects/{project}/members"], ctx);
    const [path, opts] = glApiResultMock.mock.calls[0];
    expect(opts.method).toBe("GET");
    expect(path).toBe(`projects/${PID}/members`);
  });

  it("parses an explicit POST method positional", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 7 }));
    await apiCommand(["POST", "projects/{project}/issues"], ctx);
    const [path, opts] = glApiResultMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(path).toBe(`projects/${PID}/issues`);
  });

  it("accepts a lowercase method positional", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ ok: true }));
    await apiCommand(["delete", "projects/{project}/labels/5"], ctx);
    expect(glApiResultMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("parses the path even when a --field value precedes it", async () => {
    glApiResultMock.mockResolvedValueOnce(ok([]));
    await apiCommand(
      ["--field", "state=opened", "projects/{project}/merge_requests"],
      ctx,
    );
    const [path, opts] = glApiResultMock.mock.calls[0];
    expect(path).toBe(`projects/${PID}/merge_requests`);
    expect(opts.fields).toEqual(["state=opened"]);
  });

  it("replaces the {project} placeholder with the encoded project id", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({}));
    await apiCommand(["projects/{project}/repository/branches"], ctx);
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/repository/branches`,
    );
  });
});

describe("api flag passthrough", () => {
  it("passes --field values as the fields array", async () => {
    glApiResultMock.mockResolvedValueOnce(ok([]));
    await apiCommand(
      [
        "projects/{project}/issues",
        "--field",
        "state=opened",
        "--field",
        "per_page=5",
      ],
      ctx,
    );
    const opts = glApiResultMock.mock.calls[0][1];
    expect(opts.fields).toEqual(["state=opened", "per_page=5"]);
  });

  it("passes --raw-field values as the rawFields array", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 1 }));
    await apiCommand(
      ["POST", "projects/{project}/issues", "--raw-field", "title=Bug"],
      ctx,
    );
    expect(glApiResultMock.mock.calls[0][1].rawFields).toEqual(["title=Bug"]);
  });

  it("passes --header values as the headers array", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({}));
    await apiCommand(
      [
        "projects/{project}",
        "--header",
        "X-Test:1",
        "--header",
        "Accept:application/json",
      ],
      ctx,
    );
    expect(glApiResultMock.mock.calls[0][1].headers).toEqual([
      "X-Test:1",
      "Accept:application/json",
    ]);
  });

  it("passes --paginate as a boolean option", async () => {
    glApiResultMock.mockResolvedValueOnce(ok([]));
    await apiCommand(["projects/{project}/members", "--paginate"], ctx);
    expect(glApiResultMock.mock.calls[0][1].paginate).toBe(true);
  });
});

describe("api response cleaning", () => {
  it("strips noisy fields like avatar_url and web_url from JSON", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({
        id: 99,
        name: "octo",
        avatar_url: "https://gitlab.example.com/avatar.png",
        web_url: "https://gitlab.example.com/group/project",
      }),
    );
    const out = await apiCommand(["projects/{project}"], ctx);
    expect(out).toContain("id: 99");
    expect(out).toContain("name: octo");
    expect(out).not.toContain("avatar_url");
    expect(out).not.toContain("web_url");
  });

  it("drops every key ending in _url", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({ id: 1, http_url_to_repo: "x", custom_url: "y", title: "t" }),
    );
    const out = await apiCommand(["projects/{project}"], ctx);
    expect(out).toContain("title: t");
    expect(out).not.toContain("custom_url");
    expect(out).not.toContain("http_url_to_repo");
  });

  it("collapses an author object to its username", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({ iid: 3, author: { id: 5, username: "alice", avatar_url: "x" } }),
    );
    const out = await apiCommand(["projects/{project}/issues/3"], ctx);
    expect(out).toContain("author: alice");
    expect(out).not.toContain("avatar_url");
  });

  it("recurses into arrays", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok([
        { id: 1, web_url: "a", name: "one" },
        { id: 2, web_url: "b", name: "two" },
      ]),
    );
    const out = await apiCommand(["projects/{project}/members"], ctx);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).not.toContain("web_url");
  });
});

describe("api non-JSON responses", () => {
  it("wraps a short raw blob in an api_response envelope", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "plain text body",
      stderr: "",
      exitCode: 0,
    });
    const out = await apiCommand(["projects/{project}/raw"], ctx);
    expect(out).toContain("api_response");
    expect(out).toContain("plain text body");
    expect(out).toContain("truncated: false");
  });

  it("truncates an over-4000-char raw body and flags it", async () => {
    const big = "x".repeat(5000);
    glApiResultMock.mockResolvedValueOnce({
      stdout: big,
      stderr: "",
      exitCode: 0,
    });
    const out = await apiCommand(["projects/{project}/raw"], ctx);
    expect(out).toContain("api_response");
    expect(out).toContain("truncated: true");
    expect(out).toContain("original_length: 5000");
  });
});

describe("api errors and help", () => {
  it("throws when no path is provided", async () => {
    await expect(apiCommand(["--paginate"], ctx)).rejects.toThrow(
      "API path is required",
    );
  });

  it("rejects a lone HTTP method with no path (does not GET a path named 'POST')", async () => {
    await expect(apiCommand(["POST"], ctx)).rejects.toThrow(
      "API path is required",
    );
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("throws a mapped error when the request exits non-zero", async () => {
    glApiResultMock.mockResolvedValueOnce({
      stdout: "",
      stderr: '{"message":"404 Project Not Found"}',
      exitCode: 1,
    });
    await expect(apiCommand(["projects/{project}"], ctx)).rejects.toThrow(
      "404 Project Not Found",
    );
  });

  it("returns API_HELP for --help", async () => {
    const out = await apiCommand(["--help"], ctx);
    expect(out).toBe(API_HELP);
    expect(out).toContain("usage: glab-axi api");
  });

  it("returns API_HELP when no args are given", async () => {
    const out = await apiCommand([], ctx);
    expect(out).toBe(API_HELP);
  });
});

describe("api --jq extraction", () => {
  function jqOk(stdout: string) {
    return { stdout, stderr: "", exitCode: 0 };
  }

  it("extracts a single field and trims the trailing newline", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({ iid: 5, state: "opened", web_url: "x" }),
    );
    runJqMock.mockResolvedValueOnce(jqOk("opened\n"));
    const out = await apiCommand(
      ["projects/{project}/merge_requests/5", "--jq", ".state"],
      ctx,
    );
    expect(out).toBe("opened");
    const [input, expr] = runJqMock.mock.calls[0];
    expect(expr).toBe(".state");
    // jq receives the RAW response, noisy fields intact, not the TOON view.
    expect(JSON.parse(input)).toEqual({
      iid: 5,
      state: "opened",
      web_url: "x",
    });
  });

  it("preserves internal newlines (e.g. .[] over an array)", async () => {
    glApiResultMock.mockResolvedValueOnce(ok([{ name: "a" }, { name: "b" }]));
    runJqMock.mockResolvedValueOnce(jqOk("a\nb\n"));
    const out = await apiCommand(
      ["projects/{project}/members", "--jq", ".[].name"],
      ctx,
    );
    expect(out).toBe("a\nb");
  });

  it("accepts the --jq=<expr> form", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ state: "merged" }));
    runJqMock.mockResolvedValueOnce(jqOk("merged\n"));
    await apiCommand(["projects/{project}/x", "--jq=.state"], ctx);
    expect(runJqMock.mock.calls[0][1]).toBe(".state");
  });

  it("does not misread the jq expression as the path when it precedes it", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ state: "opened" }));
    runJqMock.mockResolvedValueOnce(jqOk("opened\n"));
    await apiCommand(
      ["--jq", ".state", "projects/{project}/merge_requests/5"],
      ctx,
    );
    expect(glApiResultMock.mock.calls[0][0]).toBe(
      `projects/${PID}/merge_requests/5`,
    );
  });

  it("takes precedence over --raw when both are passed", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ state: "opened" }));
    runJqMock.mockResolvedValueOnce(jqOk("opened\n"));
    const out = await apiCommand(
      ["projects/{project}/x", "--raw", "--jq", ".state"],
      ctx,
    );
    expect(out).toBe("opened");
    expect(runJqMock).toHaveBeenCalledTimes(1);
  });

  it("throws a validation error when --jq has no expression", async () => {
    await expect(
      apiCommand(["projects/{project}/x", "--jq"], ctx),
    ).rejects.toThrow("--jq flag requires an expression");
    expect(glApiResultMock).not.toHaveBeenCalled();
  });

  it("surfaces a helpful error when the jq binary is missing", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ state: "opened" }));
    runJqMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "ENOENT",
      exitCode: 127,
    });
    await expect(
      apiCommand(["projects/{project}/x", "--jq", ".state"], ctx),
    ).rejects.toThrow("jq is not installed");
  });

  it("maps a jq program error to a validation error", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ state: "opened" }));
    runJqMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "jq: error: syntax error, unexpected end\nmore",
      exitCode: 3,
    });
    await expect(
      apiCommand(["projects/{project}/x", "--jq", ".("], ctx),
    ).rejects.toThrow("jq: error: syntax error");
  });
});

describe("api --raw / --json", () => {
  it("prints the raw JSON verbatim (parseable, noisy fields intact)", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({ id: 1, state: "opened", web_url: "x" }),
    );
    const out = await apiCommand(["projects/{project}/x", "--raw"], ctx);
    expect(JSON.parse(out)).toEqual({ id: 1, state: "opened", web_url: "x" });
    // Not TOON, and jq is never invoked for the plain escape hatch.
    expect(out).not.toContain("state: opened");
    expect(runJqMock).not.toHaveBeenCalled();
  });

  it("treats --json as an alias for --raw", async () => {
    glApiResultMock.mockResolvedValueOnce(ok({ id: 2, web_url: "y" }));
    const out = await apiCommand(["projects/{project}/x", "--json"], ctx);
    expect(JSON.parse(out)).toEqual({ id: 2, web_url: "y" });
  });

  it("still emits stripped TOON by default (no flag)", async () => {
    glApiResultMock.mockResolvedValueOnce(
      ok({ id: 1, state: "opened", web_url: "x" }),
    );
    const out = await apiCommand(["projects/{project}/x"], ctx);
    expect(out).toContain("state: opened");
    expect(out).not.toContain("web_url");
    expect(runJqMock).not.toHaveBeenCalled();
  });
});
