import { glRaw, projectId, type ApiOptions } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError, mapGlabError } from "../errors.js";
import { encode } from "@toon-format/toon";
import { renderOutput } from "../toon.js";

export const API_HELP = `usage: glab-axi api [<METHOD>] <path> [flags]
description:
  Pass-through to the GitLab REST API. Path may use {project} as a
  placeholder for the URL-encoded resolved project id.
flags:
  --field <key=value> (repeatable), --paginate
methods:
  GET (default), POST, PUT, DELETE, PATCH
examples:
  glab-axi api projects/{project}/pipelines
  glab-axi api POST projects/{project}/issues --field title="Hi"
  glab-axi api /version`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const METHODS = new Set<ApiOptions["method"]>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
]);

const MAX_RAW_BODY = 4000;

interface ParsedApiArgs {
  method: NonNullable<ApiOptions["method"]>;
  path: string;
  fields: Record<string, string>;
  paginate: boolean;
}

/**
 * Parse the api passthrough invocation. METHOD is an optional leading
 * positional; --field is repeatable; --paginate is boolean. Order-independent
 * for flags.
 */
function parseApiArgs(args: string[]): ParsedApiArgs {
  const positionals: string[] = [];
  const fields: Record<string, string> = {};
  let paginate = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--paginate") {
      paginate = true;
      continue;
    }
    if (a === "--field" || a.startsWith("--field=")) {
      const raw = a === "--field" ? args[++i] : a.slice("--field=".length);
      if (raw === undefined) {
        throw new AxiError(
          "--field requires a key=value argument",
          "VALIDATION_ERROR",
        );
      }
      const eq = raw.indexOf("=");
      if (eq <= 0) {
        throw new AxiError(
          `invalid --field "${raw}" - expected key=value`,
          "VALIDATION_ERROR",
        );
      }
      fields[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    if (a.startsWith("--")) {
      throw new AxiError(`unknown flag: ${a}`, "VALIDATION_ERROR");
    }
    positionals.push(a);
  }

  let method: NonNullable<ApiOptions["method"]> = "GET";
  let rest = positionals;
  if (positionals.length > 0) {
    const maybe = positionals[0].toUpperCase() as NonNullable<
      ApiOptions["method"]
    >;
    if (METHODS.has(maybe)) {
      method = maybe;
      rest = positionals.slice(1);
    }
  }

  const path = rest[0];
  if (!path) {
    throw new AxiError(
      "a request path is required (e.g. projects/{project}/pipelines)",
      "VALIDATION_ERROR",
    );
  }

  return { method, path, fields, paginate };
}

/** Replace the {project} placeholder with the URL-encoded project id. */
function resolvePath(path: string, ctx: RepoContext | undefined): string {
  if (!path.includes("{project}")) return path;
  if (!ctx) {
    throw new AxiError(
      "path uses {project} but no project could be determined - pass -R <group/project> or run inside a git checkout",
      "VALIDATION_ERROR",
    );
  }
  return path.replaceAll("{project}", projectId(ctx));
}

/** Build the positional glab argv for a raw fallback call. */
function buildRawArgs(p: ParsedApiArgs, path: string): string[] {
  const argv = ["api", path];
  if (p.method !== "GET") argv.push("--method", p.method);
  if (p.paginate) argv.push("--paginate");
  for (const [k, v] of Object.entries(p.fields)) {
    argv.push("-f", `${k}=${v}`);
  }
  return argv;
}

/** Wrap a parsed JSON value under a TOON envelope. */
function encodeJson(value: Json): string {
  // Top-level arrays/objects need a key so TOON has something to label.
  return encode({ result: value });
}

export async function apiCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  if (args[0] === "--help") return renderOutput([API_HELP]);

  const parsed = parseApiArgs(args);
  const path = resolvePath(parsed.path, ctx);

  // Run glab directly so we can gracefully handle non-JSON/empty responses
  // (some endpoints return plain text or an empty body).
  const result = await glRaw(buildRawArgs(parsed, path), ctx);
  if (result.exitCode !== 0) {
    throw mapGlabError(result.stderr, result.exitCode);
  }

  const body = result.stdout.trim();
  if (body === "") {
    return renderOutput([encode({ result: { status: "ok" } })]);
  }

  try {
    const value = JSON.parse(body) as Json;
    return renderOutput([encodeJson(value)]);
  } catch {
    const truncated = body.length > MAX_RAW_BODY;
    return renderOutput([
      encode({
        api_response: {
          body: truncated ? body.slice(0, MAX_RAW_BODY) : body,
          truncated,
          original_length: body.length,
        },
      }),
    ]);
  }
}
