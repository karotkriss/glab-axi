import { encode } from "@toon-format/toon";
import { glApiResult, projectId, type Json } from "../gl.js";
import { AxiError, mapGlError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { getAllFlags, hasFlag } from "../args.js";
import { cleanBody } from "../body.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/** Flags that consume a following value token (when not in --flag=value form). */
const VALUE_FLAGS = new Set(["--field", "--raw-field", "--header"]);

/**
 * Derive the positional args (method/path), skipping flags and the value tokens
 * they consume. Without this, a flag value like `state=opened` (from
 * `--field state=opened`) survives as a non-`-` token and is misread as the path.
 */
function extractPositionals(args: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

/** GitLab-noisy keys that bloat output without helping an agent reason. */
const NOISY = new Set([
  "avatar_url",
  "web_url",
  "_links",
  "http_url_to_repo",
  "ssh_url_to_repo",
  "readme_url",
  "name_with_namespace",
  "namespace",
  "references",
  "gravatar_id",
  "runners_token",
]);

/** Nested actor objects we collapse down to just their username. */
const ACTOR_KEYS = new Set(["author", "user", "assignee"]);

const MAX_DEPTH = 8;
const MAX_BODY_CHARS = 4000;
const LONG_STRING_THRESHOLD = 200;
const LONG_STRING_TRUNCATE = 2000;

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const API_HELP = `usage: glab-axi api [<method>] <path> [flags]
methods[6]:
  GET (default), POST, PUT, PATCH, DELETE, HEAD
path:
  Use the {project} placeholder for the current project; it is replaced with the
  URL-encoded project id, e.g. projects/{project}/members → projects/group%2Fproject/members
flags:
  --field <k=v>      typed parameter (numbers/bools/null inferred), repeatable
  --raw-field <k=v>  raw string parameter, repeatable
  --header <k:v>     extra HTTP header, repeatable
  --paginate         follow pagination and aggregate all pages
examples:
  glab-axi api projects/{project}/members
  glab-axi api GET projects/{project}/merge_requests --field state=opened
  glab-axi api POST projects/{project}/issues --raw-field title="Bug" --raw-field description="Details"`;

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Collapse a nested actor object to just its username, when present. */
function collapseActor(value: Json): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.username === "string") return value.username;
  }
  return undefined;
}

/** Recursively drop GitLab-noisy keys and trim long strings from API output. */
function stripNoisyFields(obj: Json, depth = 0): Json {
  if (depth >= MAX_DEPTH) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => stripNoisyFields(item, depth + 1));
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (NOISY.has(key)) continue;
      if (key.endsWith("_url")) continue;
      if (ACTOR_KEYS.has(key)) {
        const username = collapseActor(value);
        if (username !== undefined) {
          out[key] = username;
          continue;
        }
      }
      out[key] = stripNoisyFields(value, depth + 1);
    }
    return out;
  }
  if (typeof obj === "string" && obj.length > LONG_STRING_THRESHOLD) {
    const cleaned = cleanBody(obj);
    if (cleaned.length > LONG_STRING_TRUNCATE) {
      return cleaned.slice(0, LONG_STRING_TRUNCATE) + "... (truncated)";
    }
    return cleaned;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function parseMethodAndPath(positionals: string[]): {
  method: string;
  path: string;
} {
  if (
    positionals.length >= 2 &&
    METHODS.includes(positionals[0].toUpperCase())
  ) {
    return { method: positionals[0].toUpperCase(), path: positionals[1] };
  }
  // A lone recognized HTTP method with no path (e.g. `api POST`) is a usage
  // error, not a GET request to a path literally named "POST".
  if (
    positionals.length === 1 &&
    METHODS.includes(positionals[0].toUpperCase())
  ) {
    throw new AxiError(
      "API path is required: glab-axi api [<method>] <path>",
      "VALIDATION_ERROR",
    );
  }
  return { method: "GET", path: positionals[0] };
}

export async function apiCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    return API_HELP;
  }

  const paginate = hasFlag(args, "--paginate");
  const fields = getAllFlags(args, "--field");
  const rawFields = getAllFlags(args, "--raw-field");
  const headers = getAllFlags(args, "--header");

  const positionals = extractPositionals(args);
  if (positionals.length === 0) {
    throw new AxiError(
      "API path is required: glab-axi api [<method>] <path>",
      "VALIDATION_ERROR",
    );
  }

  const { method, path: rawPath } = parseMethodAndPath(positionals);
  const path = rawPath.replace(/\{project\}/g, projectId(ctx));

  const result = await glApiResult(path, {
    method,
    fields,
    rawFields,
    headers,
    paginate,
    ctx,
  });

  if (result.exitCode !== 0) {
    throw mapGlError(result.stderr || result.stdout, result.exitCode);
  }

  const stdout = result.stdout;
  let parsed: Json;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const trimmed = stdout.trim();
    const truncated = trimmed.length > MAX_BODY_CHARS;
    const body = truncated ? trimmed.slice(0, MAX_BODY_CHARS) : trimmed;
    return encode({
      api_response: {
        body,
        truncated,
        ...(truncated ? { original_length: trimmed.length } : {}),
      },
    });
  }

  return encode(stripNoisyFields(parsed));
}
