import { glApi, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import { takeFlag, parseLimit } from "../args.js";
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
import {
  variablesPath,
  requireName,
  upsertVariable,
  deleteVariable,
} from "./variable.js";

// ---------------------------------------------------------------------------
// `secret` is the masked+protected view of GitLab's CI/CD Variables API.
// `set` always creates a masked & protected variable; `list` shows only the
// masked variables and never reveals their values. The plain-variable surface
// lives in variable.ts, whose helpers this file reuses.
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("key"),
  boolYesNo("protected"),
  field("environment_scope", "env"),
];

export const SECRET_HELP = `usage: glab-axi secret <subcommand> [flags]
subcommands[3]:
  list, set <name>, delete <name>
maps to masked & protected GitLab CI/CD variables; \`list\` never reveals values
flags{list}:
  --limit <n> (default 100)
flags{set,delete,rm}:
  --env <scope> (environment scope, default "*")
flags{set}:
  --value (refused: secret values are stdin-only - pipe the value instead)
notes:
  \`set\` reads the value from piped stdin only; \`--value\` is refused because
  a flag value is visible in the process argv (use \`variable set\` for
  non-secret values).
  GitLab requires masked values to meet its masking rules (>= 8 chars, no
  whitespace, base64 alphabet); a value that fails is rejected as a validation error.
examples:
  glab-axi secret list
  printf %s "sk-..." | glab-axi secret set OPENAI_API_KEY
  glab-axi secret delete OPENAI_API_KEY`;

async function secretList(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 100);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));

  const all =
    (await glApi<Json[]>(`${variablesPath(ctx)}?${params.toString()}`, {
      ctx,
    })) ?? [];
  // Only masked variables are "secrets"; render key + flags, never the value.
  const items = all.filter((v) => v.masked);
  const isEmpty = items.length === 0;
  // A full raw page means more variables may exist beyond it, even after the
  // masked filter shrinks the visible count below `limit`.
  const truncated = all.length === limit;

  if (isEmpty) {
    return renderOutput([
      "secrets: 0 secrets found",
      renderHelp(
        getSuggestions({
          domain: "secret",
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
    renderList("secrets", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "secret", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

/**
 * Secret values are stdin-only: a `--value` on argv is visible to every
 * process listing (`ps`, `/proc/<pid>/cmdline`), which is exactly where a
 * masked CI/CD credential must not appear. The flag stays declared in
 * SECRET_HELP so this guiding refusal fires instead of a generic
 * unknown-flag error. Plain variables keep `--value` in variable.ts.
 *
 * This refusal is only honest because the value also stays off the CHILD's
 * argv: `upsertVariable` hands it over via stdin (`-F value=@-`). Refusing the
 * flag here while passing the same secret to a subprocess as `-f value=<it>`
 * left it world-readable anyway and told the caller it was protected - the
 * refusal has to be backed by the path it redirects to, or it is just a
 * comforting message. Do not weaken one half without the other.
 */
const STDIN_ONLY_SUGGESTION = `Pipe the value: \`printf %s "<value>" | glab-axi secret set <name>\``;

function resolveSecretValue(args: string[]): string {
  if (takeFlag(args, "--value") !== undefined) {
    throw new AxiError(
      "Secret values are stdin-only; --value would expose the value in the process argv",
      "VALIDATION_ERROR",
      [STDIN_ONLY_SUGGESTION],
    );
  }
  const value = readStdin().replace(/\r?\n$/, "");
  if (value === "") {
    throw new AxiError("A value is required", "VALIDATION_ERROR", [
      STDIN_ONLY_SUGGESTION,
    ]);
  }
  return value;
}

async function secretSet(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  const env = takeFlag(args, "--env") ?? "*";
  const value = resolveSecretValue(args);
  const name = requireName(args, "secret");

  const { variable, created, unchanged } = await upsertVariable(
    ctx,
    name,
    value,
    { masked: true, protected: true, env },
  );

  return renderOutput([
    renderDetail(
      created ? "created" : unchanged ? "secret" : "updated",
      {
        key: variable.key ?? name,
        masked: true,
        protected: variable.protected ?? true,
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
      getSuggestions({ domain: "secret", action: "set", id: name, repo: ctx }),
    ),
  ]);
}

async function secretDelete(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const env = takeFlag(args, "--env") ?? "*";
  const name = requireName(args, "secret");
  return deleteVariable(ctx, "secret", name, env);
}

export async function secretCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return secretList(rest, ctx);
    case "set":
      return secretSet(rest, ctx);
    case "delete":
    case "rm":
      return secretDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return SECRET_HELP;
    default:
      return refuseSubcommand("secret", sub, SECRET_HELP);
  }
}
