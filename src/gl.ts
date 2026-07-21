import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
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
  /**
   * One parameter whose value is fed to the child on stdin instead of argv,
   * emitted as `-F <name>=@-`. Use it for anything secret: every element of a
   * child's argument list is world-readable at /proc/<pid>/cmdline for the
   * lifetime of the process, so a credential passed as `-f value=...` is
   * readable by any other process on the machine.
   *
   * The `@` form is read verbatim as a string - the type inference `-F`
   * normally applies is NOT applied to a value read this way (verified against
   * glab 1.53.0: "true" and "12345678" both stored as strings), so a secret
   * that happens to look like a boolean or an integer survives intact.
   *
   * Only one field can come from stdin, since there is only one stdin.
   */
  stdinField?: { name: string; value: string };
  /** Extra HTTP headers: glab -H key:value. */
  headers?: string[];
  paginate?: boolean;
  ctx?: RepoContext;
}

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB

/** URL-encode a project's full namespace path for use as a REST :id. */
export function projectId(ctx?: RepoContext): string {
  if (!ctx?.project) return "{project}";
  return encodeURIComponent(ctx.project);
}

/** Return the encoded project id, or throw an actionable error if unresolved. */
export function requireProject(ctx?: RepoContext): string {
  if (!ctx?.project) {
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
  // The name is safe to put on argv; only the value is withheld, and `@-`
  // tells the child to read it from the stdin `run` writes.
  if (opts.stdinField) args.push("-F", `${opts.stdinField.name}=@-`);
  for (const h of opts.headers ?? []) args.push("-H", h);
  if (opts.paginate) args.push("--paginate");
  return args;
}

/**
 * Build and run a `glab api` invocation, routing `stdinField`'s value to the
 * child's stdin. Every entry point goes through here so a caller cannot get
 * the argv-vs-stdin split wrong by reaching for `run` directly.
 */
function runApi(
  path: string,
  opts: GlApiOptions,
  extraArgs: string[] = [],
): Promise<ExecResult> {
  return run(
    [...buildApiArgs(path, opts), ...extraArgs],
    opts.ctx,
    opts.stdinField?.value,
  );
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

function run(
  args: string[],
  ctx?: RepoContext,
  input?: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
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
    // Only write when a value was withheld from argv; a child that is not
    // expecting stdin must keep its inherited pipe untouched.
    if (input !== undefined) writeStdin(child, input);
  });
}

/** Execute a `glab api` request and return parsed JSON. Throws on error. */
export async function glApi<T = Json>(
  path: string,
  opts: GlApiOptions = {},
): Promise<T> {
  const result = await runApi(path, opts);
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

export interface GlListResult<T> {
  data: T[];
  /**
   * `X-Total` as reported by the server, or null when it sent no such header.
   * GitLab omits it on result sets over 10,000 rows, so null means "the server
   * did not say" and must never be rendered as a total (least of all as 0).
   */
  total: number | null;
}

/** Match `X-Total` in a header block only, so a response body cannot spoof it. */
const TOTAL_HEADER = /^x-total:[ \t]*(\d+)[ \t]*\r?$/im;

/**
 * Execute a `glab api` list request, returning the parsed rows plus GitLab's
 * `X-Total` count of everything the query matched. `-i` prefixes the body with
 * the response headers, which is the only place that total is exposed.
 *
 * Only for endpoints whose rendered rows ARE the server's result set: `X-Total`
 * counts what the query matched, so a caller that filters or partitions the rows
 * client-side (as `variable`/`secret` do on `masked`) would print a total that
 * does not describe the rows beside it. Those keep plain `glApi`.
 *
 * Not for `paginate`: each page emits its own header block.
 */
export async function glApiList<T = Json>(
  path: string,
  opts: GlApiOptions = {},
): Promise<GlListResult<T>> {
  const result = await runApi(path, opts, ["-i"]);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  if (result.stderr === "E2BIG") throw argumentTooLargeError();
  if (result.exitCode !== 0)
    throw mapGlError(errorBody(result), result.exitCode);

  const sep = result.stdout.match(/\r?\n\r?\n/);
  const headers =
    sep?.index === undefined ? "" : result.stdout.slice(0, sep.index);
  const body =
    sep?.index === undefined
      ? result.stdout
      : result.stdout.slice(sep.index + sep[0].length);

  const matched = TOTAL_HEADER.exec(headers);
  const total = matched ? Number(matched[1]) : null;

  const out = body.trim();
  if (out === "") return { data: [], total };
  let parsed: Json;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new AxiError(
      `Unexpected API output: ${scrubTool(out.slice(0, 200))}`,
      "UNKNOWN",
    );
  }
  // Some scopes answer `null` rather than an empty array.
  return { data: Array.isArray(parsed) ? (parsed as T[]) : [], total };
}

/** Execute a `glab api` request and return raw (non-JSON) text. Throws on error. */
export async function glRaw(
  path: string,
  opts: GlApiOptions = {},
): Promise<string> {
  const result = await runApi(path, opts);
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
  const result = await runApi(path, opts);
  if (result.stderr === "ENOENT") throw glNotInstalledError();
  if (result.stderr === "E2BIG") throw argumentTooLargeError();
  return result;
}

/**
 * Read a CLI config value, or "" when there is no entry.
 *
 * `host` scopes the read to one instance (`-h`); omitting it reads the global
 * setting, which is how the default host is discovered.
 *
 * Offline and synchronous (no API call), so it is cheap enough for the
 * resolution path. Only value-safe keys belong here: never read `token`, which
 * is per-host too but would put a secret one interpolation away from output.
 */
export function glConfigGet(key: string, host?: string): string {
  return glConfigGetResult(key, host)?.trim() ?? "";
}

/**
 * The same read, but distinguishing "the key is unset" ("") from "the read
 * failed" (null), which `glConfigGet` deliberately collapses.
 *
 * The resolution path only cares whether it got a usable value, so collapsing
 * is right there. A caller that REPORTS the value to an agent must not, since
 * rendering a failed read as "unset" is the confident lie the never-report-
 * unverified-state rule exists to prevent - they are opposite facts.
 */
export function glConfigGetResult(key: string, host?: string): string | null {
  const args = host
    ? ["config", "get", "-h", host, key]
    : ["config", "get", key];
  try {
    return execFileSync("glab", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw glNotInstalledError();
    }
    return null;
  }
}

/**
 * Feed a child process its stdin without letting a closed pipe crash us.
 *
 * A child that exits before reading stdin makes the write fail with EPIPE, and
 * an unhandled `error` on the stream takes down the whole process - losing the
 * child's real exit code, which is the thing the caller actually wanted. That
 * is not hypothetical: an OLD binary that does not implement the subcommand
 * exits immediately, and reporting a stale install is precisely what this
 * module now exists to do. The exec callback still resolves with the outcome,
 * so swallowing the write error here loses nothing.
 */
function writeStdin(
  child: { stdin?: NodeJS.WritableStream | null },
  input: string,
): void {
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
}

/** One executable named `glab` found on PATH. */
export interface GlInstall {
  /** The PATH entry as it would be invoked. */
  path: string;
  /** Version string the binary reports, or null when it would not say. */
  version: string | null;
}

/**
 * Every `glab` on PATH, in PATH order - so [0] is the one that actually answers.
 *
 * This exists because of a real incident: a host carried two installs (an OS
 * package early on PATH, a much newer snap late on PATH) with separate config
 * files and different default hosts. Every tool shelling out to the CLI drove
 * the old one silently, and diagnosing it needed the bare CLI at every step.
 * Reporting the whole list makes that a single command: if this returns more
 * than one entry with different versions, that is the bug, stated.
 *
 * Entries are de-duplicated by realpath, because one binary reachable through
 * several PATH entries (/usr/bin and /bin on a merged-usr system) is one
 * install, not a shadowing conflict - reporting it as one would cry wolf on
 * nearly every Linux box.
 */
export function glInstalls(): GlInstall[] {
  const seen = new Set<string>();
  const installs: GlInstall[] = [];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "glab");
    let real: string;
    try {
      accessSync(candidate, constants.X_OK);
      real = realpathSync(candidate);
    } catch {
      continue; // not here, or not executable by us
    }
    if (seen.has(real)) continue;
    seen.add(real);
    installs.push({ path: candidate, version: readVersion(candidate) });
  }
  return installs;
}

/**
 * Ask one specific binary for its version. Deliberately per-path, not a single
 * `glab --version`: the point is to compare the installs against each other,
 * which a PATH-resolved call can never do.
 */
function readVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Reported as a sentence ("Current glab version: 1.2.3 (...)"), so take the
    // version itself rather than echoing prose that names the wrapped binary.
    return /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1] ?? null;
  } catch {
    // A binary that will not report a version is still a real install worth
    // naming - "null" says the version is unknown, never that it is absent.
    return null;
  }
}

/**
 * Run the wrapped CLI's own git-credential helper, feeding it `input` on stdin
 * and returning its raw result without throwing.
 *
 * The credential itself is never parsed, logged, or stored here - it is read
 * from whatever store the wrapped CLI already manages and handed straight back
 * to the caller. That is the whole point: the alternative is every consumer
 * learning the CLI's on-disk config layout, which is an internal detail that
 * can change under them.
 */
export function glCredential(
  operation: string,
  input: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "glab",
      ["auth", "git-credential", operation],
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
    writeStdin(child, input);
  });
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
    writeStdin(child, input);
  });
}
