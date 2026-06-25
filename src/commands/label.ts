import { glApi, glApiResult, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, getPositional, parseLimit } from "../args.js";
import {
  field,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelsPath(ctx: RepoContext | undefined, suffix = ""): string {
  return `projects/${requireProject(ctx)}/labels${suffix}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("name"),
  field("color"),
  field("description"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const LABEL_HELP = `usage: glab-axi label <subcommand> [flags]
subcommands[3]:
  list, create, delete <name>
flags{list}:
  --limit <n> (default 100)
flags{create}:
  --name <text> (required), --color <hex> (required, e.g. "#ed9121"), --description <text>
flags{delete}:
  <name> (positional, required)
examples:
  glab-axi label list
  glab-axi label create --name "bug" --color "#d9534f" --description "Something is broken"
  glab-axi label delete bug`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function labelList(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 100);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));

  const items = await glApi<Json[]>(`${labelsPath(ctx)}?${params.toString()}`, {
    ctx,
  });
  const isEmpty = items.length === 0;

  if (isEmpty) {
    return renderOutput([
      "labels: 0 labels found",
      renderHelp(
        getSuggestions({ domain: "label", action: "list", isEmpty, repo: ctx }),
      ),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: items.length, limit }),
    renderList("labels", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "label", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function labelCreate(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  const name = takeFlag(args, "--name");
  if (!name)
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      'glab-axi label create --name "..." --color "#ed9121" [--description "..."]',
    ]);
  const color = takeFlag(args, "--color");
  if (!color)
    throw new AxiError("--color is required", "VALIDATION_ERROR", [
      'glab-axi label create --name "..." --color "#ed9121" [--description "..."]',
    ]);
  const description = takeFlag(args, "--description");

  const rawFields = [`name=${name}`, `color=${color}`];
  if (description !== undefined) rawFields.push(`description=${description}`);

  try {
    const label = await glApi<Json>(labelsPath(ctx), {
      method: "POST",
      rawFields,
      ctx,
    });
    return renderOutput([
      renderDetail(
        "created",
        { name: label.name ?? name, color: label.color ?? color },
        [field("name"), field("color")],
      ),
      renderHelp(
        getSuggestions({ domain: "label", action: "create", repo: ctx }),
      ),
    ]);
  } catch (err) {
    // Idempotent: GitLab returns a 409 ("Label already exists" / "has already
    // been taken") when the label is already present. Treat it as a no-op.
    if (
      err instanceof AxiError &&
      (err.code === "CONFLICT" ||
        /already (exists|been taken|in use)/i.test(err.message))
    ) {
      return renderOutput([
        renderDetail("label", { name, already: true }, [
          field("name"),
          field("already"),
        ]),
        renderHelp(
          getSuggestions({ domain: "label", action: "create", repo: ctx }),
        ),
      ]);
    }
    throw err;
  }
}

async function labelDelete(args: string[], ctx?: RepoContext): Promise<string> {
  const name = getPositional(args, 0);
  if (!name)
    throw new AxiError("Missing label name", "VALIDATION_ERROR", [
      "glab-axi label delete <name>",
    ]);

  const result = await glApiResult(
    labelsPath(ctx, `/${encodeURIComponent(name)}`),
    {
      method: "DELETE",
      ctx,
    },
  );

  // Idempotent: deleting a non-existent label is a no-op success.
  if (result.exitCode !== 0) {
    const body = result.stderr || result.stdout;
    if (/HTTP 404|404 Not Found|not found/i.test(body)) {
      return renderOutput([
        renderDetail("label", { name, already_absent: true }, [
          field("name"),
          field("already_absent"),
        ]),
        renderHelp(
          getSuggestions({ domain: "label", action: "delete", repo: ctx }),
        ),
      ]);
    }
    throw new AxiError(`Failed to delete label: ${name}`, "UNKNOWN", [
      "Run `glab-axi label list` to see existing labels",
    ]);
  }

  return renderOutput([
    renderDetail("deleted", { name, status: "ok" }, [
      field("name"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "label", action: "delete", repo: ctx }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function labelCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return labelList(rest, ctx);
    case "create":
      return labelCreate(rest, ctx);
    case "delete":
    case "rm":
      return labelDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return LABEL_HELP;
    default:
      return renderError(
        `Unknown label subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi label --help` to see available subcommands"],
      );
  }
}
