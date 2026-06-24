import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { encode } from "@toon-format/toon";
import {
  field,
  lower,
  pluck,
  renderList,
  renderHelp,
  renderOutput,
} from "../toon.js";
import { projectLabel } from "../suggestions.js";

export const HOME_HELP = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const issueSchema = [
  field("iid", "iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
];

const mrSchema = [
  field("iid", "iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
];

/**
 * Dashboard: the no-args view. Shows the most relevant live project state so an
 * agent can act immediately. Errors in either query degrade to an empty list.
 */
export async function homeCommand(
  _args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  if (!ctx) {
    return renderOutput([
      "project: none - not inside a GitLab checkout",
      renderHelp([
        "Run `glab-axi <command> -R <group/project>` to target a project",
        "Run `glab-axi setup hooks` to inject ambient context each session",
      ]),
    ]);
  }

  const pid = projectId(ctx);
  const [issues, mrs] = await Promise.all([
    glApi<Json[]>(
      `projects/${pid}/issues?state=opened&per_page=3&order_by=updated_at`,
      {
        ctx,
      },
    ).catch(() => [] as Json[]),
    glApi<Json[]>(
      `projects/${pid}/merge_requests?state=opened&per_page=3&order_by=updated_at`,
      { ctx },
    ).catch(() => [] as Json[]),
  ]);

  const blocks: string[] = [];
  const label = projectLabel(ctx);
  if (label) blocks.push(encode({ project: label }));

  blocks.push(
    issues.length
      ? renderList("issues", issues, issueSchema)
      : "issues: 0 open",
  );
  blocks.push(mrs.length ? renderList("mrs", mrs, mrSchema) : "mrs: 0 open");

  const hints: string[] = [];
  if (issues.length >= 3)
    hints.push("Run `glab-axi issue list` for all issues");
  if (mrs.length >= 3)
    hints.push("Run `glab-axi mr list` for all merge requests");
  hints.push(
    "Run `glab-axi <command> <subcommand>` - commands: issue, mr, ci, project, label, release, search, api",
  );
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}
