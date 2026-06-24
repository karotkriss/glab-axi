import { execFile } from "node:child_process";
import type { RepoContext } from "./context.js";
import { AxiError, glabNotInstalledError, mapGlabError } from "./errors.js";

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function env(ctx?: RepoContext): NodeJS.ProcessEnv {
  const e = { ...process.env };
  // Always pin the host when we know it, so calls do not depend on the
  // process cwd's git remote (the agent/daemon may run elsewhere).
  if (ctx?.host) e["GITLAB_HOST"] = ctx.host;
  return e;
}

function run(args: string[], ctx?: RepoContext): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "glab",
      args,
      { maxBuffer: MAX_BUFFER_BYTES, env: env(ctx) },
      (error, stdout, stderr) => {
        const err = error as NodeJS.ErrnoException | null;
        if (err && err.code === "ENOENT") {
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const code =
          err && typeof err.code === "number" ? err.code : error ? 1 : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: code,
        });
      },
    );
  });
}

/** URL-encode a project path for use as a REST :id (group%2Fsub%2Fproject). */
export function projectId(ctx: RepoContext): string {
  return encodeURIComponent(ctx.project);
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Repeated -f key=value form fields. */
  fields?: Record<string, string | number | boolean | undefined>;
  paginate?: boolean;
  ctx?: RepoContext;
}

function buildApiArgs(path: string, opts: ApiOptions): string[] {
  const args = ["api", path];
  const method = opts.method ?? "GET";
  if (method !== "GET") args.push("--method", method);
  if (opts.paginate) args.push("--paginate");
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    if (v === undefined) continue;
    args.push("-f", `${k}=${v}`);
  }
  return args;
}

/** Call the GitLab REST API through `glab api` and return parsed JSON. */
export async function glApi<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const result = await run(buildApiArgs(path, opts), opts.ctx);
  if (result.stderr === "ENOENT") throw glabNotInstalledError();
  if (result.exitCode !== 0) throw mapGlabError(result.stderr, result.exitCode);
  const out = result.stdout.trim();
  if (out === "") return undefined as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new AxiError(
      `unexpected non-JSON response: ${out.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
}

/** Run a glab porcelain command and return raw stdout (throws on failure). */
export async function glExec(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const repoArgs = [...args];
  if (ctx && ctx.source !== "git") repoArgs.push("-R", ctx.project);
  const result = await run(repoArgs, ctx);
  if (result.stderr === "ENOENT") throw glabNotInstalledError();
  if (result.exitCode !== 0) throw mapGlabError(result.stderr, result.exitCode);
  return result.stdout;
}

/** Run glab, returning the full result without throwing on non-zero exit. */
export async function glRaw(
  args: string[],
  ctx?: RepoContext,
): Promise<RunResult> {
  const repoArgs = [...args];
  if (ctx && ctx.source !== "git") repoArgs.push("-R", ctx.project);
  const result = await run(repoArgs, ctx);
  if (result.stderr === "ENOENT") throw glabNotInstalledError();
  return result;
}
