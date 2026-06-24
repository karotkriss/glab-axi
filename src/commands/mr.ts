import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import {
  hasFlag,
  getFlag,
  takeFlag,
  takeBoolFlag,
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
  boolYesNo,
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

export const MR_HELP = `usage: glab-axi mr <subcommand> [flags]
subcommands:
  list, view <iid>, create, update <iid>, merge <iid>, approve <iid>, comment <iid>
flags{list}:
  --state <opened|closed|merged|all>, --source-branch <name>, --target-branch <name>, --author <user>, --label <name>, --limit <n> (default 30), --fields <a,b,c>
flags{view}:
  --comments, --full (includes state, detailed_merge_status, and head pipeline)
flags{create}:
  --source-branch <name> (required), --target-branch <name> (default: project default), --title <text> (required), --body/--body-file, --label, --assignee, --draft, --remove-source-branch
flags{update}:
  --title, --body/--body-file, --add-label, --remove-label, --target-branch, --ready (clear draft)
flags{merge}:
  --method <merge|rebase|squash>, --when-pipeline-succeeds, --remove-source-branch, --message <text>
flags{comment}:
  --body <text> or --body-file <path> (required)
examples:
  glab-axi mr list --source-branch feature-x
  glab-axi mr view 17 --full
  glab-axi mr create --source-branch feat --title "Add feature" --body-file mr.md
  glab-axi mr merge 17 --method squash --remove-source-branch
notes:
  MRs are addressed by IID. 'mr list --source-branch' is the find-by-branch
  primitive; 'mr view --full' surfaces detailed_merge_status and the head
  pipeline (the no-mistakes scm.Host contract).`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const listSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  field("source_branch", "source"),
  boolYesNo("draft", "draft"),
];

const headPipelineStatus = custom(
  "pipeline",
  (m: Json) => m.head_pipeline?.status ?? "none",
);

const viewSchema: Def[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  field("source_branch", "source"),
  field("target_branch", "target"),
  boolYesNo("draft", "draft"),
  field("detailed_merge_status", "merge_status"),
  headPipelineStatus,
  field("web_url", "url"),
  custom("body", (m: Json) => truncateBody(m.description, 500)),
];

const viewSchemaFull: Def[] = viewSchema.map((d) =>
  d.type === "custom" && d.as === "body"
    ? custom("body", (m: Json) =>
        typeof m.description === "string" ? m.description : "",
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

const MR_LIST_EXTRA_FIELDS: Record<string, ExtraField> = {
  labels: { jsonKey: "labels", def: joinArray("labels", "name", "labels") },
  target: { jsonKey: "target_branch", def: field("target_branch", "target") },
  updated: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  created: {
    jsonKey: "created_at",
    def: relativeTime("created_at", "created"),
  },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
  mergeable: {
    jsonKey: "detailed_merge_status",
    def: field("detailed_merge_status", "mergeable"),
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

async function listMrs(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, MR_LIST_EXTRA_FIELDS);

  const state = getFlag(args, "--state") ?? "opened";
  const sourceBranch = getFlag(args, "--source-branch");
  const targetBranch = getFlag(args, "--target-branch");
  const author = getFlag(args, "--author");
  const label = getFlag(args, "--label");
  const limit = parseInt(getFlag(args, "--limit") ?? "30", 10);

  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (sourceBranch) params.set("source_branch", sourceBranch);
  if (targetBranch) params.set("target_branch", targetBranch);
  if (author) params.set("author_username", author);
  if (label) params.set("labels", label);
  params.set("per_page", String(limit));
  params.set("order_by", "updated_at");

  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/merge_requests?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const schema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("merge_requests", items, schema),
  ];
  const help = isEmpty
    ? [
        `Run \`glab-axi${repoFlag(repo)} mr create --source-branch <b> --title "..."\` to open an MR`,
        `Run \`glab-axi${repoFlag(repo)} mr list --state all\` to include closed/merged`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} mr view <iid>\` for details`,
        `Run \`glab-axi${repoFlag(repo)} mr merge <iid>\` to merge`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function viewMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "MR");
  const full = hasFlag(args, "--full");
  const withComments = hasFlag(args, "--comments");

  const mr = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}`,
    { ctx: repo },
  );
  const blocks = [
    renderDetail("merge_request", mr, full ? viewSchemaFull : viewSchema),
  ];
  if (withComments) {
    const notes = await glApi<Json[]>(
      `projects/${projectId(repo)}/merge_requests/${iid}/notes?per_page=20&sort=asc`,
      { ctx: repo },
    );
    const real = notes.filter((n) => !n.system);
    blocks.push(renderList("comments", real, noteSchema));
  }
  return renderOutput(blocks);
}

async function createMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const sourceBranch = getFlag(args, "--source-branch");
  if (!sourceBranch) {
    throw new AxiError("--source-branch is required", "VALIDATION_ERROR");
  }
  const title = getFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const body = takeBody(args);
  const targetBranch = getFlag(args, "--target-branch");
  const label = getFlag(args, "--label");
  const draft = takeBoolFlag(args, "--draft");
  const removeSource = takeBoolFlag(args, "--remove-source-branch");

  const fields: Record<string, string | boolean> = {
    source_branch: sourceBranch,
    title: draft ? `Draft: ${title}` : title,
  };
  if (targetBranch) fields["target_branch"] = targetBranch;
  if (body !== undefined) fields["description"] = body;
  if (label) fields["labels"] = label;
  if (removeSource) fields["remove_source_branch"] = true;

  const mr = await glApi<Json>(`projects/${projectId(repo)}/merge_requests`, {
    method: "POST",
    fields,
    ctx: repo,
  });
  return renderOutput([
    renderDetail("created", mr, createdSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} mr view ${mr.iid}\` to see the full MR`,
      `Run \`glab-axi${repoFlag(repo)} ci status --mr ${mr.iid}\` to check its pipeline`,
    ]),
  ]);
}

async function updateMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "MR");
  const title = getFlag(args, "--title");
  const body = takeBody(args);
  const addLabel = getFlag(args, "--add-label");
  const removeLabel = getFlag(args, "--remove-label");
  const targetBranch = getFlag(args, "--target-branch");
  const ready = takeBoolFlag(args, "--ready");

  const fields: Record<string, string> = {};
  if (title) fields["title"] = title;
  if (body !== undefined) fields["description"] = body;
  if (addLabel) fields["add_labels"] = addLabel;
  if (removeLabel) fields["remove_labels"] = removeLabel;
  if (targetBranch) fields["target_branch"] = targetBranch;

  const mr = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}`,
    { method: "PUT", fields, ctx: repo },
  );
  // Clearing draft requires the title to drop the Draft: prefix.
  if (ready && typeof mr.title === "string" && /^draft:\s*/i.test(mr.title)) {
    await glApi<Json>(`projects/${projectId(repo)}/merge_requests/${iid}`, {
      method: "PUT",
      fields: { title: mr.title.replace(/^draft:\s*/i, "") },
      ctx: repo,
    });
  }
  return renderOutput([
    renderDetail("updated", { ...mr, status: "ok" }, [
      field("iid"),
      field("title"),
      lower("state"),
    ]),
  ]);
}

async function mergeMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "MR");
  const method = getFlag(args, "--method") ?? "merge";
  const whenPipeline = takeBoolFlag(args, "--when-pipeline-succeeds");
  const removeSource = takeBoolFlag(args, "--remove-source-branch");
  const message = getFlag(args, "--message");

  // Idempotent: already merged -> no-op.
  const current = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}`,
    { ctx: repo },
  );
  if (current.state === "merged") {
    return renderOutput([
      renderDetail("merge_request", { ...current, message: "Already merged" }, [
        field("iid"),
        lower("state"),
        field("message"),
      ]),
    ]);
  }
  if (current.state === "closed") {
    throw new AxiError(
      `MR !${iid} is closed and cannot be merged`,
      "VALIDATION_ERROR",
    );
  }

  if (method === "rebase") {
    await glApi(`projects/${projectId(repo)}/merge_requests/${iid}/rebase`, {
      method: "PUT",
      ctx: repo,
    });
  }
  const fields: Record<string, string | boolean> = {};
  if (method === "squash") fields["squash"] = true;
  if (whenPipeline) fields["merge_when_pipeline_succeeds"] = true;
  if (removeSource) fields["should_remove_source_branch"] = true;
  if (message) fields["merge_commit_message"] = message;

  const merged = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}/merge`,
    { method: "PUT", fields, ctx: repo },
  );
  return renderOutput([
    renderDetail("merge_request", merged, [
      field("iid"),
      lower("state"),
      field("web_url", "url"),
    ]),
  ]);
}

async function approveMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "MR");
  const result = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}/approve`,
    { method: "POST", ctx: repo },
  );
  return renderOutput([
    renderDetail(
      "approved",
      {
        iid,
        approved_by: (result.approved_by ?? []).length,
        approvals_left: result.approvals_left ?? 0,
      },
      [field("iid"), field("approved_by"), field("approvals_left")],
    ),
  ]);
}

async function commentMr(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const iid = requireNumber(getPositional(args, 1), "MR");
  const body = takeBody(args, { required: true });
  const note = await glApi<Json>(
    `projects/${projectId(repo)}/merge_requests/${iid}/notes`,
    { method: "POST", fields: { body: body as string }, ctx: repo },
  );
  return renderOutput([
    renderDetail("comment", note, noteSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} mr view ${iid} --comments\` to see all comments`,
    ]),
  ]);
}

export async function mrCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([MR_HELP]);
  switch (sub) {
    case "list":
      return listMrs(args, ctx);
    case "view":
      return viewMr(args, ctx);
    case "create":
      return createMr(args, ctx);
    case "update":
      return updateMr(args, ctx);
    case "merge":
      return mergeMr(args, ctx);
    case "approve":
      return approveMr(args, ctx);
    case "comment":
      return commentMr(args, ctx);
    default:
      return renderError(`unknown mr subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `glab-axi mr --help` for usage",
      ]);
  }
}
