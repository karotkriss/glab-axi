import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import {
  hasFlag,
  getFlag,
  takeFlag,
  getPositional,
  requireNumber,
} from "../args.js";
import { takeBody, truncateBody } from "../body.js";
import { parseFields, type ExtraField } from "../fields.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import {
  field,
  lower,
  pluck,
  joinArray,
  relativeTime,
  custom,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type Def,
} from "../toon.js";

export const ISSUE_HELP = `usage: glab-axi issue <subcommand> [flags]
subcommands:
  list, view <iid>, create, edit <iid>, close <iid>, reopen <iid>, comment <iid>
flags{list}:
  --state <opened|closed|all>, --label <name>, --assignee <user>, --author <user>, --milestone <name>, --limit <n> (default 30), --fields <a,b,c>
flags{view}:
  --comments, --full
flags{create}:
  --title <text> (required), --body <text> or --body-file <path>, --label <name>, --assignee <user>, --milestone <name>
flags{edit}:
  --title, --body/--body-file, --add-label, --remove-label, --assignee, --milestone
flags{comment}:
  --body <text> or --body-file <path> (required)
examples:
  glab-axi issue list --state opened --label bug
  glab-axi issue view 42 --comments
  glab-axi issue create --title "Fix login" --body-file notes.md
notes:
  Issues are addressed by IID. 'issue close'/'reopen' are idempotent - they
  GET current state first and no-op (exit 0) when already in the target state.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const listSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  relativeTime("created_at", "created"),
];

const viewSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  joinArray("labels", "name", "labels"),
  pluck("milestone", "title", "milestone"),
  relativeTime("created_at", "created"),
  relativeTime("updated_at", "updated"),
  field("web_url", "url"),
  custom("body", (i: Json) => truncateBody(i.description, 500)),
];

const viewSchemaFull: Def[] = viewSchema.map((d) =>
  d.type === "custom" && d.as === "body"
    ? custom("body", (i: Json) =>
        typeof i.description === "string" ? i.description : "",
      )
    : d,
);

const createdSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  field("web_url", "url"),
];

const noteSchema: Def[] = [
  pluck("author", "username", "author"),
  relativeTime("created_at", "created"),
  custom("body", (n: Json) => truncateBody(n.body, 800)),
];

const ISSUE_LIST_EXTRA_FIELDS: Record<string, ExtraField> = {
  labels: { jsonKey: "labels", def: joinArray("labels", "name", "labels") },
  milestone: {
    jsonKey: "milestone",
    def: pluck("milestone", "title", "milestone"),
  },
  updated: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
  body: {
    jsonKey: "description",
    def: custom("body", (i: Json) => truncateBody(i.description, 500)),
  },
};

function requireCtx(ctx: RepoContext | undefined): RepoContext {
  if (!ctx) {
    throw new AxiError(
      "Could not determine the GitLab project - pass -R <group/project> or run inside a git checkout",
      "VALIDATION_ERROR",
    );
  }
  return ctx;
}

/** Resolve a username to a numeric user id for assignee_ids. */
async function resolveUserId(
  username: string,
  ctx: RepoContext,
): Promise<number> {
  const users = await glApi<Json[]>(
    `users?username=${encodeURIComponent(username)}`,
    { ctx },
  );
  if (
    !Array.isArray(users) ||
    users.length === 0 ||
    typeof users[0].id !== "number"
  ) {
    throw new AxiError(
      `no GitLab user found with username "${username}"`,
      "VALIDATION_ERROR",
    );
  }
  return users[0].id;
}

async function listIssues(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, ISSUE_LIST_EXTRA_FIELDS);

  const state = getFlag(args, "--state") ?? "opened";
  const label = getFlag(args, "--label");
  const assignee = getFlag(args, "--assignee");
  const author = getFlag(args, "--author");
  const milestone = getFlag(args, "--milestone");
  const limit = parseInt(getFlag(args, "--limit") ?? "30", 10);

  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (label) params.set("labels", label);
  if (assignee) params.set("assignee_username", assignee);
  if (author) params.set("author_username", author);
  if (milestone) params.set("milestone", milestone);
  params.set("per_page", String(limit));
  params.set("order_by", "updated_at");

  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/issues?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const schema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("issues", items, schema),
  ];
  const help = isEmpty
    ? [
        `Run \`glab-axi${repoFlag(repo)} issue create --title "..."\` to open an issue`,
        `Run \`glab-axi${repoFlag(repo)} issue list --state all\` to include closed issues`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} issue view <iid>\` for details`,
        `Run \`glab-axi${repoFlag(repo)} issue comment <iid> --body "..."\` to reply`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function viewIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "issue");
  const full = hasFlag(args, "--full");
  const withComments = hasFlag(args, "--comments");

  const issue = await glApi<Json>(`projects/${projectId(repo)}/issues/${iid}`, {
    ctx: repo,
  });
  const blocks = [
    renderDetail("issue", issue, full ? viewSchemaFull : viewSchema),
  ];
  if (withComments) {
    const notes = await glApi<Json[]>(
      `projects/${projectId(repo)}/issues/${iid}/notes?per_page=20&sort=asc`,
      { ctx: repo },
    );
    const real = notes.filter((n) => !n.system);
    blocks.push(renderList("comments", real, noteSchema));
  }
  return renderOutput(blocks);
}

async function createIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const title = getFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const body = takeBody(args);
  const label = getFlag(args, "--label");
  const milestone = getFlag(args, "--milestone");
  const assignee = getFlag(args, "--assignee");

  const fields: Record<string, string | number> = { title };
  if (body !== undefined) fields["description"] = body;
  if (label) fields["labels"] = label;
  if (milestone) fields["milestone_id"] = milestone;
  if (assignee) fields["assignee_ids"] = await resolveUserId(assignee, repo);

  const issue = await glApi<Json>(`projects/${projectId(repo)}/issues`, {
    method: "POST",
    fields,
    ctx: repo,
  });
  return renderOutput([
    renderDetail("created", issue, createdSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} issue view ${issue.iid}\` to see the full issue`,
      `Run \`glab-axi${repoFlag(repo)} issue comment ${issue.iid} --body "..."\` to add a comment`,
    ]),
  ]);
}

async function editIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "issue");
  const title = getFlag(args, "--title");
  const body = takeBody(args);
  const addLabel = getFlag(args, "--add-label");
  const removeLabel = getFlag(args, "--remove-label");
  const milestone = getFlag(args, "--milestone");
  const assignee = getFlag(args, "--assignee");

  const fields: Record<string, string | number> = {};
  if (title) fields["title"] = title;
  if (body !== undefined) fields["description"] = body;
  if (addLabel) fields["add_labels"] = addLabel;
  if (removeLabel) fields["remove_labels"] = removeLabel;
  if (milestone) fields["milestone_id"] = milestone;
  if (assignee) fields["assignee_ids"] = await resolveUserId(assignee, repo);

  const issue = await glApi<Json>(`projects/${projectId(repo)}/issues/${iid}`, {
    method: "PUT",
    fields,
    ctx: repo,
  });
  return renderOutput([
    renderDetail("updated", { ...issue, status: "ok" }, [
      field("iid"),
      field("title"),
      lower("state"),
    ]),
  ]);
}

async function closeIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "issue");

  // Idempotent: already closed -> no-op.
  const current = await glApi<Json>(
    `projects/${projectId(repo)}/issues/${iid}`,
    { ctx: repo },
  );
  if (current.state === "closed") {
    return renderOutput([
      renderDetail("issue", { ...current, message: "Already closed" }, [
        field("iid"),
        lower("state"),
        field("message"),
      ]),
    ]);
  }
  const issue = await glApi<Json>(`projects/${projectId(repo)}/issues/${iid}`, {
    method: "PUT",
    fields: { state_event: "close" },
    ctx: repo,
  });
  return renderOutput([
    renderDetail("issue", issue, [
      field("iid"),
      lower("state"),
      field("web_url", "url"),
    ]),
  ]);
}

async function reopenIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "issue");

  // Idempotent: already open -> no-op.
  const current = await glApi<Json>(
    `projects/${projectId(repo)}/issues/${iid}`,
    { ctx: repo },
  );
  if (current.state === "opened") {
    return renderOutput([
      renderDetail("issue", { ...current, message: "Already open" }, [
        field("iid"),
        lower("state"),
        field("message"),
      ]),
    ]);
  }
  const issue = await glApi<Json>(`projects/${projectId(repo)}/issues/${iid}`, {
    method: "PUT",
    fields: { state_event: "reopen" },
    ctx: repo,
  });
  return renderOutput([
    renderDetail("issue", issue, [
      field("iid"),
      lower("state"),
      field("web_url", "url"),
    ]),
  ]);
}

async function commentIssue(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "issue");
  const body = takeBody(args, { required: true });
  const note = await glApi<Json>(
    `projects/${projectId(repo)}/issues/${iid}/notes`,
    { method: "POST", fields: { body: body as string }, ctx: repo },
  );
  return renderOutput([
    renderDetail("comment", note, noteSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} issue view ${iid} --comments\` to see all comments`,
    ]),
  ]);
}

export async function issueCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([ISSUE_HELP]);
  switch (sub) {
    case "list":
      return listIssues(args, ctx);
    case "view":
      return viewIssue(args, ctx);
    case "create":
      return createIssue(args, ctx);
    case "edit":
      return editIssue(args, ctx);
    case "close":
      return closeIssue(args, ctx);
    case "reopen":
      return reopenIssue(args, ctx);
    case "comment":
      return commentIssue(args, ctx);
    default:
      return renderError(
        `unknown issue subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi issue --help` for usage"],
      );
  }
}
