import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { hasFlag, getFlag } from "../args.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import {
  field,
  lower,
  pluck,
  relativeTime,
  renderList,
  renderHelp,
  renderError,
  renderOutput,
  type Def,
} from "../toon.js";

export const SEARCH_HELP = `usage: glab-axi search <issues|mrs|projects> "<query>" [flags]
types:
  issues, mrs, projects
flags:
  --limit <n> (default 30); search is scoped to the resolved project for issues/mrs
examples:
  glab-axi search issues "login bug"
  glab-axi search mrs "refactor"
  glab-axi search projects "payments"`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SEARCH_TYPES = ["issues", "mrs", "projects"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const issueSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  field("web_url", "url"),
  relativeTime("created_at", "created"),
];

const mrSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  field("web_url", "url"),
  relativeTime("created_at", "created"),
];

const projectSchema: Def[] = [
  field("path_with_namespace", "path"),
  field("description"),
  field("star_count", "stars"),
  relativeTime("last_activity_at", "activity"),
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

/** Collect the query: every non-flag positional after the type, joined by space. */
function readQuery(args: string[]): string {
  const positionals = args.filter((a) => !a.startsWith("-"));
  return positionals.slice(1).join(" ").trim();
}

async function searchIssues(
  query: string,
  limit: number,
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
  });
  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/issues?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("issues", items, issueSchema),
  ];
  const help = isEmpty
    ? [
        `No issues match "${query}" in this project - try a broader query or \`glab-axi${repoFlag(repo)} search projects "${query}"\``,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} issue view <iid>\` for details`,
        `Narrow or widen with a different query or --limit <n>`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function searchMrs(
  query: string,
  limit: number,
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
  });
  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/merge_requests?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("merge_requests", items, mrSchema),
  ];
  const help = isEmpty
    ? [
        `No merge requests match "${query}" in this project - try a broader query or --limit <n>`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} mr view <iid>\` for details`,
        `Run \`glab-axi${repoFlag(repo)} mr merge <iid>\` to merge`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function searchProjects(query: string, limit: number): Promise<string> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    order_by: "last_activity_at",
  });
  const items = await glApi<Json[]>(`projects?${params.toString()}`);
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("projects", items, projectSchema),
  ];
  const help = isEmpty
    ? [`No projects match "${query}" - try a broader query`]
    : [
        `Run \`glab-axi -R <path> issue list\` against a result's path`,
        `Use a result's path with -R to scope other commands to it`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

export async function searchCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const type = args[0];
  if (!type || hasFlag(args, "--help")) return renderOutput([SEARCH_HELP]);

  if (!SEARCH_TYPES.includes(type as SearchType)) {
    return renderError(`unknown search type: ${type}`, "VALIDATION_ERROR", [
      `Valid types: ${SEARCH_TYPES.join(", ")}`,
      "Run `glab-axi search --help` for usage",
    ]);
  }

  const query = readQuery(args);
  if (query === "") {
    throw new AxiError("search requires a query", "VALIDATION_ERROR");
  }

  const limit = parseInt(getFlag(args, "--limit") ?? "30", 10);

  switch (type as SearchType) {
    case "issues":
      return searchIssues(query, limit, ctx);
    case "mrs":
      return searchMrs(query, limit, ctx);
    case "projects":
      return searchProjects(query, limit);
  }
}
