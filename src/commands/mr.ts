import { glApi, projectId, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { resolveMrPipeline, fetchJobs, renderSummary } from "./ci.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { getSuggestions, repoFlag } from "../suggestions.js";
import { takeFlag, takeBoolFlag, takeNumber, parseLimit } from "../args.js";
import { parseFields, type FieldSpec } from "../fields.js";
import { resolveUserId, resolveMilestoneId } from "../resolve.js";
import {
  field,
  pluck,
  lower,
  boolYesNo,
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

/** Map a user-facing state to the GitLab MR state value. */
function mapState(input: string | undefined): string {
  switch ((input ?? "opened").toLowerCase()) {
    case "open":
    case "opened":
      return "opened";
    case "closed":
      return "closed";
    case "merged":
      return "merged";
    case "locked":
      return "locked";
    case "all":
      return "all";
    default:
      return input!.toLowerCase();
  }
}

const DRAFT_PREFIX =
  /^\s*(\[draft\]|\(draft\)|draft:|\[wip\]|\(wip\)|wip:)\s*/i;

/** Strip a leading Draft/WIP prefix from an MR title. */
function stripDraft(title: string): string {
  return title.replace(DRAFT_PREFIX, "").trim();
}

function mrPath(
  ctx: RepoContext | undefined,
  iid: number,
  suffix = "",
): string {
  return `projects/${requireProject(ctx)}/merge_requests/${iid}${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MR_URL_RE = /\/-\/merge_requests\/(\d+)/;

/** Extract {host, project} from a full MR URL, or undefined if it isn't one. */
function parseMrUrl(raw: string): RepoContext | undefined {
  const m = raw.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/\d+/);
  if (!m) return undefined;
  return { host: m[1], project: m[2], source: "flag" };
}

/**
 * Resolve the MR reference from args: a bare IID, or a full MR URL
 * (https://<host>/<group>/<project>/-/merge_requests/<iid>). A URL also carries
 * its own host/project, which targets the request unless an explicit `-R` flag
 * was given (precedence: `-R` flag > URL > git remote).
 */
function resolveMrRef(
  args: string[],
  ctx?: RepoContext,
): { iid: number; ctx?: RepoContext } {
  const urlIdx = args.findIndex((a) => MR_URL_RE.test(a));
  if (urlIdx !== -1) {
    const raw = args.splice(urlIdx, 1)[0];
    const iid = Number(raw.match(MR_URL_RE)![1]);
    const fromUrl = parseMrUrl(raw);
    const target = ctx?.source === "flag" ? ctx : (fromUrl ?? ctx);
    return { iid, ctx: target };
  }
  return { iid: takeNumber(args, "merge request"), ctx };
}

// ---------------------------------------------------------------------------
// Diff helpers (mr diff)
// ---------------------------------------------------------------------------

/** Classify a changed file from its GitLab MR change flags. */
function changeStatus(c: Json): string {
  if (c.new_file) return "added";
  if (c.deleted_file) return "deleted";
  if (c.renamed_file) return "renamed";
  return "modified";
}

/** Display path: `old -> new` for a rename, otherwise the file's path. */
function changePath(c: Json): string {
  if (c.renamed_file && c.old_path && c.old_path !== c.new_path) {
    return `${c.old_path} -> ${c.new_path}`;
  }
  return c.new_path ?? c.old_path ?? "";
}

/** Count +/- lines in a hunk body (the `+++`/`---` guards are defensive). */
function countDiffLines(diff: unknown): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  if (typeof diff === "string") {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Reconstruct a complete per-file unified diff. GitLab's `changes[].diff` is
 * only the hunk body (starts at `@@`), so we prepend the git/`---`/`+++` header
 * lines it omits, mapping new/deleted files to /dev/null.
 */
function fileDiff(c: Json): string {
  const oldp = c.old_path ?? c.new_path ?? "";
  const newp = c.new_path ?? c.old_path ?? "";
  const lines = [`diff --git a/${oldp} b/${newp}`];
  if (c.new_file) lines.push(`new file mode ${c.b_mode ?? "100644"}`);
  if (c.deleted_file) lines.push(`deleted file mode ${c.a_mode ?? "100644"}`);
  if (c.renamed_file) lines.push(`rename from ${oldp}`, `rename to ${newp}`);
  const body = typeof c.diff === "string" ? c.diff : "";
  if (c.renamed_file && body === "") return lines.join("\n");
  lines.push(c.new_file ? "--- /dev/null" : `--- a/${oldp}`);
  lines.push(c.deleted_file ? "+++ /dev/null" : `+++ b/${newp}`);
  return `${lines.join("\n")}\n${body}`;
}

// ---------------------------------------------------------------------------
// Review helpers (mr view --reviews)
// ---------------------------------------------------------------------------

/** Count resolved vs unresolved resolvable discussion threads. */
function threadResolution(discussions: Json[]): {
  resolved: number;
  unresolved: number;
} {
  let resolved = 0;
  let unresolved = 0;
  for (const d of discussions) {
    const notes: Json[] = Array.isArray(d?.notes) ? d.notes : [];
    const resolvable = notes.filter((n) => n?.resolvable === true);
    if (resolvable.length === 0) continue; // plain comment, not a thread
    if (resolvable.every((n) => n.resolved === true)) resolved++;
    else unresolved++;
  }
  return { resolved, unresolved };
}

/** Fold approval + thread state into a compact review summary object. */
function buildReviewSummary(
  approvals: Json,
  discussions: Json[],
): Record<string, string> {
  const approvers: string[] = (approvals?.approved_by ?? [])
    .map((a: Json) => a?.user?.username)
    .filter(Boolean);
  const required = approvals?.approvals_required ?? 0;
  const given = approvers.length;
  // GitLab CE omits the `approved` bool, so derive it when it's absent.
  const approved =
    typeof approvals?.approved === "boolean"
      ? approvals.approved
      : given >= required;
  const { resolved, unresolved } = threadResolution(discussions);
  const total = resolved + unresolved;
  return {
    approved: approved ? "yes" : "no",
    approvals: `${given}/${required}`,
    approved_by: approvers.length ? approvers.join(",") : "none",
    threads: `${total} total, ${resolved} resolved, ${unresolved} unresolved`,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  boolYesNo("draft", "draft"),
];

const LIST_EXTRA_FIELDS: Record<string, FieldSpec> = {
  source_branch: { jsonKey: "source_branch", def: field("source_branch") },
  target_branch: { jsonKey: "target_branch", def: field("target_branch") },
  labels: { jsonKey: "labels", def: joinArray("labels", "name", "labels") },
  milestone: {
    jsonKey: "milestone",
    def: pluck("milestone", "title", "milestone"),
  },
  created: {
    jsonKey: "created_at",
    def: relativeTime("created_at", "created"),
  },
  updated: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  merge_status: {
    jsonKey: "detailed_merge_status",
    def: field("detailed_merge_status", "merge_status"),
  },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
  assignees: {
    jsonKey: "assignees",
    def: joinArray("assignees", "username", "assignees"),
  },
};

function viewSchema(full: boolean, includeComments: boolean): FieldDef[] {
  const base: FieldDef[] = [
    field("iid"),
    field("title"),
    lower("state"),
    pluck("author", "username", "author"),
    boolYesNo("draft", "draft"),
    field("source_branch"),
    field("target_branch"),
    field("detailed_merge_status", "merge_status"),
  ];
  if (full) {
    base.push(
      // Source/head SHA - the commit firstmate's merge-poll and teardown
      // containment check verify against (gh-axi `pr view --json headRefOid`).
      custom("head_sha", (m) => m.sha ?? m.diff_refs?.head_sha ?? ""),
      custom("has_conflicts", (m) => (m.has_conflicts ? "yes" : "no")),
      custom("pipeline", (m) => m.head_pipeline?.status ?? "none"),
    );
    // Count hint only when --comments isn't expanding the full notes.
    if (!includeComments) {
      base.push(custom("comments", (m) => m.user_notes_count ?? 0));
    }
    base.push(
      custom("web_url", (m) => m.web_url ?? ""),
      custom("body", (m) =>
        typeof m.description === "string" ? m.description : "",
      ),
    );
  } else {
    if (!includeComments) {
      base.push(
        custom(
          "comments",
          (m) => `${m.user_notes_count ?? 0} — use --comments to read them`,
        ),
      );
    }
    base.push(custom("body", (m) => truncateBody(m.description, 500)));
  }
  return base;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const MR_HELP = `usage: glab-axi mr <subcommand> [flags]
subcommands[9]:
  list, view <iid|url>, create, update <iid>, merge <iid>, approve <iid>, checks <iid|url>, diff <iid|url>, comment <iid>
flags{list}:
  --state <opened|closed|merged|all>, --source-branch/--head <b>, --target-branch/--base <b>, --label, --author <user>, --assignee <user>, --milestone <name>, --draft, --limit <n> (default 30), --fields <a,b,c>
flags{view}:
  --comments (include discussion notes), --reviews (approvals + thread resolution), --full (head SHA, merge status, pipeline, full body); accepts an MR URL in place of the iid
flags{diff}:
  --full (complete unified diff instead of the per-file summary); accepts an MR URL in place of the iid
flags{create}:
  --title <text> (required), --source-branch <b> (required), --target-branch <b> (default: project default), --body <text> or --body-file <path>, --assignee <user>, --reviewer <user>, --label <a,b>, --milestone <name>, --draft, --remove-source-branch, --squash
flags{update}:
  --title, --body or --body-file, --label, --milestone <name>, --assignee <user>, --target-branch, --ready (clear Draft), --draft (mark Draft), --close, --reopen
flags{merge}:
  --method <merge|squash|rebase>, --merge, --squash, --rebase, --remove-source-branch, --body or --body-file (merge commit message)
flags{approve}:
  (none)
flags{checks}:
  (none) - prints the MR pipeline's aggregate pass/fail/running counts + verdict
flags{comment}:
  --body <text> or --body-file <path> (required)
examples:
  glab-axi mr list --state all --head feature-1 --limit 1
  glab-axi mr view 42 --full
  glab-axi mr view 42 --reviews
  glab-axi mr view https://gitlab.example.com/group/project/-/merge_requests/42 --full
  glab-axi mr diff 42
  glab-axi mr diff 42 --full
  glab-axi mr checks 42
  glab-axi mr create --title "Add X" --source-branch feat --target-branch main
  glab-axi mr merge 42 --squash --remove-source-branch
  glab-axi mr update 42 --ready`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function mrList(args: string[], ctx?: RepoContext): Promise<string> {
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, LIST_EXTRA_FIELDS);
  const state = mapState(takeFlag(args, "--state"));
  // --head/--base are gh-axi-compatible aliases for --source-branch/--target-branch.
  const sourceBranch =
    takeFlag(args, "--source-branch") ?? takeFlag(args, "--head");
  const targetBranch =
    takeFlag(args, "--target-branch") ?? takeFlag(args, "--base");
  const label = takeFlag(args, "--label");
  const author = takeFlag(args, "--author");
  const assignee = takeFlag(args, "--assignee");
  const milestone = takeFlag(args, "--milestone");
  const draft = takeBoolFlag(args, "--draft");
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (sourceBranch) params.set("source_branch", sourceBranch);
  if (targetBranch) params.set("target_branch", targetBranch);
  if (label) params.set("labels", label);
  if (author) params.set("author_username", author);
  if (assignee) params.set("assignee_username", assignee);
  if (milestone) params.set("milestone", milestone);
  if (draft) params.set("wip", "yes");
  params.set("per_page", String(limit));
  params.set("order_by", "updated_at");

  const items =
    (await glApi<Json[]>(
      `projects/${requireProject(ctx)}/merge_requests?${params.toString()}`,
      { ctx },
    )) ?? [];
  const isEmpty = items.length === 0;
  const countLine = formatCountLine({ count: items.length, limit });
  const schema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;

  if (isEmpty) {
    return renderOutput([
      "merge_requests: 0 matching merge requests found",
      renderHelp(
        getSuggestions({ domain: "mr", action: "list", isEmpty, repo: ctx }),
      ),
    ]);
  }
  return renderOutput([
    countLine,
    renderList("merge_requests", items, schema),
    renderHelp(
      getSuggestions({ domain: "mr", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function mrView(args: string[], ctx?: RepoContext): Promise<string> {
  const includeComments = takeBoolFlag(args, "--comments");
  const includeReviews = takeBoolFlag(args, "--reviews");
  const full = takeBoolFlag(args, "--full");
  const { iid, ctx: target } = resolveMrRef(args, ctx);
  const mr = await glApi<Json>(mrPath(target, iid), { ctx: target });

  const schema = viewSchema(full, includeComments);
  if (includeComments) {
    const notes = await glApi<Json[]>(
      `${mrPath(target, iid, "/notes")}?per_page=100&sort=asc`,
      { ctx: target },
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
  if (includeReviews) {
    const approvals = await glApi<Json>(mrPath(target, iid, "/approvals"), {
      ctx: target,
    });
    const discussions = await glApi<Json[]>(
      `${mrPath(target, iid, "/discussions")}?per_page=100`,
      { ctx: target },
    );
    const summary = buildReviewSummary(approvals, discussions ?? []);
    schema.push(custom("reviews", () => summary));
  }
  return renderOutput([
    renderDetail("merge_request", mr, schema),
    renderHelp(
      getSuggestions({
        domain: "mr",
        action: "view",
        id: iid,
        state: mr.state,
        repo: target,
      }),
    ),
  ]);
}

async function defaultBranch(ctx?: RepoContext): Promise<string> {
  const proj = await glApi<Json>(`projects/${projectId(ctx)}`, { ctx });
  return proj.default_branch ?? "main";
}

async function mrCreate(args: string[], ctx?: RepoContext): Promise<string> {
  requireProject(ctx);
  let title = takeFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const sourceBranch = takeFlag(args, "--source-branch");
  if (!sourceBranch)
    throw new AxiError("--source-branch is required", "VALIDATION_ERROR", [
      'glab-axi mr create --title "..." --source-branch <branch> [--target-branch <branch>]',
    ]);
  const targetBranch =
    takeFlag(args, "--target-branch") ?? (await defaultBranch(ctx));
  const body = takeBody(args);
  const assignee = takeFlag(args, "--assignee");
  const reviewer = takeFlag(args, "--reviewer");
  const label = takeFlag(args, "--label");
  const milestone = takeFlag(args, "--milestone");
  const draft = takeBoolFlag(args, "--draft");
  const removeSource = takeBoolFlag(args, "--remove-source-branch");
  const squash = takeBoolFlag(args, "--squash");

  if (draft && !DRAFT_PREFIX.test(title)) title = `Draft: ${title}`;

  const rawFields = [
    `source_branch=${sourceBranch}`,
    `target_branch=${targetBranch}`,
    `title=${title}`,
  ];
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (label) rawFields.push(`labels=${label}`);
  const fields: string[] = [];
  if (assignee)
    fields.push(`assignee_id=${await resolveUserId(assignee, ctx)}`);
  if (reviewer)
    fields.push(`reviewer_ids=${await resolveUserId(reviewer, ctx)}`);
  if (milestone)
    fields.push(`milestone_id=${await resolveMilestoneId(milestone, ctx)}`);
  if (removeSource) fields.push("remove_source_branch=true");
  if (squash) fields.push("squash=true");

  const mr = await glApi<Json>(
    `projects/${requireProject(ctx)}/merge_requests`,
    {
      method: "POST",
      rawFields,
      fields,
      ctx,
    },
  );
  return renderOutput([
    renderDetail("created", { iid: mr.iid, title: mr.title, url: mr.web_url }, [
      field("iid"),
      field("title"),
      field("url"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "create", id: mr.iid, repo: ctx }),
    ),
  ]);
}

async function mrUpdate(args: string[], ctx?: RepoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const label = takeFlag(args, "--label");
  const milestone = takeFlag(args, "--milestone");
  const assignee = takeFlag(args, "--assignee");
  const targetBranch = takeFlag(args, "--target-branch");
  const ready = takeBoolFlag(args, "--ready");
  const draft = takeBoolFlag(args, "--draft");
  const close = takeBoolFlag(args, "--close");
  const reopen = takeBoolFlag(args, "--reopen");
  const iid = takeNumber(args, "merge request");

  // Reject contradictory transitions before touching the API.
  if (close && reopen) {
    throw new AxiError(
      "Choose only one of --close or --reopen",
      "VALIDATION_ERROR",
    );
  }
  if (ready && draft) {
    throw new AxiError(
      "Choose only one of --ready or --draft",
      "VALIDATION_ERROR",
    );
  }

  const anyFlag =
    title !== undefined ||
    body !== undefined ||
    label !== undefined ||
    milestone !== undefined ||
    assignee !== undefined ||
    targetBranch !== undefined ||
    ready ||
    draft ||
    close ||
    reopen;
  if (!anyFlag) {
    throw new AxiError("No update flags provided", "VALIDATION_ERROR", [
      "Pass at least one of --title, --body, --label, --assignee, --milestone, --target-branch, --ready, --draft, --close, --reopen",
    ]);
  }

  // Fetch current state once — used both for idempotency (skipping transitions
  // already satisfied) and for the draft/ready re-title logic.
  const current = await glApi<Json>(mrPath(ctx, iid), { ctx });
  const curState = current.state;
  const curDraft = current.draft === true;

  const rawFields: string[] = [];
  const fields: string[] = [];
  if (title !== undefined)
    rawFields.push(
      `title=${draft && !DRAFT_PREFIX.test(title) ? `Draft: ${title}` : title}`,
    );
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (label !== undefined) rawFields.push(`labels=${label}`);
  if (targetBranch !== undefined)
    rawFields.push(`target_branch=${targetBranch}`);
  if (milestone !== undefined)
    fields.push(`milestone_id=${await resolveMilestoneId(milestone, ctx)}`);
  if (assignee !== undefined)
    fields.push(`assignee_id=${await resolveUserId(assignee, ctx)}`);
  // Idempotent: only request a state transition the MR isn't already in.
  if (close && curState !== "closed") fields.push("state_event=close");
  if (reopen && curState !== "opened") fields.push("state_event=reopen");
  // --draft (without an explicit title): re-title current to Draft, if needed.
  if (draft && title === undefined && !curDraft) {
    const t = current.title ?? "";
    if (!DRAFT_PREFIX.test(t)) rawFields.push(`title=Draft: ${t}`);
  }

  let result: Json | undefined;
  if (rawFields.length > 0 || fields.length > 0) {
    result = await glApi<Json>(mrPath(ctx, iid), {
      method: "PUT",
      rawFields,
      fields,
      ctx,
    });
  }

  // --ready: clear the Draft prefix in a final PUT and render that response
  // (not the stale pre-update state). Skip entirely if already non-draft.
  if (ready) {
    const latestTitle = result?.title ?? current.title ?? "";
    const cleaned = stripDraft(latestTitle);
    const draftNow = (result?.draft ?? curDraft) === true;
    if (draftNow || cleaned !== latestTitle) {
      result = await glApi<Json>(mrPath(ctx, iid), {
        method: "PUT",
        rawFields: [`title=${cleaned}`],
        ctx,
      });
    }
  }

  // Nothing actually needed changing → idempotent no-op (exit 0).
  if (!result) {
    return renderOutput([
      renderDetail(
        "merge_request",
        {
          iid,
          state: curState,
          draft: curDraft ? "yes" : "no",
          already: true,
        },
        [field("iid"), lower("state"), field("draft"), field("already")],
      ),
      renderHelp(
        getSuggestions({ domain: "mr", action: "update", id: iid, repo: ctx }),
      ),
    ]);
  }
  return renderOutput([
    renderDetail(
      "updated",
      {
        iid: result.iid,
        title: result.title,
        state: result.state,
        draft: result.draft ? "yes" : "no",
      },
      [field("iid"), field("title"), lower("state"), field("draft")],
    ),
    renderHelp(
      getSuggestions({ domain: "mr", action: "update", id: iid, repo: ctx }),
    ),
  ]);
}

const REBASE_POLL_INTERVAL_MS = 1500;
const REBASE_POLL_MAX_ATTEMPTS = 30; // ~45s

// detailed_merge_status values that are still settling — the merge endpoint
// rejects a merge while in any of these, so we wait them out after a rebase.
const TRANSIENT_MERGE_STATUS = new Set(["checking", "preparing", "unchecked"]);

/**
 * A rebase is asynchronous: GitLab kicks it off and updates the MR's SHA and
 * merge status in the background. We poll until the rebase finishes AND the
 * merge status settles out of its transient states, otherwise the immediate
 * follow-up merge 422s.
 */
async function waitForRebase(iid: number, ctx?: RepoContext): Promise<void> {
  for (let attempt = 0; attempt < REBASE_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(REBASE_POLL_INTERVAL_MS);
    const mr = await glApi<Json>(
      `${mrPath(ctx, iid)}?include_rebase_in_progress=true`,
      {
        ctx,
      },
    );
    if (mr.merge_error) {
      throw new AxiError(`Rebase failed: ${mr.merge_error}`, "CONFLICT");
    }
    const rebaseDone =
      mr.rebase_in_progress === false || mr.rebase_in_progress == null;
    const statusSettled = !TRANSIENT_MERGE_STATUS.has(
      mr.detailed_merge_status ?? "",
    );
    if (rebaseDone && statusSettled) {
      return;
    }
  }
  throw new AxiError(
    `Rebase did not finish within ${(REBASE_POLL_INTERVAL_MS * REBASE_POLL_MAX_ATTEMPTS) / 1000}s`,
    "TIMEOUT",
    [
      `Run \`glab-axi mr view ${iid} --full\` to check rebase progress, then retry merge`,
    ],
  );
}

async function mrMerge(args: string[], ctx?: RepoContext): Promise<string> {
  const explicitMethod = takeFlag(args, "--method");
  const shorthand = (["merge", "squash", "rebase"] as const).filter((m) =>
    takeBoolFlag(args, `--${m}`),
  );
  const removeSource =
    takeBoolFlag(args, "--remove-source-branch") ||
    takeBoolFlag(args, "--delete-branch");
  const body = takeBody(args);
  const iid = takeNumber(args, "merge request");
  if (shorthand.length > 1) {
    throw new AxiError(
      "Choose only one merge method: --merge, --squash, or --rebase",
      "VALIDATION_ERROR",
    );
  }
  if (
    explicitMethod &&
    shorthand.length === 1 &&
    explicitMethod !== shorthand[0]
  ) {
    throw new AxiError(
      "Choose either --method or a matching merge shorthand, not both",
      "VALIDATION_ERROR",
    );
  }
  const method = explicitMethod ?? shorthand[0];
  if (method && !["merge", "squash", "rebase"].includes(method)) {
    throw new AxiError(
      "--method must be one of: merge, squash, rebase",
      "VALIDATION_ERROR",
    );
  }

  // Idempotent: already merged is a no-op.
  const mr = await glApi<Json>(mrPath(ctx, iid), { ctx });
  if ((mr.state ?? "") === "merged") {
    return renderOutput([
      renderDetail(
        "merge_request",
        {
          iid,
          state: "merged",
          merged_by: mr.merged_by?.username ?? null,
          already: true,
        },
        [field("iid"), field("state"), field("merged_by"), field("already")],
      ),
      renderHelp(
        getSuggestions({ domain: "mr", action: "merge", id: iid, repo: ctx }),
      ),
    ]);
  }
  if ((mr.state ?? "") === "closed") {
    throw new AxiError(
      `Merge request !${iid} is closed and cannot be merged`,
      "VALIDATION_ERROR",
      [
        `Run \`glab-axi${repoFlag({ domain: "mr", action: "merge", repo: ctx })} mr update ${iid} --reopen\` first`,
      ],
    );
  }

  // rebase is asynchronous: kick it off, poll to completion, THEN merge.
  if (method === "rebase") {
    await glApi<Json>(mrPath(ctx, iid, "/rebase"), { method: "PUT", ctx });
    await waitForRebase(iid, ctx);
  }

  const fields: string[] = [];
  const rawFields: string[] = [];
  if (method === "squash") fields.push("squash=true");
  if (removeSource) fields.push("should_remove_source_branch=true");
  if (body !== undefined) rawFields.push(`merge_commit_message=${body}`);

  const merged = await glApi<Json>(mrPath(ctx, iid, "/merge"), {
    method: "PUT",
    fields,
    rawFields,
    ctx,
  });
  return renderOutput([
    renderDetail(
      "merged",
      {
        iid: merged.iid ?? iid,
        state: merged.state ?? "merged",
        method: method ?? "merge",
        merge_commit_sha:
          merged.merge_commit_sha ?? merged.squash_commit_sha ?? null,
      },
      [
        field("iid"),
        field("state"),
        field("method"),
        field("merge_commit_sha"),
      ],
    ),
    renderHelp(
      getSuggestions({ domain: "mr", action: "merge", id: iid, repo: ctx }),
    ),
  ]);
}

/** True when the given username already appears in an approvals payload. */
function isApprovedBy(approvals: Json, username: string | undefined): boolean {
  if (!username) return false;
  const approvers: Json[] = approvals?.approved_by ?? [];
  return approvers.some((entry) => entry?.user?.username === username);
}

async function mrApprove(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "merge request");

  // Idempotent: if the current user has already approved, this is a no-op.
  // Detect that up front via the approvals endpoint, because a repeat POST to
  // /approve surfaces as an auth-style error that mapGlError rewrites, leaving
  // no reliable "already approved" signal to key off afterwards.
  const me = await glApi<Json>("user", { ctx });
  const approvals = await glApi<Json>(mrPath(ctx, iid, "/approvals"), { ctx });
  if (isApprovedBy(approvals, me?.username)) {
    return renderOutput([
      renderDetail("merge_request", { iid, approved: "yes", already: true }, [
        field("iid"),
        field("approved"),
        field("already"),
      ]),
      renderHelp(
        getSuggestions({ domain: "mr", action: "approve", id: iid, repo: ctx }),
      ),
    ]);
  }

  const result = await glApi<Json>(mrPath(ctx, iid, "/approve"), {
    method: "POST",
    ctx,
  });
  return renderOutput([
    renderDetail(
      "approved",
      {
        iid,
        approvals:
          result.approved_by?.length ?? result.approvals_required ?? "ok",
      },
      [field("iid"), field("approvals")],
    ),
    renderHelp(
      getSuggestions({ domain: "mr", action: "approve", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrComment(args: string[], ctx?: RepoContext): Promise<string> {
  const body = takeBody(args, { required: true });
  const iid = takeNumber(args, "merge request");
  await glApi<Json>(mrPath(ctx, iid, "/notes"), {
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
      getSuggestions({ domain: "mr", action: "comment", id: iid, repo: ctx }),
    ),
  ]);
}

/**
 * `mr checks <iid|url>` — the gh-axi `pr checks` read: the pipeline's aggregate
 * pass/fail/running counts + verdict, keyed on the MR. A thin wrapper over the
 * shared `ci status --mr` pipeline resolution and verdict bucketing.
 */
async function mrChecks(args: string[], ctx?: RepoContext): Promise<string> {
  const { iid, ctx: target } = resolveMrRef(args, ctx);
  const pipeline = await resolveMrPipeline(iid, target);
  const help = renderHelp(
    getSuggestions({ domain: "mr", action: "checks", id: iid, repo: target }),
  );
  if (!pipeline) {
    return renderOutput([
      `checks: no pipeline found for merge request ${iid}`,
      help,
    ]);
  }
  const jobs = await fetchJobs(pipeline.id, target);
  return renderOutput([renderSummary(jobs), help]);
}

/**
 * `mr diff <iid|url>` — the gh-axi `pr diff` read. Default is a bounded per-file
 * summary (path, status, +/- line counts) plus totals; `--full` emits the
 * complete reconstructed unified diff. Backed by the MR changes endpoint, whose
 * `overflow` flag marks a server-truncated diff on very large MRs.
 */
async function mrDiff(args: string[], ctx?: RepoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const { iid, ctx: target } = resolveMrRef(args, ctx);
  const data = await glApi<Json>(mrPath(target, iid, "/changes"), {
    ctx: target,
  });
  const changes: Json[] = Array.isArray(data?.changes) ? data.changes : [];
  const overflow = data?.overflow === true;

  const nextSteps = getSuggestions({
    domain: "mr",
    action: "diff",
    id: iid,
    repo: target,
  });

  if (changes.length === 0) {
    return renderOutput([
      `diff: no file changes found for merge request ${iid}`,
      renderHelp(nextSteps),
    ]);
  }

  let additions = 0;
  let deletions = 0;
  const files = changes.map((c) => {
    const counts = countDiffLines(c.diff);
    additions += counts.additions;
    deletions += counts.deletions;
    return { path: changePath(c), status: changeStatus(c), ...counts };
  });
  const plural = files.length === 1 ? "" : "s";
  const summary = `diff: ${files.length} file${plural} changed, +${additions} -${deletions}${overflow ? " (server-truncated: very large MR)" : ""}`;

  if (full) {
    const patch = changes.map(fileDiff).join("\n");
    const envelope: Record<string, Json> = {
      iid,
      files_changed: files.length,
      additions,
      deletions,
      diff: patch,
    };
    if (overflow) envelope.truncated = true;
    return renderOutput([
      renderDetail("merge_request_diff", envelope, [
        field("iid"),
        field("files_changed"),
        field("additions"),
        field("deletions"),
        ...(overflow ? [field("truncated")] : []),
        field("diff"),
      ]),
      renderHelp(nextSteps),
    ]);
  }

  const help = renderHelp([
    `Run \`glab-axi${repoFlag({ domain: "mr", action: "diff", repo: target })} mr diff ${iid} --full\` for the complete unified diff`,
    ...nextSteps,
  ]);
  return renderOutput([
    summary,
    renderList("files", files, [
      field("path"),
      field("status"),
      field("additions"),
      field("deletions"),
    ]),
    help,
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function mrCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return mrList(rest, ctx);
    case "view":
      return mrView(rest, ctx);
    case "create":
      return mrCreate(rest, ctx);
    case "update":
    case "edit":
      return mrUpdate(rest, ctx);
    case "merge":
      return mrMerge(rest, ctx);
    case "approve":
      return mrApprove(rest, ctx);
    case "checks":
      return mrChecks(rest, ctx);
    case "diff":
      return mrDiff(rest, ctx);
    case "comment":
      return mrComment(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return MR_HELP;
    default:
      return renderError(`Unknown mr subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `glab-axi mr --help` to see available subcommands",
      ]);
  }
}
