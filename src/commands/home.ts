import { encode } from "@toon-format/toon";
import { glApi, projectId, type Json } from "../gl.js";
import { scrubTool } from "../errors.js";
import type { RepoContext } from "../context.js";
import {
  field,
  pluck,
  lower,
  boolYesNo,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";
import { getSuggestions } from "../suggestions.js";

export const HOME_HELP = "";

const issueSchema = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
];

const mrSchema = [
  field("iid"),
  field("title"),
  pluck("author", "username", "author"),
  boolYesNo("draft", "draft"),
];

/** Rows from a settled fetch, or [] for the shapes that carry no rows. */
function rowsOf(result: PromiseSettledResult<Json[]>): Json[] {
  return result.status === "fulfilled" ? (result.value ?? []) : [];
}

/**
 * Render one dashboard section.
 *
 * A rejected fetch renders `unavailable` with the reason rather than a count.
 * "0 open" and "could not ask the server" are opposite facts, and an agent
 * reading the dashboard cannot tell them apart after the fact, so a count is
 * only ever printed when one was actually received.
 */
function renderSection(
  label: string,
  result: PromiseSettledResult<Json[]>,
  schema: FieldDef[],
): string {
  if (result.status === "rejected") {
    const reason: unknown = result.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    return `${label}: unavailable - ${scrubTool(message) || "request failed"}`;
  }
  const items = rowsOf(result);
  return items.length ? renderList(label, items, schema) : `${label}: 0 open`;
}

export async function homeCommand(
  _args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const blocks: string[] = [];
  const hints: string[] = [];

  if (ctx?.project) {
    const pid = projectId(ctx);
    const [issues, mrs] = await Promise.allSettled([
      glApi<Json[]>(
        `projects/${pid}/issues?state=opened&per_page=3&order_by=updated_at`,
        { ctx },
      ),
      glApi<Json[]>(
        `projects/${pid}/merge_requests?state=opened&per_page=3&order_by=updated_at`,
        { ctx },
      ),
    ]);
    blocks.push(encode({ project: ctx.project }));
    blocks.push(renderSection("issues", issues, issueSchema));
    blocks.push(renderSection("merge_requests", mrs, mrSchema));
    if (rowsOf(issues).length >= 3)
      hints.push("Run `glab-axi issue list` for the full issue list");
    if (rowsOf(mrs).length >= 3)
      hints.push("Run `glab-axi mr list` for the full merge request list");
  } else {
    // Nothing was asked of any server, so nothing is claimed about one.
    blocks.push("project: none");
    hints.push(
      "No GitLab project resolved here - pass `-R [host/]group/project` after a command, or run inside a git repository whose origin remote points at a GitLab instance",
    );
  }

  const suggestions = getSuggestions({
    domain: "home",
    action: "home",
    repo: ctx,
  });
  blocks.push(renderHelp([...hints, ...suggestions]));
  return renderOutput(blocks);
}
