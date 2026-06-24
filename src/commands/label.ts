import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { hasFlag, getFlag, getPositional } from "../args.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import {
  field,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type Def,
} from "../toon.js";

export const LABEL_HELP = `usage: glab-axi label <subcommand> [flags]
subcommands:
  list, create, delete <name>
flags{list}:
  --limit <n> (default 100)
flags{create}:
  --name <text> (required), --color <#hex> (required), --description <text>
examples:
  glab-axi label list
  glab-axi label create --name bug --color "#d9534f" --description "Something broken"
  glab-axi label delete bug
notes:
  create and delete are idempotent: creating a label that already exists (by
  name, case-insensitive) and deleting one that is already gone both succeed.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const listSchema: Def[] = [field("name"), field("color"), field("description")];

function requireCtx(ctx: RepoContext | undefined): RepoContext {
  if (!ctx) {
    throw new AxiError(
      "Could not determine the GitLab project - pass -R <group/project> or run inside a git checkout",
      "VALIDATION_ERROR",
    );
  }
  return ctx;
}

async function fetchLabels(repo: RepoContext, limit: number): Promise<Json[]> {
  return glApi<Json[]>(`projects/${projectId(repo)}/labels?per_page=${limit}`, {
    ctx: repo,
  });
}

async function listLabels(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const limit = parseInt(getFlag(args, "--limit") ?? "100", 10);

  const items = await fetchLabels(repo, limit);
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("labels", items, listSchema),
  ];
  const help = isEmpty
    ? [
        `Run \`glab-axi${repoFlag(repo)} label create --name <name> --color "#hex"\` to add one`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} label create --name <name> --color "#hex"\` to add one`,
        `Run \`glab-axi${repoFlag(repo)} label delete <name>\` to remove one`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function createLabel(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const name = getFlag(args, "--name");
  if (!name) throw new AxiError("--name is required", "VALIDATION_ERROR");
  const color = getFlag(args, "--color");
  if (!color) throw new AxiError("--color is required", "VALIDATION_ERROR");
  const description = getFlag(args, "--description");

  // Idempotent: if a label with this name already exists, no-op.
  const existing = await fetchLabels(repo, 100);
  const match = existing.find(
    (l) =>
      typeof l.name === "string" && l.name.toLowerCase() === name.toLowerCase(),
  );
  if (match) {
    return renderOutput([
      renderDetail("label", { ...match, status: "already exists" }, [
        field("name"),
        field("color"),
        field("description"),
        field("status"),
      ]),
      renderHelp([
        `Run \`glab-axi${repoFlag(repo)} label list\` to see all labels`,
      ]),
    ]);
  }

  const fields: Record<string, string> = { name, color };
  if (description) fields["description"] = description;

  const created = await glApi<Json>(`projects/${projectId(repo)}/labels`, {
    method: "POST",
    fields,
    ctx: repo,
  });
  return renderOutput([
    renderDetail("created", created, [
      field("name"),
      field("color"),
      field("description"),
    ]),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} label list\` to see all labels`,
    ]),
  ]);
}

async function deleteLabel(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const name = getPositional(args, 1);
  if (!name) throw new AxiError("label name is required", "VALIDATION_ERROR");

  try {
    await glApi(
      `projects/${projectId(repo)}/labels/${encodeURIComponent(name)}`,
      { method: "DELETE", ctx: repo },
    );
  } catch (err) {
    // Idempotent: a label that is already gone is a successful no-op.
    if (err instanceof AxiError && err.code === "NOT_FOUND") {
      return renderOutput([
        renderDetail("label", { name, status: "already deleted" }, [
          field("name"),
          field("status"),
        ]),
      ]);
    }
    throw err;
  }
  return renderOutput([
    renderDetail("deleted", { name, status: "deleted" }, [
      field("name"),
      field("status"),
    ]),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} label list\` to see remaining labels`,
    ]),
  ]);
}

export async function labelCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([LABEL_HELP]);
  switch (sub) {
    case "list":
      return listLabels(args, ctx);
    case "create":
      return createLabel(args, ctx);
    case "delete":
      return deleteLabel(args, ctx);
    default:
      return renderError(
        `unknown label subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi label --help` for usage"],
      );
  }
}
