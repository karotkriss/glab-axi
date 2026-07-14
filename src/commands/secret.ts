import { glApi, requireProject, type Json } from "../gl.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, parseLimit } from "../args.js";
import {
  field,
  boolYesNo,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";
import {
  variablesPath,
  resolveValue,
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
flags{set,delete}:
  --env <scope> (environment scope, default "*")
flags{set}:
  --value <value> (required; reads from piped stdin if omitted)
notes:
  GitLab requires masked values to meet its masking rules (>= 8 chars, no
  whitespace, base64 alphabet); a value that fails is rejected as a validation error.
examples:
  glab-axi secret list
  glab-axi secret set OPENAI_API_KEY --value "sk-..."
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
    formatCountLine({ count: items.length, limit }),
    renderList("secrets", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "secret", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function secretSet(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  const env = takeFlag(args, "--env") ?? "*";
  const value = resolveValue(args, "secret");
  const name = requireName(args, "secret");

  const { variable, created } = await upsertVariable(ctx, name, value, {
    masked: true,
    protected: true,
    env,
  });

  return renderOutput([
    renderDetail(
      created ? "created" : "updated",
      {
        key: variable.key ?? name,
        masked: true,
        protected: variable.protected ?? true,
        env: variable.environment_scope ?? env,
      },
      [field("key"), boolYesNo("masked"), boolYesNo("protected"), field("env")],
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
      return renderError(
        `Unknown secret subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi secret --help` to see available subcommands"],
      );
  }
}
