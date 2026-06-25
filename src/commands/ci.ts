import { encode } from "@toon-format/toon";
import { glApi, glRaw, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, takeBoolFlag, takeNumber, parseLimit } from "../args.js";
import {
  field,
  lower,
  custom,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
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
function renderSummary(jobs: Json[]): string {
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
subcommands[6]:
  list, view <id>, status, jobs <pipeline-id>, log <job-id>, retry <pipeline-id>
flags{list}:
  --ref <branch>, --status <created|pending|running|success|failed|canceled|skipped|manual>, --limit <n> (default 20)
flags{status}:
  --mr <iid> (pipeline for a merge request), --branch <b> (latest pipeline on a branch)
flags{log}:
  --full (return the entire trace instead of the last 20000 chars)
examples:
  glab-axi ci list --ref main --status failed
  glab-axi ci view 12345
  glab-axi ci status --mr 42
  glab-axi ci status --branch feature-1
  glab-axi ci jobs 12345
  glab-axi ci log 67890
  glab-axi ci retry 12345`;

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

async function fetchJobs(pid: number, ctx?: RepoContext): Promise<Json[]> {
  return glApi<Json[]>(
    `projects/${requireProject(ctx)}/pipelines/${pid}/jobs`,
    { ctx },
  );
}

async function ciStatus(args: string[], ctx?: RepoContext): Promise<string> {
  const mrIid = takeFlag(args, "--mr");
  const branch = takeFlag(args, "--branch");

  let pipeline: Json | undefined;

  if (mrIid) {
    const mr = await glApi<Json>(
      `projects/${requireProject(ctx)}/merge_requests/${mrIid}`,
      { ctx },
    );
    if (mr.head_pipeline) {
      pipeline = mr.head_pipeline;
    } else {
      const pipes = await glApi<Json[]>(
        `projects/${requireProject(ctx)}/merge_requests/${mrIid}/pipelines`,
        { ctx },
      );
      pipeline = pipes?.[0];
    }
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
    case "jobs":
      return ciJobs(rest, ctx);
    case "log":
      return ciLog(rest, ctx);
    case "retry":
      return ciRetry(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return CI_HELP;
    default:
      return renderError(`Unknown ci subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `glab-axi ci --help` to see available subcommands",
      ]);
  }
}
