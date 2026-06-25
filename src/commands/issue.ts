import { glApi, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, takeBoolFlag, takeNumber, parseLimit } from "../args.js";
import { parseFields, type FieldSpec } from "../fields.js";
import { resolveUserId, resolveMilestoneId } from "../resolve.js";
import {
  field,
  pluck,
  lower,
  relativeTime,
  joinArray,
  custom,
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

/** Map a user-facing state to the GitLab issue state value. */
function mapState(input: string | undefined): string {
  switch ((input ?? "opened").toLowerCase()) {
    case "open":
    case "opened":
      return "opened";
    case "closed":
      return "closed";
    case "all":
      return "all";
    default:
      return input!.toLowerCase();
  }
}

function issuePath(
  ctx: RepoContext | undefined,
  iid: number,
  suffix = "",
): string {
  return `projects/${requireProject(ctx)}/issues/${iid}${suffix}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  joinArray("labels", "name", "labels"),
];

const LIST_EXTRA_FIELDS: Record<string, FieldSpec> = {
  created: {
    jsonKey: "created_at",
    def: relativeTime("created_at", "created"),
  },
  updated: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  milestone: {
    jsonKey: "milestone",
    def: pluck("milestone", "title", "milestone"),
  },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
  assignees: {
    jsonKey: "assignees",
    def: joinArray("assignees", "username", "assignees"),
  },
};

function viewSchema(full: boolean): FieldDef[] {
  const base: FieldDef[] = [
    field("iid"),
    field("title"),
    lower("state"),
    pluck("author", "username", "author"),
    joinArray("labels", "name", "labels"),
    pluck("milestone", "title", "milestone"),
  ];
  if (full) {
    base.push(
      custom("body", (i) =>
        typeof i.description === "string" ? i.description : "",
      ),
    );
  } else {
    base.push(
      custom("body", (i) => truncateBody(i.description, 500)),
      custom(
        "comments",
        (i) => `${i.user_notes_count ?? 0} — use --comments to read them`,
      ),
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const ISSUE_HELP = `usage: glab-axi issue <subcommand> [flags]
subcommands[7]:
  list, view <iid>, create, edit <iid>, close <iid>, reopen <iid>, comment <iid>
flags{list}:
  --state <open|closed|all>, --label, --author <user>, --assignee <user>, --milestone <name>, --limit <n> (default 30), --fields <a,b,c>
flags{view}:
  --comments (include discussion notes), --full (full body)
flags{create}:
  --title <text> (required), --body <text> or --body-file <path>, --label <a,b>, --assignee <user>, --milestone <name>, --confidential
flags{edit}:
  --title, --body or --body-file, --label, --assignee <user>, --milestone <name>
flags{close}:
  (none)
flags{reopen}:
  (none)
flags{comment}:
  --body <text> or --body-file <path> (required)
examples:
  glab-axi issue list --state opened --label bug
  glab-axi issue view 42 --comments
  glab-axi issue create --title "Fix X" --body-file ./desc.md
  glab-axi issue close 42
  glab-axi issue edit 42 --assignee alice`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function issueList(args: string[], ctx?: RepoContext): Promise<string> {
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, LIST_EXTRA_FIELDS);
  const state = mapState(takeFlag(args, "--state"));
  const label = takeFlag(args, "--label");
  const author = takeFlag(args, "--author");
  const assignee = takeFlag(args, "--assignee");
  const milestone = takeFlag(args, "--milestone");
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (label) params.set("labels", label);
  if (author) params.set("author_username", author);
  if (assignee) params.set("assignee_username", assignee);
  if (milestone) params.set("milestone", milestone);
  params.set("per_page", String(limit));
  params.set("order_by", "updated_at");

  const items =
    (await glApi<Json[]>(
      `projects/${requireProject(ctx)}/issues?${params.toString()}`,
      { ctx },
    )) ?? [];
  const isEmpty = items.length === 0;
  const countLine = formatCountLine({ count: items.length, limit });
  const schema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;

  if (isEmpty) {
    return renderOutput([
      "issues: 0 matching issues found",
      renderHelp(
        getSuggestions({ domain: "issue", action: "list", isEmpty, repo: ctx }),
      ),
    ]);
  }
  return renderOutput([
    countLine,
    renderList("issues", items, schema),
    renderHelp(
      getSuggestions({ domain: "issue", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function issueView(args: string[], ctx?: RepoContext): Promise<string> {
  const includeComments = takeBoolFlag(args, "--comments");
  const full = takeBoolFlag(args, "--full");
  const iid = takeNumber(args, "issue");
  const issue = await glApi<Json>(issuePath(ctx, iid), { ctx });

  const schema = viewSchema(full);
  if (includeComments) {
    const notes = await glApi<Json[]>(
      `${issuePath(ctx, iid, "/notes")}?per_page=100&sort=asc`,
      { ctx },
    );
    const real = (notes ?? []).filter((n) => !n.system);
    schema.push(
      custom("comments", () =>
        real.map((n) => ({
          author: n.author?.username ?? "unknown",
          body: n.body ?? "",
          created: n.created_at ?? "",
        })),
      ),
    );
  }
  return renderOutput([
    renderDetail("issue", issue, schema),
    renderHelp(
      getSuggestions({
        domain: "issue",
        action: "view",
        id: iid,
        state: issue.state,
        repo: ctx,
      }),
    ),
  ]);
}

async function issueCreate(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  const title = takeFlag(args, "--title");
  if (!title)
    throw new AxiError("--title is required", "VALIDATION_ERROR", [
      'glab-axi issue create --title "..." [--body-file <path>]',
    ]);
  const body = takeBody(args);
  const label = takeFlag(args, "--label");
  const assignee = takeFlag(args, "--assignee");
  const milestone = takeFlag(args, "--milestone");
  const confidential = takeBoolFlag(args, "--confidential");

  const rawFields = [`title=${title}`];
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (label) rawFields.push(`labels=${label}`);
  const fields: string[] = [];
  if (assignee)
    fields.push(`assignee_ids=${await resolveUserId(assignee, ctx)}`);
  if (milestone)
    fields.push(`milestone_id=${await resolveMilestoneId(milestone, ctx)}`);
  if (confidential) fields.push("confidential=true");

  const issue = await glApi<Json>(`projects/${requireProject(ctx)}/issues`, {
    method: "POST",
    rawFields,
    fields,
    ctx,
  });
  return renderOutput([
    renderDetail(
      "created",
      { iid: issue.iid, title: issue.title, url: issue.web_url },
      [field("iid"), field("title"), field("url")],
    ),
    renderHelp(
      getSuggestions({
        domain: "issue",
        action: "create",
        id: issue.iid,
        repo: ctx,
      }),
    ),
  ]);
}

async function issueEdit(args: string[], ctx?: RepoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const label = takeFlag(args, "--label");
  const milestone = takeFlag(args, "--milestone");
  const assignee = takeFlag(args, "--assignee");
  const iid = takeNumber(args, "issue");

  const rawFields: string[] = [];
  const fields: string[] = [];
  if (title) rawFields.push(`title=${title}`);
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (label) rawFields.push(`labels=${label}`);
  if (milestone)
    fields.push(`milestone_id=${await resolveMilestoneId(milestone, ctx)}`);
  if (assignee)
    fields.push(`assignee_ids=${await resolveUserId(assignee, ctx)}`);

  if (rawFields.length === 0 && fields.length === 0) {
    throw new AxiError("No update flags provided", "VALIDATION_ERROR", [
      "Pass at least one of --title, --body, --label, --assignee, --milestone",
    ]);
  }

  const result = await glApi<Json>(issuePath(ctx, iid), {
    method: "PUT",
    rawFields,
    fields,
    ctx,
  });
  return renderOutput([
    renderDetail(
      "updated",
      { iid: result.iid, title: result.title, state: result.state },
      [field("iid"), field("title"), lower("state")],
    ),
    renderHelp(
      getSuggestions({ domain: "issue", action: "edit", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueClose(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");
  const issue = await glApi<Json>(issuePath(ctx, iid), { ctx });
  if ((issue.state ?? "") === "closed") {
    return renderOutput([
      renderDetail("issue", { iid, state: "closed", already: true }, [
        field("iid"),
        field("state"),
        field("already"),
      ]),
      renderHelp(
        getSuggestions({
          domain: "issue",
          action: "close",
          id: iid,
          repo: ctx,
        }),
      ),
    ]);
  }
  const result = await glApi<Json>(issuePath(ctx, iid), {
    method: "PUT",
    fields: ["state_event=close"],
    ctx,
  });
  return renderOutput([
    renderDetail(
      "closed",
      { iid: result.iid ?? iid, state: result.state ?? "closed" },
      [field("iid"), lower("state")],
    ),
    renderHelp(
      getSuggestions({ domain: "issue", action: "close", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueReopen(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");
  const issue = await glApi<Json>(issuePath(ctx, iid), { ctx });
  if ((issue.state ?? "") === "opened") {
    return renderOutput([
      renderDetail("issue", { iid, state: "opened", already: true }, [
        field("iid"),
        field("state"),
        field("already"),
      ]),
      renderHelp(
        getSuggestions({
          domain: "issue",
          action: "reopen",
          id: iid,
          repo: ctx,
        }),
      ),
    ]);
  }
  const result = await glApi<Json>(issuePath(ctx, iid), {
    method: "PUT",
    fields: ["state_event=reopen"],
    ctx,
  });
  return renderOutput([
    renderDetail(
      "reopened",
      { iid: result.iid ?? iid, state: result.state ?? "opened" },
      [field("iid"), lower("state")],
    ),
    renderHelp(
      getSuggestions({ domain: "issue", action: "reopen", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueComment(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const body = takeBody(args, { required: true });
  const iid = takeNumber(args, "issue");
  await glApi<Json>(issuePath(ctx, iid, "/notes"), {
    method: "POST",
    rawFields: [`body=${body}`],
    ctx,
  });
  return renderOutput([
    renderDetail("commented", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({
        domain: "issue",
        action: "comment",
        id: iid,
        repo: ctx,
      }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function issueCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return issueList(rest, ctx);
    case "view":
      return issueView(rest, ctx);
    case "create":
      return issueCreate(rest, ctx);
    case "edit":
    case "update":
      return issueEdit(rest, ctx);
    case "close":
      return issueClose(rest, ctx);
    case "reopen":
      return issueReopen(rest, ctx);
    case "comment":
      return issueComment(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return ISSUE_HELP;
    default:
      return renderError(
        `Unknown issue subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi issue --help` to see available subcommands"],
      );
  }
}
