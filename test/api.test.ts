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
      if (!ctx) throw new Error("no project");
      return encodeURIComponent(ctx.project);
    },
  };
});

import { apiCommand, API_HELP } from "../src/commands/api.js";
import { glApiResult } from "../src/gl.js";
import type { RepoContext } from "../src/context.js";

const glApiResultMock = glApiResult as unknown as ReturnType<typeof vi.fn>;
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
