import { glApi, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import { takeFlag, parseLimit } from "../args.js";
import {
  field,
  pluck,
  lower,
  relativeTime,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

/**
 * Each search type maps to a GitLab global-search scope, a TOON output label,
 * and a render schema. The query is the positional(s) after the subcommand.
 */
interface SearchType {
  /** GitLab `scope` value for the global search API. */
  scope: string;
  /** TOON list label + the noun used in the definitive empty state. */
  label: string;
  schema: FieldDef[];
}

const SEARCH_TYPES: Record<string, SearchType> = {
  issues: {
    scope: "issues",
    label: "issues",
    schema: [
      field("iid"),
      field("title"),
      lower("state"),
      pluck("author", "username", "author"),
      field("project_id", "project"),
    ],
  },
  mrs: {
    scope: "merge_requests",
    label: "merge_requests",
    schema: [
      field("iid"),
      field("title"),
      lower("state"),
      pluck("author", "username", "author"),
      field("project_id", "project"),
    ],
  },
  projects: {
    scope: "projects",
    label: "projects",
    schema: [
      field("path_with_namespace", "project"),
      field("description"),
      field("star_count", "stars"),
      relativeTime("last_activity_at", "updated"),
    ],
  },
};

const VALID_TYPES = Object.keys(SEARCH_TYPES);

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const SEARCH_HELP = `usage: glab-axi search <type> "<query>" [flags]
types[3]:
  issues, mrs, projects
flags:
  --limit <n> (default 30)
notes:
  Searches GitLab globally (scope=issues|merge_requests|projects) across all
  projects you can access, not just the current repo. The query is the text
  after the type and may contain spaces.
examples:
  glab-axi search issues "login bug"
  glab-axi search mrs "flaky test"
  glab-axi search projects "design system"`;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch(
  type: string,
  spec: SearchType,
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 30);
  // Everything left that is not a flag is part of the query.
  const query = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (query === "") {
    throw new AxiError(
      `A search query is required for \`search ${type}\``,
      "VALIDATION_ERROR",
      [`Run \`glab-axi search ${type} "<query>"\``],
    );
  }

  const params = new URLSearchParams();
  params.set("scope", spec.scope);
  params.set("search", query);
  params.set("per_page", String(limit));

  const items = await glApi<Json[]>(`search?${params.toString()}`, { ctx });
  const results = items ?? [];
  const isEmpty = results.length === 0;

  if (isEmpty) {
    return renderOutput([
      `${spec.label}: 0 results for "${query}"`,
      renderHelp(getSuggestions({ domain: "search", action: type, repo: ctx })),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: results.length, limit }),
    renderList(spec.label, results, spec.schema),
    renderHelp(getSuggestions({ domain: "search", action: type, repo: ctx })),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function searchCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const type = args[0];
  const rest = args.slice(1);
  switch (type) {
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return SEARCH_HELP;
    default: {
      const spec = SEARCH_TYPES[type];
      if (!spec) {
        refuseSubcommand("search", type, {
          message: `Unknown search type: ${type}`,
          help: [
            `Valid types: ${VALID_TYPES.join(", ")}`,
            `Run \`glab-axi search ${VALID_TYPES[0]} "<query>"\``,
          ],
        });
      }
      return runSearch(type, spec, rest, ctx);
    }
  }
}
