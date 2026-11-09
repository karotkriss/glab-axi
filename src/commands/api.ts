import { readFileSync } from "node:fs";
import { encode } from "@toon-format/toon";
import { glApiResult, projectId, errorBody, type Json } from "../gl.js";
import { AxiError, mapGlError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { getAllFlags, getFlag, hasFlag } from "../args.js";
import { applyJq } from "../machine.js";
import { cleanBody } from "../body.js";
import { readStdin } from "../stdin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/** Flags that consume a following value token (when not in --flag=value form). */
const VALUE_FLAGS = new Set([
  "--field",
  "--raw-field",
  "--header",
  "--jq",
  "--input",
]);

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
  --field <k=v>      typed parameter (numbers/bools/null inferred; { or [ is JSON), repeatable
  --raw-field <k=v>  raw string parameter, never parsed as JSON, repeatable
  --input <file|->   JSON request body from a file, or - for stdin
  --header <k:v>     extra HTTP header, repeatable
  --paginate         follow pagination and aggregate all pages
  --jq <expr>        extract a value from the raw JSON via jq (-r); takes precedence over --raw
  --raw, --json      print the raw JSON response verbatim instead of TOON
arrays:
  Name a key with [] (key[]=value) and repeat it to send an array, e.g. scopes,
  assignee_ids, iids or labels. A GET sends key[]= in the query string; any
  other method sends all parameters as a JSON body with each key[] collected
  into a real array (--field values keep their inferred types).
nested:
  A bracket name (position[base_sha]) is a nested JSON object on every method
  except GET and HEAD, which keep it as a query parameter. --field
  position[new_line]=85 sends a number; the same --raw-field sends the string
  "85". --field position={...} sends that JSON object. --raw-field does not
  parse JSON. --input cannot be combined with --field or --raw-field.
examples:
  glab-axi api projects/{project}/members
  glab-axi api GET projects/{project}/merge_requests --field state=opened
  glab-axi api POST projects/{project}/issues --raw-field title="Bug" --raw-field description="Details"
  glab-axi api PUT projects/{project}/issues/7 --field "assignee_ids[]=12" --field "assignee_ids[]=34"
  glab-axi api projects/{project}/issues --field "iids[]=1" --field "iids[]=2"
  glab-axi api POST projects/{project}/merge_requests/5/draft_notes --input note.json
  glab-axi api projects/{project}/merge_requests/5 --jq .state
  glab-axi api projects/{project} --raw`;

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
// Array parameters
// ---------------------------------------------------------------------------

const ARRAY_KEY = /^(.+)\[\]$/;

function splitParam(flag: string, param: string): [string, string] {
  const eq = param.indexOf("=");
  if (eq <= 0) {
    throw new AxiError(
      `${flag} must be key=value: ${param}`,
      "VALIDATION_ERROR",
    );
  }
  return [param.slice(0, eq), param.slice(eq + 1)];
}

/** Infer a --field value's type the way the wrapped CLI does for -F. */
function typedValue(value: string): unknown {
  if (value.startsWith("@")) {
    const file = value.slice(1);
    return readFileSync(file === "-" ? 0 : file, "utf8");
  }
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

/**
 * A --field value that starts with { or [ is JSON. --raw-field never calls
 * this: its text stays a literal string, even when it looks like JSON.
 */
function jsonFieldValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AxiError(
      `--field value is not valid JSON: ${raw.slice(0, 80)}`,
      "VALIDATION_ERROR",
    );
  }
}

function paramValue(key: string, raw: string, typed: boolean): unknown {
  if (
    typed &&
    !key.includes("[") &&
    (raw.startsWith("{") || raw.startsWith("["))
  ) {
    return jsonFieldValue(raw);
  }
  return typed ? typedValue(raw) : raw;
}

interface KeySegment {
  name: string;
  array: boolean;
}

function invalidParam(key: string): never {
  throw new AxiError(`invalid parameter name: ${key}`, "VALIDATION_ERROR", [
    "Use key, key[] or key[child], or send the body with --input <file>",
  ]);
}

/** Split `scopes[]` or `position[base_sha]` into segments. A plain key is one. */
function parseKey(key: string): KeySegment[] {
  if (!key.includes("[")) return [{ name: key, array: false }];
  const segments: KeySegment[] = [];
  let i = 0;
  while (i < key.length) {
    if (key[i] === "[") {
      if (segments.length === 0) invalidParam(key);
      const end = key.indexOf("]", i);
      if (end === -1) invalidParam(key);
      const inner = key.slice(i + 1, end);
      if (inner === "") {
        if (segments[segments.length - 1].array) invalidParam(key);
        segments[segments.length - 1].array = true;
      } else if (inner.includes("[")) {
        invalidParam(key);
      } else {
        segments.push({ name: inner, array: false });
      }
      i = end + 1;
      continue;
    }
    const next = key.indexOf("[", i);
    const name = next === -1 ? key.slice(i) : key.slice(i, next);
    if (!name || segments.length > 0) invalidParam(key);
    segments.push({ name, array: false });
    i = next === -1 ? key.length : next;
  }
  if (segments.length === 0) invalidParam(key);
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paramConflict(name: string): never {
  throw new AxiError(
    `parameter ${name} is both a value and a nested field`,
    "VALIDATION_ERROR",
    [
      "Send one JSON object with --field key={...}, or send the body with --input <file>",
    ],
  );
}

function assignParam(
  root: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const segments = parseKey(key);
  let container = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const existing = container[seg.name];
    if (!last && seg.array) {
      // shortcut: array-of-object names (variables[][key]) are rejected, use --input for that shape.
      throw new AxiError(
        `parameter ${key} nests inside an array; send that body with --input <file>`,
        "VALIDATION_ERROR",
      );
    }
    if (last && seg.array) {
      if (existing === undefined) {
        container[seg.name] = [value];
        return;
      }
      if (!Array.isArray(existing)) paramConflict(seg.name);
      existing.push(value);
      return;
    }
    if (last) {
      if (isRecord(existing) || Array.isArray(existing))
        paramConflict(seg.name);
      container[seg.name] = value;
      return;
    }
    if (existing === undefined) {
      const next: Record<string, unknown> = Object.create(null);
      container[seg.name] = next;
      container = next;
      continue;
    }
    if (!isRecord(existing)) paramConflict(seg.name);
    container = existing;
  }
}

function isQueryMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function needsStructuredEncode(
  method: string,
  params: ReadonlyArray<readonly [string, string, boolean]>,
): boolean {
  if (isQueryMethod(method)) {
    return params.some(([key]) => ARRAY_KEY.test(key));
  }
  return params.some(
    ([key, raw, typed]) =>
      key.includes("[") ||
      (typed &&
        !key.includes("[") &&
        (raw.startsWith("{") || raw.startsWith("["))),
  );
}

/**
 * Encode parameters ourselves when a flat map would drop what the caller asked
 * for. The wrapped CLI keys a JSON body by the literal name, so `scopes[]` and
 * `position[base_sha]` never become an array or a nested object, and GitLab
 * ignores them while the request still succeeds. GET/HEAD keep `key[]` in the
 * query string. Any other method gets one JSON body. A --raw-field value is
 * always a string; a --field value keeps type inference, and `{` / `[` is JSON.
 * Returns undefined when the plain field path is still correct.
 */
export function encodeArrayParams(
  method: string,
  path: string,
  fields: string[],
  rawFields: string[],
): { path: string; json?: string } | undefined {
  const params = [
    ...fields.map((f) => [...splitParam("--field", f), true] as const),
    ...rawFields.map((f) => [...splitParam("--raw-field", f), false] as const),
  ];
  if (!needsStructuredEncode(method, params)) return undefined;

  if (isQueryMethod(method)) {
    const query = new URLSearchParams(
      params.map(([key, value]): [string, string] => [key, value]),
    ).toString();
    return { path: `${path}${path.includes("?") ? "&" : "?"}${query}` };
  }

  const body: Record<string, unknown> = Object.create(null);
  for (const [key, raw, typed] of params) {
    assignParam(body, key, paramValue(key, raw, typed));
  }
  return { path, json: JSON.stringify(body) };
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

const INPUT_HINT = [
  "Pass --input <file>, or --input - to read the JSON body from stdin",
];

/** One --input source, or undefined when the flag is absent. */
function inputSource(args: string[]): string | undefined {
  const present = args.some((a) => a === "--input" || a.startsWith("--input="));
  if (!present) return undefined;
  const values = getAllFlags(args, "--input");
  if (values.length > 1) {
    throw new AxiError(
      "--input was given more than once",
      "VALIDATION_ERROR",
      INPUT_HINT,
    );
  }
  if (values.length === 0 || values[0] === "") {
    throw new AxiError(
      "--input requires a file path or -",
      "VALIDATION_ERROR",
      INPUT_HINT,
    );
  }
  return values[0];
}

function readInputFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "UNKNOWN";
    if (code === "ENOENT") {
      throw new AxiError(
        `JSON body file not found: ${path}`,
        "VALIDATION_ERROR",
        INPUT_HINT,
      );
    }
    throw new AxiError(
      `Could not read JSON body file: ${path} (${code})`,
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Read the --input body in this process, then hand the bytes to the child on
 * stdin. Validating here keeps a bad body off the wire, and keeps the JSON
 * off the child's argv.
 */
function readJsonInput(source: string): string {
  const text =
    source === "-"
      ? readStdin({
          rejectBinaryMessage: "JSON body on stdin is not valid UTF-8",
          suggestions: INPUT_HINT,
        })
      : readInputFile(source);
  if (text.trim() === "") {
    throw new AxiError(
      source === "-"
        ? "No JSON body was piped on stdin"
        : `JSON body file is empty: ${source}`,
      "VALIDATION_ERROR",
      INPUT_HINT,
    );
  }
  try {
    JSON.parse(text);
  } catch {
    throw new AxiError("JSON body is not valid JSON", "VALIDATION_ERROR");
  }
  return text;
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
  const raw = hasFlag(args, "--raw") || hasFlag(args, "--json");
  const hasJq = args.some((a) => a === "--jq" || a.startsWith("--jq="));
  const jqExpr = hasJq ? getFlag(args, "--jq") : undefined;
  if (hasJq && !jqExpr) {
    throw new AxiError(
      "The --jq flag requires an expression, e.g. --jq '.state'",
      "VALIDATION_ERROR",
    );
  }

  const positionals = extractPositionals(args);
  if (positionals.length === 0) {
    throw new AxiError(
      "API path is required: glab-axi api [<method>] <path>",
      "VALIDATION_ERROR",
    );
  }

  const { method, path: rawPath } = parseMethodAndPath(positionals);
  const path = rawPath.replace(/\{project\}/g, projectId(ctx));

  const input = inputSource(args);
  if (input !== undefined && (fields.length > 0 || rawFields.length > 0)) {
    throw new AxiError(
      "--input cannot be combined with --field or --raw-field",
      "VALIDATION_ERROR",
      ["Put every parameter in the JSON body, or omit --input and pass fields"],
    );
  }

  const arrays =
    input === undefined
      ? encodeArrayParams(method, path, fields, rawFields)
      : undefined;
  const result = await glApiResult(
    arrays?.path ?? path,
    input !== undefined
      ? {
          method,
          headers,
          paginate,
          ctx,
          body: {
            content: readJsonInput(input),
            contentType: "application/json",
          },
        }
      : arrays
        ? {
            method,
            headers,
            paginate,
            ctx,
            ...(arrays.json !== undefined && {
              body: {
                content: arrays.json,
                contentType: "application/json",
              },
            }),
          }
        : { method, fields, rawFields, headers, paginate, ctx },
  );

  if (result.exitCode !== 0) {
    throw mapGlError(errorBody(result), result.exitCode);
  }

  // Escape hatches for callers that need to parse the response themselves,
  // mirroring `gh api --jq` / raw JSON. Both operate on the raw, unmodified
  // response, not the noise-stripped TOON view the default path renders.
  if (jqExpr !== undefined) {
    return applyJq(result.stdout, jqExpr);
  }
  if (raw) {
    return result.stdout.trim();
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
