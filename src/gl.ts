import { execFile, execFileSync } from "node:child_process";
import {
  argumentTooLargeError,
  AxiError,
  glNotInstalledError,
  mapGlError,
  scrubTool,
} from "./errors.js";
import type { RepoContext } from "./context.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- glab API responses are dynamically typed JSON
export type Json = any;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GlApiOptions {
  method?: string;
  /** Typed parameters (numbers/booleans/null inferred): glab -F key=value. */
  fields?: string[];
  /** Raw string parameters (no type inference): glab -f key=value. */
  rawFields?: string[];
  /** Extra HTTP headers: glab -H key:value. */
  headers?: string[];
  paginate?: boolean;
  ctx?: RepoContext;
}

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB

/** URL-encode a project's full namespace path for use as a REST :id. */
export function projectId(ctx?: RepoContext): string {
  if (!ctx) return "{project}";
  return encodeURIComponent(ctx.project);
}

/** Return the encoded project id, or throw an actionable error if unresolved. */
export function requireProject(ctx?: RepoContext): string {
  if (!ctx) {
    throw new AxiError(
      "Could not determine the target GitLab project",
      "VALIDATION_ERROR",
      [
        "Pass -R [host/]group/project, e.g. `glab-axi issue list -R gitlab.example.com/group/project`",
        "Or run inside a git repository whose origin remote points at a GitLab project",
      ],
    );
  }
  return encodeURIComponent(ctx.project);
}

function envFor(ctx?: RepoContext): NodeJS.ProcessEnv {
  if (ctx?.host) {
    return { ...process.env, GITLAB_HOST: ctx.host };
  }
  return process.env;
}

/**
 * Build the argument list for `glab api`. Crucially, we never append `-R`:
 * `glab api` rejects `-R`, and the project is always addressed by its
 * URL-encoded path inside the REST path instead. The host is targeted via the
 * GITLAB_HOST environment variable, not a flag.
 */
function buildApiArgs(path: string, opts: GlApiOptions): string[] {
  const args = ["api", path, "--method", (opts.method ?? "GET").toUpperCase()];
  for (const f of opts.fields ?? []) args.push("-F", f);
  for (const f of opts.rawFields ?? []) args.push("-f", f);
  for (const h of opts.headers ?? []) args.push("-H", h);
  if (opts.paginate) args.push("--paginate");
  return args;
}

/**
 * Combine both streams for error mapping. The CLI prints a human one-liner to
 * stderr (e.g. "Label already exists (HTTP 409)") but the structured GitLab
 * JSON body (e.g. {"message":"..."}) lands on stdout — the error mapper needs
 * both to extract an actionable message and the HTTP code.
 */
export function errorBody(result: ExecResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n");
}

function run(args: string[], ctx?: RepoContext): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "glab",
      args,
      { maxBuffer: MAX_BUFFER_BYTES, env: envFor(ctx) },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number }) | null;
        if (err && err.code === "ENOENT") {
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        // The process never spawned (argument list too long, e.g. a large
        // --content/--value passed via `-f`), the same class of failure as
        // ENOENT - map it the same way rather than letting an opaque E2BIG
        // reach the caller as an "UNKNOWN" error.
        if (err && err.code === "E2BIG") {
          resolve({ stdout: "", stderr: "E2BIG", exitCode: 127 });
          return;
        }
        const exitCode = err
          ? typeof err.code === "number"
            ? err.code
            : 1
          : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
        });
      },
    );
  });
}

/** Execute a `glab api` request and return parsed JSON. Throws on error. */
export async function glApi<T = Json>(
  path: string,
  opts: GlApiOptions = {},
): Promise<T> {
  const result = await run(buildApiArgs(path, opts), opts.ctx);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  if (result.stderr === "E2BIG") throw argumentTooLargeError();
  if (result.exitCode !== 0)
    throw mapGlError(errorBody(result), result.exitCode);
  const out = result.stdout.trim();
  if (out === "") return undefined as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new AxiError(
      `Unexpected API output: ${scrubTool(out.slice(0, 200))}`,
      "UNKNOWN",
    );
  }
}

/** Execute a `glab api` request and return raw (non-JSON) text. Throws on error. */
export async function glRaw(
  path: string,
  opts: GlApiOptions = {},
): Promise<string> {
  const result = await run(buildApiArgs(path, opts), opts.ctx);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  if (result.stderr === "E2BIG") throw argumentTooLargeError();
  if (result.exitCode !== 0)
    throw mapGlError(errorBody(result), result.exitCode);
  return result.stdout;
}

/** Execute a `glab api` request, returning the full result without throwing. */
export async function glApiResult(
  path: string,
  opts: GlApiOptions = {},
): Promise<ExecResult> {
  const result = await run(buildApiArgs(path, opts), opts.ctx);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  if (result.stderr === "E2BIG") throw argumentTooLargeError();
  return result;
}

/**
 * Read a per-host CLI config value, or "" when the host has no entry.
 *
 * Offline and synchronous (no API call), so it is cheap enough for the
 * resolution path. Only value-safe keys belong here: never read `token`, which
 * is per-host too but would put a secret one interpolation away from output.
 */
export function glConfigGet(key: string, host: string): string {
  try {
    return execFileSync("glab", ["config", "get", "-h", host, key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Pipe JSON text through the system `jq` binary (raw output, `-r`), returning
 * the full result without throwing. Backs `api --jq`, giving real jq semantics
 * with zero extra npm deps; a missing binary surfaces as `stderr === "ENOENT"`
 * (exit 127) for the caller to translate.
 */
export function runJq(input: string, expr: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "jq",
      ["-r", expr],
      { maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number }) | null;
        if (err && err.code === "ENOENT") {
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const exitCode = err
          ? typeof err.code === "number"
            ? err.code
            : 1
          : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
    child.stdin?.end(input);
  });
}
