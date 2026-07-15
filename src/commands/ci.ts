import { encode } from "@toon-format/toon";
import { glApi, glRaw, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions, repoFlag } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import { resolveDefaultBranch } from "./repo.js";
import {
  takeFlag,
  takeBoolFlag,
  takeAllFlags,
  takeNumber,
  parseLimit,
} from "../args.js";
import { sleep } from "../sleep.js";
import {
  field,
  lower,
  custom,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Job status bucketing
// ---------------------------------------------------------------------------

type Bucket = "passed" | "failed" | "running" | "neutral";

/**
 * Classify a single job into one of four buckets. This is the load-bearing
 * GetChecks contract: an allowed failure counts as a pass, a canceled job
 * counts as a failure, and manual/skipped jobs are neutral (never failures).
 */
function classifyJob(job: Json): Bucket {
  const status = job.status;
  switch (status) {
    case "success":
      return "passed";
    case "failed":
      return job.allow_failure === true ? "passed" : "failed";
    case "canceled":
      return "failed";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "waiting_for_resource":
    case "scheduled":
      return "running";
    case "manual":
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Parse a `--field KEY=value` pipeline variable. The value may contain "=". */
function parseVariable(raw: string): { key: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new AxiError(
      `--field must be KEY=value: ${raw}`,
      "VALIDATION_ERROR",
      ["Run `glab-axi ci run --ref main --field DEPLOY_ENV=staging`"],
    );
  }
  return { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

// ---------------------------------------------------------------------------
// Pipeline terminal-state detection (for `ci watch`)
// ---------------------------------------------------------------------------

/**
 * Pipeline statuses that mean "still going". We list the ACTIVE set rather than
 * the terminal set on purpose: any status we don't recognize is then treated as
 * terminal, so `ci watch` can never spin forever on a status GitLab adds later.
 */
const ACTIVE_PIPELINE_STATUSES = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

function isPipelineTerminal(status: unknown): boolean {
  return typeof status !== "string" || !ACTIVE_PIPELINE_STATUSES.has(status);
}

interface JobSummary {
  passed: number;
  failed: number;
  running: number;
  neutral: number;
  verdict: "failing" | "running" | "passing" | "no jobs";
}

function summarizeJobs(jobs: Json[]): JobSummary {
  let passed = 0;
  let failed = 0;
  let running = 0;
  let neutral = 0;
  for (const job of jobs) {
    switch (classifyJob(job)) {
      case "passed":
        passed++;
        break;
      case "failed":
        failed++;
        break;
      case "running":
        running++;
        break;
      case "neutral":
        neutral++;
        break;
    }
  }
  let verdict: JobSummary["verdict"];
  if (failed > 0) verdict = "failing";
  else if (running > 0) verdict = "running";
  else if (passed > 0) verdict = "passing";
  else verdict = "no jobs";
  return { passed, failed, running, neutral, verdict };
}

/** Render the at-a-glance summary + verdict lines (the GetChecks header). */
export function renderSummary(jobs: Json[]): string {
  const s = summarizeJobs(jobs);
  let checks = `checks: ${s.passed} passed, ${s.failed} failed`;
  if (s.running > 0) checks += `, ${s.running} running`;
  return renderOutput([checks, `verdict: ${s.verdict}`]);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("id"),
  lower("status"),
  field("ref"),
  custom("sha", (p) => (typeof p.sha === "string" ? p.sha.slice(0, 8) : "")),
  relativeTime("updated_at", "updated"),
];

const pipelineDetailSchema: FieldDef[] = [
  field("id"),
  lower("status"),
  field("ref"),
  field("sha"),
  field("web_url"),
];

const jobSchema: FieldDef[] = [
  field("id"),
  field("name"),
  lower("status"),
  field("stage"),
  custom("bucket", (job) => classifyJob(job)),
];

function renderJobs(jobs: Json[]): string {
  return renderList("jobs", jobs, jobSchema);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const CI_HELP = `usage: glab-axi ci <subcommand> [flags]
subcommands[9]:
  list, view <id>, status, jobs <pipeline-id>, watch <pipeline-id>, log <job-id>, run, retry <pipeline-id>, cancel <pipeline-id>
flags{list}:
  --ref <branch>, --status <created|pending|running|success|failed|canceled|skipped|manual>, --limit <n> (default 20)
flags{status}:
  --mr <iid> (pipeline for a merge request), --branch <b> (latest pipeline on a branch)
flags{watch}:
  --interval <seconds> (default 8), --timeout <seconds> (default 1800)
flags{log}:
  --full (return the entire trace instead of the last 20000 chars)
flags{run}:
  --ref <branch|tag> (default: the project's default branch), --field <KEY=value> (pipeline variable, repeatable)
notes:
  watch blocks until the pipeline finishes, prints the final verdict, and exits non-zero if it did not succeed.
  run triggers a new pipeline from the project's .gitlab-ci.yml on --ref. GitLab has no workflow entity to select or dispatch (the ref determines what runs), so there is no workflow list/enable/disable here.
  cancel is a no-op (already: true) on a pipeline that already finished.
examples:
  glab-axi ci list --ref main --status failed
  glab-axi ci view 12345
  glab-axi ci status --mr 42
  glab-axi ci status --branch feature-1
  glab-axi ci jobs 12345
  glab-axi ci watch 12345
  glab-axi ci log 67890
  glab-axi ci run --ref main --field DEPLOY_ENV=staging
  glab-axi ci retry 12345
  glab-axi ci cancel 12345`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function ciList(args: string[], ctx?: RepoContext): Promise<string> {
  const ref = takeFlag(args, "--ref");
  const status = takeFlag(args, "--status");
  const limit = parseLimit(takeFlag(args, "--limit"), 20);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));
  params.set("order_by", "updated_at");
  if (ref) params.set("ref", ref);
  if (status) params.set("status", status);

  const items =
    (await glApi<Json[]>(
      `projects/${requireProject(ctx)}/pipelines?${params.toString()}`,
      { ctx },
    )) ?? [];
  const isEmpty = items.length === 0;
  if (isEmpty) {
    return renderOutput([
      "pipelines: 0 pipelines found",
      renderHelp(
        getSuggestions({ domain: "ci", action: "list", isEmpty, repo: ctx }),
      ),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: items.length, limit }),
    renderList("pipelines", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "ci", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function ciView(args: string[], ctx?: RepoContext): Promise<string> {
  const pid = takeNumber(args, "pipeline");
  const base = `projects/${requireProject(ctx)}/pipelines/${pid}`;
  const pipeline = await glApi<Json>(base, { ctx });
  const jobs = await glApi<Json[]>(`${base}/jobs`, { ctx });

  return renderOutput([
    renderDetail("pipeline", pipeline, pipelineDetailSchema),
    renderSummary(jobs),
    renderJobs(jobs),
    renderHelp(
      getSuggestions({ domain: "ci", action: "view", id: pid, repo: ctx }),
    ),
  ]);
}

export async function fetchJobs(
  pid: number,
  ctx?: RepoContext,
): Promise<Json[]> {
  return glApi<Json[]>(
    `projects/${requireProject(ctx)}/pipelines/${pid}/jobs`,
    { ctx },
  );
}

/**
 * Resolve the pipeline for a merge request: its head pipeline when present,
 * otherwise the most recent pipeline the MR ran. Returns undefined when the MR
 * has no pipeline at all. Shared by `ci status --mr` and `mr checks`.
 */
export async function resolveMrPipeline(
  mrIid: string | number,
  ctx?: RepoContext,
): Promise<Json | undefined> {
  const mr = await glApi<Json>(
    `projects/${requireProject(ctx)}/merge_requests/${mrIid}`,
    { ctx },
  );
  if (mr.head_pipeline) return mr.head_pipeline;
  const pipes = await glApi<Json[]>(
    `projects/${requireProject(ctx)}/merge_requests/${mrIid}/pipelines`,
    { ctx },
  );
  return pipes?.[0];
}

async function ciStatus(args: string[], ctx?: RepoContext): Promise<string> {
  const mrIid = takeFlag(args, "--mr");
  const branch = takeFlag(args, "--branch");

  let pipeline: Json | undefined;

  if (mrIid) {
    pipeline = await resolveMrPipeline(mrIid, ctx);
    if (!pipeline) {
      return renderOutput([
        `pipeline: no pipeline found for merge request ${mrIid}`,
        renderHelp(
          getSuggestions({ domain: "ci", action: "status", repo: ctx }),
        ),
      ]);
    }
  } else if (branch) {
    const params = new URLSearchParams();
    params.set("ref", branch);
    params.set("per_page", "1");
    const pipes = await glApi<Json[]>(
      `projects/${requireProject(ctx)}/pipelines?${params.toString()}`,
      { ctx },
    );
    pipeline = pipes?.[0];
    if (!pipeline) {
      return renderOutput([
        `pipeline: no pipeline found for branch ${branch}`,
        renderHelp(
          getSuggestions({ domain: "ci", action: "status", repo: ctx }),
        ),
      ]);
    }
  } else {
    throw new AxiError(
      "ci status needs a target: pass --mr <iid> or --branch <branch>",
      "VALIDATION_ERROR",
      ["glab-axi ci status --mr <iid>", "glab-axi ci status --branch <branch>"],
    );
  }

  const jobs = await fetchJobs(pipeline.id, ctx);
  return renderOutput([
    renderDetail("pipeline", pipeline, pipelineDetailSchema),
    renderSummary(jobs),
    renderJobs(jobs),
    renderHelp(
      getSuggestions({
        domain: "ci",
        action: "status",
        id: pipeline.id,
        repo: ctx,
      }),
    ),
  ]);
}

const DEFAULT_WATCH_INTERVAL_SEC = 8;
const DEFAULT_WATCH_TIMEOUT_SEC = 1800;

/**
 * Block until a pipeline reaches a terminal state, then print the same verdict
 * aggregate `ci status` produces. Mirrors gh-axi `run watch`: a pipeline that
 * did not succeed is a real failure the caller must act on, so we signal it with
 * a non-zero exit code. The AXI SDK's only non-zero channel is a thrown error
 * (which would replace the verdict output), so a failed-but-completed pipeline
 * sets `process.exitCode` directly and still returns the verdict on stdout.
 */
async function ciWatch(args: string[], ctx?: RepoContext): Promise<string> {
  const intervalSec = parseLimit(
    takeFlag(args, "--interval"),
    DEFAULT_WATCH_INTERVAL_SEC,
  );
  const timeoutSec = parseLimit(
    takeFlag(args, "--timeout"),
    DEFAULT_WATCH_TIMEOUT_SEC,
  );
  const pid = takeNumber(args, "pipeline");
  const base = `projects/${requireProject(ctx)}/pipelines/${pid}`;

  // ponytail: bound the loop by poll count (timeout / interval), not wall-clock.
  // It can never spin forever and is deterministic to test; if a slow API pushes
  // real elapsed past the timeout, the loop still terminates.
  const maxPolls = Math.max(1, Math.ceil(timeoutSec / intervalSec));

  let terminal: Json | undefined;
  for (let poll = 0; poll < maxPolls; poll++) {
    const pipeline = await glApi<Json>(base, { ctx });
    if (isPipelineTerminal(pipeline?.status)) {
      terminal = pipeline;
      break;
    }
    if (poll < maxPolls - 1) await sleep(intervalSec * 1000);
  }

  if (!terminal) {
    throw new AxiError(
      `Timed out after ~${timeoutSec}s waiting for pipeline ${pid} to finish`,
      "TIMEOUT",
      [
        `Run \`glab-axi ci view ${pid}${repoFlag({ domain: "ci", action: "watch", repo: ctx })}\` to check current status`,
        "Increase the wait with `--timeout <seconds>`",
      ],
    );
  }

  const jobs = await fetchJobs(terminal.id, ctx);
  if (terminal.status !== "success") process.exitCode = 1;

  return renderOutput([
    renderDetail("pipeline", terminal, pipelineDetailSchema),
    renderSummary(jobs),
    renderJobs(jobs),
    renderHelp(
      getSuggestions({
        domain: "ci",
        action: "watch",
        id: terminal.id,
        repo: ctx,
      }),
    ),
  ]);
}

async function ciJobs(args: string[], ctx?: RepoContext): Promise<string> {
  const pid = takeNumber(args, "pipeline");
  const jobs = await fetchJobs(pid, ctx);
  return renderOutput([
    renderSummary(jobs),
    renderJobs(jobs),
    renderHelp(
      getSuggestions({ domain: "ci", action: "jobs", id: pid, repo: ctx }),
    ),
  ]);
}

const LOG_TAIL_CHARS = 20000;

async function ciLog(args: string[], ctx?: RepoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const jobId = takeNumber(args, "job");
  const trace = await glRaw(
    `projects/${requireProject(ctx)}/jobs/${jobId}/trace`,
    { ctx },
  );

  const originalLength = trace.length;
  const truncated = !full && originalLength > LOG_TAIL_CHARS;
  const log = truncated ? trace.slice(originalLength - LOG_TAIL_CHARS) : trace;

  const envelope: Record<string, Json> = {
    job: jobId,
    log,
    truncated,
  };
  if (truncated) envelope.original_length = originalLength;

  const blocks: Array<string | undefined> = [encode({ job_log: envelope })];
  if (truncated) {
    blocks.push(
      renderHelp(
        getSuggestions({ domain: "ci", action: "log", id: jobId, repo: ctx }),
      ),
    );
  }
  return renderOutput(blocks);
}

async function ciRetry(args: string[], ctx?: RepoContext): Promise<string> {
  const pid = takeNumber(args, "pipeline");
  const pipeline = await glApi<Json>(
    `projects/${requireProject(ctx)}/pipelines/${pid}/retry`,
    { method: "POST", ctx },
  );
  return renderOutput([
    renderDetail("pipeline", pipeline, [field("id"), lower("status")]),
    renderHelp(
      getSuggestions({ domain: "ci", action: "retry", id: pid, repo: ctx }),
    ),
  ]);
}

async function ciCancel(args: string[], ctx?: RepoContext): Promise<string> {
  const pid = takeNumber(args, "pipeline");

  // Idempotent: GET first and skip the POST when the pipeline already finished.
  // This reuses `ci watch`'s terminal-state rule rather than relying on how
  // GitLab answers a cancel on a finished pipeline, which varies by version.
  // Reporting `status` from the GET is also the honest answer - a canceled
  // pipeline says `canceled`, a passed one still says `success`.
  const current = await glApi<Json>(
    `projects/${requireProject(ctx)}/pipelines/${pid}`,
    { ctx },
  );
  if (isPipelineTerminal(current?.status)) {
    return renderOutput([
      renderDetail("pipeline", { ...current, already: true }, [
        field("id"),
        lower("status"),
        field("already"),
      ]),
      renderHelp(
        getSuggestions({ domain: "ci", action: "cancel", id: pid, repo: ctx }),
      ),
    ]);
  }

  const pipeline = await glApi<Json>(
    `projects/${requireProject(ctx)}/pipelines/${pid}/cancel`,
    { method: "POST", ctx },
  );
  return renderOutput([
    renderDetail("canceled", pipeline, [field("id"), lower("status")]),
    renderHelp(
      getSuggestions({ domain: "ci", action: "cancel", id: pid, repo: ctx }),
    ),
  ]);
}

async function ciRun(args: string[], ctx?: RepoContext): Promise<string> {
  const refFlag = takeFlag(args, "--ref");
  const variables = takeAllFlags(args, "--field").map(parseVariable);
  const ref =
    refFlag ??
    (await resolveDefaultBranch(ctx, [
      "Pass --ref <branch> to run the pipeline on a specific branch or tag",
    ]));

  const rawFields = [`ref=${ref}`];
  for (const v of variables) {
    // Emit key then value per variable: GitLab's Rails param parser starts a
    // new object once it sees a subkey the current one already has, so paired
    // key/value runs group into distinct variables (same rule as release assets).
    rawFields.push(`variables[][key]=${v.key}`);
    rawFields.push(`variables[][value]=${v.value}`);
  }

  const pipeline = await glApi<Json>(
    `projects/${requireProject(ctx)}/pipeline`,
    { method: "POST", rawFields, ctx },
  );
  return renderOutput([
    renderDetail("created", { ...pipeline, ref: pipeline?.ref ?? ref }, [
      field("id"),
      field("ref"),
      lower("status"),
      field("web_url", "url"),
    ]),
    renderHelp(
      getSuggestions({
        domain: "ci",
        action: "run",
        id: pipeline?.id,
        repo: ctx,
      }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function ciCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return ciList(rest, ctx);
    case "view":
      return ciView(rest, ctx);
    case "status":
      return ciStatus(rest, ctx);
    case "watch":
      return ciWatch(rest, ctx);
    case "jobs":
      return ciJobs(rest, ctx);
    case "log":
      return ciLog(rest, ctx);
    case "retry":
      return ciRetry(rest, ctx);
    case "cancel":
      return ciCancel(rest, ctx);
    case "run":
      return ciRun(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return CI_HELP;
    default:
      return refuseSubcommand("ci", sub);
  }
}
