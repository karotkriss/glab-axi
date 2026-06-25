import { encode } from "@toon-format/toon";
import { glApi, projectId, type Json } from "../gl.js";
import type { RepoContext } from "../context.js";
import {
  field,
  pluck,
  lower,
  boolYesNo,
  renderList,
  renderHelp,
  renderOutput,
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

export async function homeCommand(
  _args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const pid = projectId(ctx);
  const [issues, mrs] = await Promise.all([
    glApi<Json[]>(
      `projects/${pid}/issues?state=opened&per_page=3&order_by=updated_at`,
      { ctx },
    ).catch(() => [] as Json[]),
    glApi<Json[]>(
      `projects/${pid}/merge_requests?state=opened&per_page=3&order_by=updated_at`,
      { ctx },
    ).catch(() => [] as Json[]),
  ]);

  const blocks: string[] = [];
  if (ctx) {
    blocks.push(encode({ project: ctx.project }));
  }
  blocks.push(
    issues.length
      ? renderList("issues", issues, issueSchema)
      : "issues: 0 open",
  );
  blocks.push(
    mrs.length
      ? renderList("merge_requests", mrs, mrSchema)
      : "merge_requests: 0 open",
  );

  const hints: string[] = [];
  if (issues.length >= 3)
    hints.push("Run `glab-axi issue list` for the full issue list");
  if (mrs.length >= 3)
    hints.push("Run `glab-axi mr list` for the full merge request list");
  const suggestions = getSuggestions({
    domain: "home",
    action: "home",
    repo: ctx,
  });
  blocks.push(renderHelp([...hints, ...suggestions]));
  return renderOutput(blocks);
}
