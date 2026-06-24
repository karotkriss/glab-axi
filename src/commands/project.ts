import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { hasFlag, getFlag, takeBoolFlag } from "../args.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import {
  field,
  lower,
  pluck,
  relativeTime,
  custom,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type Def,
} from "../toon.js";

export const PROJECT_HELP = `usage: glab-axi project <subcommand> [flags]
subcommands:
  view, list
flags{view}:
  shows path, name, description, default branch, visibility, stars, forks, open issues
flags{list}:
  --owned, --search <text>, --limit <n> (default 30)
examples:
  glab-axi project view
  glab-axi project view -R group/proj
  glab-axi project list --owned
  glab-axi project list --search payments
notes:
  'project view' is a detail view of the resolved project (-R or git checkout).
  'project list' searches projects you are a member of; it does not need a
  project context, so it works from anywhere.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const listSchema: Def[] = [
  field("path_with_namespace", "path"),
  custom("description", (p: Json) => p.description ?? ""),
  lower("visibility"),
  field("default_branch", "default_branch"),
  field("star_count", "stars"),
];

const viewSchema: Def[] = [
  field("id"),
  field("path_with_namespace", "path"),
  field("name"),
  custom("description", (p: Json) => p.description ?? ""),
  field("default_branch"),
  lower("visibility"),
  pluck("namespace", "full_path", "namespace"),
  field("star_count", "stars"),
  field("forks_count", "forks"),
  field("open_issues_count", "open_issues"),
  relativeTime("last_activity_at", "last_activity"),
  field("web_url", "url"),
];

function requireCtx(ctx: RepoContext | undefined): RepoContext {
  if (!ctx) {
    throw new AxiError(
      "Could not determine the GitLab project - pass -R <group/project> or run inside a git checkout",
      "VALIDATION_ERROR",
    );
  }
  return ctx;
}

async function viewProject(
  _args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const project = await glApi<Json>(`projects/${projectId(repo)}`, {
    ctx: repo,
  });
  return renderOutput([renderDetail("project", project, viewSchema)]);
}

async function listProjects(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const owned = takeBoolFlag(args, "--owned");
  const search = getFlag(args, "--search");
  const limit = parseInt(getFlag(args, "--limit") ?? "30", 10);

  const params = new URLSearchParams();
  params.set("membership", "true");
  params.set("owned", String(owned));
  if (search) params.set("search", search);
  params.set("per_page", String(limit));
  params.set("order_by", "last_activity_at");

  const items = await glApi<Json[]>(`projects?${params.toString()}`, { ctx });
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("projects", items, listSchema),
  ];
  const help = isEmpty
    ? [
        "Run `glab-axi project list --search <text>` to broaden the search",
        "Run `glab-axi project list` without --owned to include projects you only contribute to",
      ]
    : [
        `Run \`glab-axi${repoFlag(ctx)} project view -R <path>\` for details on a project`,
        "Run `glab-axi project list --search <text>` to filter by name",
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

export async function projectCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([PROJECT_HELP]);
  switch (sub) {
    case "view":
      return viewProject(args, ctx);
    case "list":
      return listProjects(args, ctx);
    default:
      return renderError(
        `unknown project subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi project --help` for usage"],
      );
  }
}
