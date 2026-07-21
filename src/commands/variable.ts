import { glApi, glApiResult, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import { takeFlag, takeBoolFlag, getPositional, parseLimit } from "../args.js";
import { readStdin } from "../stdin.js";
import {
  field,
  boolYesNo,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Shared core - GitLab has a single CI/CD Variables API. `variable` and
// `secret` are two views onto it: `variable` = plain (unmasked) variables,
// `secret` = masked+protected variables. The helpers below are reused by
// secret.ts so both surfaces target the same endpoint identically.
// ---------------------------------------------------------------------------

/** Build a `projects/:id/variables` REST path with an optional suffix. */
export function variablesPath(
  ctx: RepoContext | undefined,
  suffix = "",
): string {
  return `projects/${requireProject(ctx)}/variables${suffix}`;
}

/**
 * Address a single variable by key, pinned to an environment scope. A key can
 * exist once per scope, so GET/PUT/DELETE must filter by scope to be
 * deterministic; the default `*` scope targets the unscoped variable.
 */
function variableKeyPath(
  ctx: RepoContext | undefined,
  key: string,
  env: string,
): string {
  return variablesPath(
    ctx,
    `/${encodeURIComponent(key)}?filter[environment_scope]=${encodeURIComponent(env)}`,
  );
}

/** Resolve the value for `set`: --value flag, else piped stdin. */
export function resolveValue(args: string[], domain: string): string {
  const inline = takeFlag(args, "--value");
  const value =
    inline !== undefined ? inline : readStdin().replace(/\r?\n$/, "");
  if (value === "") {
    throw new AxiError("A value is required", "VALIDATION_ERROR", [
      `Pass --value "<value>", or pipe it: \`printf %s "<value>" | glab-axi ${domain} set <name>\``,
    ]);
  }
  return value;
}

export function requireName(args: string[], domain: string): string {
  const name = getPositional(args, 0);
  if (!name) {
    throw new AxiError(`Missing ${domain} name`, "VALIDATION_ERROR", [
      // Secret values are stdin-only (see secret.ts); never suggest --value there.
      domain === "secret"
        ? `printf %s "<value>" | glab-axi secret set <name>`
        : `glab-axi ${domain} set <name> --value "<value>"`,
    ]);
  }
  return name;
}

export interface UpsertOptions {
  masked: boolean;
  protected: boolean;
  env: string;
}

/** Parse a GET response body, or undefined when it isn't usable JSON. */
function parseVariableBody(stdout: string): Json | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Idempotent set: GET the key first, then PUT (update) if it exists or POST
 * (create) if not. Returns the variable, whether it was newly created, and
 * whether it was already in the target state.
 *
 * The `unchanged` case skips the write entirely: the GET already proves the
 * stored value and flags match, so a PUT would only let `set` report "updated"
 * for an update that changed nothing. Every other mutation in this CLI reports
 * `already: true` here, and reusing the GET this function already makes costs
 * nothing. Shared by `variable set` and `secret set`, so both inherit it.
 *
 * The value ALWAYS travels via `stdinField`, never argv - see that option in
 * gl.ts for why. It is set here, in the one function both surfaces route
 * through, rather than in `secret set` alone: a per-caller rule would be one
 * forgotten line away from putting a credential back on the child's argv, and
 * `variable set` reads from the same stdin, so there is no case where argv is
 * the better channel. Do not "optimise" the plain-variable path back to `-f`.
 */
export async function upsertVariable(
  ctx: RepoContext | undefined,
  name: string,
  value: string,
  opts: UpsertOptions,
): Promise<{ variable: Json; created: boolean; unchanged: boolean }> {
  const existing = await glApiResult(variableKeyPath(ctx, name, opts.env), {
    ctx,
  });
  const created = existing.exitCode !== 0;

  const flags = [`masked=${opts.masked}`, `protected=${opts.protected}`];

  if (created) {
    const variable = await glApi<Json>(variablesPath(ctx), {
      method: "POST",
      rawFields: [`key=${name}`, `environment_scope=${opts.env}`],
      fields: flags,
      stdinField: { name: "value", value },
      ctx,
    });
    return { variable, created, unchanged: false };
  }

  const current = parseVariableBody(existing.stdout);
  if (
    current &&
    current.value === value &&
    current.masked === opts.masked &&
    current.protected === opts.protected
  ) {
    return { variable: current, created, unchanged: true };
  }

  const variable = await glApi<Json>(variableKeyPath(ctx, name, opts.env), {
    method: "PUT",
    fields: flags,
    stdinField: { name: "value", value },
    ctx,
  });
  return { variable, created, unchanged: false };
}

/** Idempotent delete: DELETE the key; a 404 (already absent) is a no-op. */
export async function deleteVariable(
  ctx: RepoContext | undefined,
  domain: string,
  name: string,
  env: string,
): Promise<string> {
  const result = await glApiResult(variableKeyPath(ctx, name, env), {
    method: "DELETE",
    ctx,
  });

  if (result.exitCode !== 0) {
    const body = result.stderr || result.stdout;
    if (/HTTP 404|404 Not Found|not found/i.test(body)) {
      return renderOutput([
        renderDetail("deleted", { key: name, already_absent: true }, [
          field("key"),
          field("already_absent"),
        ]),
        renderHelp(getSuggestions({ domain, action: "delete", repo: ctx })),
      ]);
    }
    throw new AxiError(`Failed to delete ${domain}: ${name}`, "UNKNOWN", [
      `Run \`glab-axi ${domain} list\` to see existing ${domain}s`,
    ]);
  }

  return renderOutput([
    renderDetail("deleted", { key: name, status: "ok" }, [
      field("key"),
      field("status"),
    ]),
    renderHelp(getSuggestions({ domain, action: "delete", repo: ctx })),
  ]);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("key"),
  field("value"),
  boolYesNo("protected"),
  field("environment_scope", "env"),
];

const getSchema: FieldDef[] = [
  field("key"),
  field("value"),
  boolYesNo("masked"),
  boolYesNo("protected"),
  field("environment_scope", "env"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const VARIABLE_HELP = `usage: glab-axi variable <subcommand> [flags]
subcommands[4]:
  list, get <name>, set <name>, delete <name>
maps to plain (unmasked) GitLab CI/CD variables - use \`secret\` for masked ones
flags{list}:
  --limit <n> (default 100)
flags{get,view,set,delete,rm}:
  --env <scope> (environment scope, default "*")
flags{set}:
  --value <value> (required; reads from piped stdin if omitted), --protected!
examples:
  glab-axi variable list
  glab-axi variable get NODE_ENV
  glab-axi variable set NODE_ENV --value production
  printf %s "production" | glab-axi variable set NODE_ENV
  glab-axi variable delete NODE_ENV`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function variableList(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 100);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));

  const all =
    (await glApi<Json[]>(`${variablesPath(ctx)}?${params.toString()}`, {
      ctx,
    })) ?? [];
  // Partition: `variable` shows the plain (unmasked) variables; masked ones
  // belong to `secret list`, which never reveals their values.
  const items = all.filter((v) => !v.masked);
  const isEmpty = items.length === 0;
  // A full raw page means more variables may exist beyond it, even after the
  // masked filter shrinks the visible count below `limit`.
  const truncated = all.length === limit;

  if (isEmpty) {
    return renderOutput([
      "variables: 0 variables found",
      renderHelp(
        getSuggestions({
          domain: "variable",
          action: "list",
          isEmpty,
          repo: ctx,
        }),
      ),
    ]);
  }
  return renderOutput([
    formatCountLine({
      count: items.length,
      limit: truncated ? items.length : undefined,
    }),
    renderList("variables", items, listSchema),
    renderHelp(
      getSuggestions({
        domain: "variable",
        action: "list",
        isEmpty,
        repo: ctx,
      }),
    ),
  ]);
}

async function variableGet(args: string[], ctx?: RepoContext): Promise<string> {
  const env = takeFlag(args, "--env") ?? "*";
  const name = requireName(args, "variable");
  const variable = await glApi<Json>(variableKeyPath(ctx, name, env), { ctx });
  const masked = variable.masked === true;

  return renderOutput([
    renderDetail(
      "variable",
      masked ? { ...variable, value: "[masked]" } : variable,
      getSchema,
    ),
    renderHelp(
      getSuggestions({
        domain: "variable",
        action: "get",
        id: name,
        state: masked ? "masked" : undefined,
        repo: ctx,
      }),
    ),
  ]);
}

async function variableSet(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  const env = takeFlag(args, "--env") ?? "*";
  const isProtected = takeBoolFlag(args, "--protected");
  const value = resolveValue(args, "variable");
  const name = requireName(args, "variable");

  const { variable, created, unchanged } = await upsertVariable(
    ctx,
    name,
    value,
    { masked: false, protected: isProtected, env },
  );

  return renderOutput([
    renderDetail(
      created ? "created" : unchanged ? "variable" : "updated",
      {
        key: variable.key ?? name,
        masked: false,
        protected: variable.protected ?? isProtected,
        env: variable.environment_scope ?? env,
        ...(unchanged ? { already: true } : {}),
      },
      [
        field("key"),
        boolYesNo("masked"),
        boolYesNo("protected"),
        field("env"),
        ...(unchanged ? [field("already")] : []),
      ],
    ),
    renderHelp(
      getSuggestions({
        domain: "variable",
        action: "set",
        id: name,
        repo: ctx,
      }),
    ),
  ]);
}

async function variableDelete(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const env = takeFlag(args, "--env") ?? "*";
  const name = requireName(args, "variable");
  return deleteVariable(ctx, "variable", name, env);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function variableCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return variableList(rest, ctx);
    case "get":
    case "view":
      return variableGet(rest, ctx);
    case "set":
      return variableSet(rest, ctx);
    case "delete":
    case "rm":
      return variableDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return VARIABLE_HELP;
    default:
      return refuseSubcommand("variable", sub, VARIABLE_HELP);
  }
}
