import { glApi, projectId, requireProject, type Json } from "../gl.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, parseLimit } from "../args.js";
import {
  field,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const viewSchema: FieldDef[] = [
  field("path_with_namespace", "project"),
  field("description"),
  field("default_branch"),
  lower("visibility"),
  field("star_count", "stars"),
  field("forks_count", "forks"),
  field("open_issues_count", "open_issues"),
  relativeTime("last_activity_at", "last_activity"),
  field("web_url", "url"),
];

const listSchema: FieldDef[] = [
  field("path_with_namespace", "project"),
  field("description"),
  field("default_branch"),
  relativeTime("last_activity_at", "last_activity"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const PROJECT_HELP = `usage: glab-axi project <subcommand> [flags]
subcommands[2]:
  view, list
flags{view}:
  (none — addresses the resolved project)
flags{list}:
  --search <q>, --limit <n> (default 30)
examples:
  glab-axi project view -R gitlab.example.com/group/project
  glab-axi project list --search platform
  glab-axi project list --limit 50`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function projectView(ctx?: RepoContext): Promise<string> {
  // requireProject throws an actionable error when ctx is unresolved.
  requireProject(ctx);
  const proj = await glApi<Json>(`projects/${projectId(ctx)}`, { ctx });
  return renderOutput([
    renderDetail("project", proj, viewSchema),
    renderHelp(
      getSuggestions({ domain: "project", action: "view", repo: ctx }),
    ),
  ]);
}

async function projectList(args: string[], ctx?: RepoContext): Promise<string> {
  const search = takeFlag(args, "--search");
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  params.set("membership", "true");
  params.set("per_page", String(limit));
  params.set("order_by", "last_activity_at");
  if (search) params.set("search", search);

  const items =
    (await glApi<Json[]>(`projects?${params.toString()}`, { ctx })) ?? [];
  const isEmpty = items.length === 0;

  if (isEmpty) {
    return renderOutput([
      "projects: 0 projects found",
      renderHelp(
        getSuggestions({
          domain: "project",
          action: "list",
          isEmpty,
          repo: ctx,
        }),
      ),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: items.length, limit }),
    renderList("projects", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "project", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function projectCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "view":
      return projectView(ctx);
    case "list":
      return projectList(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return PROJECT_HELP;
    default:
      return renderError(
        `Unknown project subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi project --help` to see available subcommands"],
      );
  }
}
