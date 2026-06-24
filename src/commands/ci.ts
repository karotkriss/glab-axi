import { glApi, glRaw, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { hasFlag, getFlag, getPositional, requireNumber } from "../args.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import { encode } from "@toon-format/toon";
import {
  field,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type Def,
} from "../toon.js";

export const CI_HELP = `usage: glab-axi ci <subcommand> [flags]
subcommands:
  list, view <pipeline-id>, status, jobs <pipeline-id>, log <job-id>, retry <pipeline-id>
flags{list}:
  --ref <branch>, --status <running|success|failed|...>, --limit <n> (default 20)
flags{view}:
  shows pipeline + its jobs
flags{status}:
  --branch <name> or --mr <iid>; summarizes the latest pipeline's job buckets (passed/failed/running)
flags{jobs}:
  --scope <failed|success|running|...>
flags{log}:
  --full (default tails the last 20k chars; failures are at the end)
examples:
  glab-axi ci status --mr 17
  glab-axi ci view 12345
  glab-axi ci log 67890 --full
notes:
  GitLab has no MR-level "checks" API: status resolves MR/branch -> latest
  pipeline -> jobs and aggregates job states. 'manual'/'skipped' jobs do not
  count as failures. This is the no-mistakes GetChecks/FetchFailedCheckLogs path.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// Tail the last N chars of a job trace (failures live at the end).
const LOG_TAIL_CHARS = 20000;

const pipelineListSchema: Def[] = [
  field("id"),
  lower("status"),
  field("ref"),
  field("source"),
  relativeTime("updated_at", "updated"),
];

const pipelineViewSchema: Def[] = [
  field("id"),
  lower("status"),
  field("ref"),
  field("sha"),
  field("source"),
  relativeTime("created_at", "created"),
  relativeTime("updated_at", "updated"),
  field("web_url", "url"),
];

const jobSchema: Def[] = [
  field("id"),
  field("name"),
  field("stage"),
  lower("status"),
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

// ---------------------------------------------------------------------------
// Bucket logic - mirror GitLab pipeline semantics (no-mistakes gitlabStatusBucket).
// ---------------------------------------------------------------------------

type Bucket = "passed" | "failed" | "running" | "neutral";

/** Classify one job into a bucket. allow_failure failures do NOT fail a pipeline. */
function bucketForJob(job: Json): Bucket {
  const status = String(job?.status ?? "");
  const allowFailure = job?.allow_failure === true;
  switch (status) {
    case "success":
      return "passed";
    case "failed":
      // A failed-but-allowed job is non-blocking (passed-ish), not a failure.
      return allowFailure ? "passed" : "failed";
    case "canceled":
      return "failed";
    case "running":
    case "pending":
    case "created":
      return "running";
    // manual + skipped (and anything else) are neutral: ignored for green.
    default:
      return "neutral";
  }
}

interface JobSummary {
  passed: number;
  failed: number;
  running: number;
  neutral: number;
  total: number;
}

function summarizeJobs(jobs: Json[]): JobSummary {
  const sum: JobSummary = {
    passed: 0,
    failed: 0,
    running: 0,
    neutral: 0,
    total: jobs.length,
  };
  for (const job of jobs) {
    sum[bucketForJob(job)]++;
  }
  return sum;
}

/** `checks: 3 passed, 1 failed, 0 running (4 jobs)` */
function summaryLine(sum: JobSummary): string {
  return `checks: ${sum.passed} passed, ${sum.failed} failed, ${sum.running} running (${sum.total} jobs)`;
}

/** Overall verdict an agent can branch on at a glance. */
function verdict(sum: JobSummary): string {
  if (sum.failed > 0) return "failed";
  if (sum.running > 0) return "running";
  return "passed";
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function listPipelines(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const ref = getFlag(args, "--ref");
  const status = getFlag(args, "--status");
  const limit = parseInt(getFlag(args, "--limit") ?? "20", 10);

  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (status) params.set("status", status);
  params.set("per_page", String(limit));
  params.set("order_by", "id");
  params.set("sort", "desc");

  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/pipelines?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("pipelines", items, pipelineListSchema),
  ];
  const help = isEmpty
    ? [
        ref
          ? `No pipelines for ref ${ref} - check the branch name or trigger one with a push`
          : `No pipelines found - run \`glab-axi${repoFlag(repo)} ci list --ref <branch>\` to scope by branch`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} ci view <pipeline-id>\` for its jobs`,
        `Run \`glab-axi${repoFlag(repo)} ci status --branch <name>\` for a passed/failed summary`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function viewPipeline(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const pid = requireNumber(getPositional(args, 1), "pipeline");

  const pipeline = await glApi<Json>(
    `projects/${projectId(repo)}/pipelines/${pid}`,
    { ctx: repo },
  );
  const jobs = await glApi<Json[]>(
    `projects/${projectId(repo)}/pipelines/${pid}/jobs?per_page=100`,
    { ctx: repo },
  );
  const sum = summarizeJobs(jobs);
  return renderOutput([
    renderDetail("pipeline", pipeline, pipelineViewSchema),
    summaryLine(sum),
    renderList("jobs", jobs, jobSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} ci jobs ${pid} --scope failed\` to list only failures`,
      `Run \`glab-axi${repoFlag(repo)} ci log <job-id>\` to read a job's trace`,
    ]),
  ]);
}

/** Resolve the latest pipeline for an MR iid or a branch ref. Returns its id. */
async function resolvePipelineId(
  args: string[],
  repo: RepoContext,
): Promise<{ id: number; ref: string }> {
  const mr = getFlag(args, "--mr");
  const branch = getFlag(args, "--branch") ?? getFlag(args, "--ref");

  if (mr !== undefined) {
    const iid = requireNumber(mr, "MR");
    const merge = await glApi<Json>(
      `projects/${projectId(repo)}/merge_requests/${iid}`,
      { ctx: repo },
    );
    const head = merge?.head_pipeline;
    if (head && typeof head.id === "number") {
      return { id: head.id, ref: `MR !${iid}` };
    }
    // Fall back to the MR's pipeline list (latest first).
    const pipes = await glApi<Json[]>(
      `projects/${projectId(repo)}/merge_requests/${iid}/pipelines`,
      { ctx: repo },
    );
    if (
      Array.isArray(pipes) &&
      pipes.length > 0 &&
      typeof pipes[0].id === "number"
    ) {
      return { id: pipes[0].id, ref: `MR !${iid}` };
    }
    throw new AxiError(
      `no pipeline found for MR !${iid} - it may not have run CI yet`,
      "NOT_FOUND",
      [`Run \`glab-axi${repoFlag(repo)} mr view ${iid}\` to inspect the MR`],
    );
  }

  if (branch !== undefined) {
    const params = new URLSearchParams();
    params.set("ref", branch);
    params.set("per_page", "1");
    params.set("order_by", "id");
    params.set("sort", "desc");
    const pipes = await glApi<Json[]>(
      `projects/${projectId(repo)}/pipelines?${params.toString()}`,
      { ctx: repo },
    );
    if (
      Array.isArray(pipes) &&
      pipes.length > 0 &&
      typeof pipes[0].id === "number"
    ) {
      return { id: pipes[0].id, ref: branch };
    }
    throw new AxiError(
      `no pipeline found for ${branch} - check the branch name or push to trigger CI`,
      "NOT_FOUND",
    );
  }

  throw new AxiError(
    "ci status needs a target - pass --mr <iid> or --branch <name>",
    "VALIDATION_ERROR",
    ["Example: glab-axi ci status --mr 17  (or)  ci status --branch main"],
  );
}

async function statusPipeline(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const { id, ref } = await resolvePipelineId(args, repo);

  const jobs = await glApi<Json[]>(
    `projects/${projectId(repo)}/pipelines/${id}/jobs?per_page=100`,
    { ctx: repo },
  );
  const sum = summarizeJobs(jobs);
  const result = verdict(sum);

  const blocks = [
    renderDetail(
      "pipeline_status",
      {
        pipeline: id,
        ref,
        result,
        summary: summaryLine(sum),
        passed: sum.passed,
        failed: sum.failed,
        running: sum.running,
        neutral: sum.neutral,
      },
      [
        field("pipeline"),
        field("ref"),
        field("result"),
        field("summary"),
        field("passed"),
        field("failed"),
        field("running"),
        field("neutral"),
      ],
    ),
    renderList("jobs", jobs, jobSchema),
  ];

  const help =
    sum.failed > 0
      ? [
          `Run \`glab-axi${repoFlag(repo)} ci jobs ${id} --scope failed\` to see which jobs failed`,
          `Run \`glab-axi${repoFlag(repo)} ci log <job-id>\` to read the failing trace`,
        ]
      : sum.running > 0
        ? [`Pipeline ${id} is still running - re-run \`ci status\` to poll`]
        : [`Pipeline ${id} is green (no blocking failures)`];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function listJobs(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const pid = requireNumber(getPositional(args, 1), "pipeline");
  const scope = getFlag(args, "--scope");

  const params = new URLSearchParams();
  params.set("per_page", "100");
  if (scope) params.set("scope", scope);

  const jobs = await glApi<Json[]>(
    `projects/${projectId(repo)}/pipelines/${pid}/jobs?${params.toString()}`,
    { ctx: repo },
  );
  const isEmpty = jobs.length === 0;
  const blocks = [
    formatCountLine({ count: jobs.length }),
    renderList("jobs", jobs, jobSchema),
  ];
  const help = isEmpty
    ? [
        scope
          ? `No ${scope} jobs in pipeline ${pid}`
          : `No jobs in pipeline ${pid}`,
      ]
    : [
        `Run \`glab-axi${repoFlag(repo)} ci log <job-id>\` to read a job's trace`,
      ];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function jobLog(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const jobId = requireNumber(getPositional(args, 1), "job");
  const full = hasFlag(args, "--full");

  // The trace endpoint returns PLAIN TEXT, not JSON.
  const result = await glRaw(
    ["api", `projects/${projectId(repo)}/jobs/${jobId}/trace`],
    repo,
  );
  if (result.exitCode !== 0) {
    throw new AxiError(
      `could not fetch trace for job ${jobId} - it may not exist or have no log`,
      "NOT_FOUND",
      [
        `Run \`glab-axi${repoFlag(repo)} ci jobs <pipeline-id>\` to find valid job ids`,
      ],
    );
  }

  const text = result.stdout ?? "";
  const originalLength = text.length;
  let output = text;
  let truncated = false;
  if (!full && originalLength > LOG_TAIL_CHARS) {
    output =
      `... (truncated to last ${LOG_TAIL_CHARS} of ${originalLength} chars - use --full for the whole log)\n` +
      text.slice(originalLength - LOG_TAIL_CHARS);
    truncated = true;
  }

  return encode({
    ci_log: {
      job: jobId,
      output,
      truncated,
      original_length: originalLength,
    },
  });
}

async function retryPipeline(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const pid = requireNumber(getPositional(args, 1), "pipeline");

  const pipeline = await glApi<Json>(
    `projects/${projectId(repo)}/pipelines/${pid}/retry`,
    { method: "POST", ctx: repo },
  );
  return renderOutput([
    renderDetail("retried", pipeline, [
      field("id"),
      lower("status"),
      field("ref"),
      field("web_url", "url"),
    ]),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} ci status --branch ${pipeline?.ref ?? "<branch>"}\` to watch it`,
    ]),
  ]);
}

export async function ciCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([CI_HELP]);
  switch (sub) {
    case "list":
      return listPipelines(args, ctx);
    case "view":
      return viewPipeline(args, ctx);
    case "status":
      return statusPipeline(args, ctx);
    case "jobs":
      return listJobs(args, ctx);
    case "log":
      return jobLog(args, ctx);
    case "retry":
      return retryPipeline(args, ctx);
    default:
      return renderError(`unknown ci subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `glab-axi ci --help` for usage",
      ]);
  }
}
