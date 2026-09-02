import { glApi, glApiList, requireProject, type Json } from "../gl.js";
import type { RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import { takeFlag, takeNumber, parseLimit } from "../args.js";
import {
  field,
  lower,
  boolYesNo,
  joinArray,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// runner: read-only introspection of the runners that serve a project, over the
// same project-runners endpoint the v0.6.0 stuck-job detection already uses
// (src/commands/ci.ts). `list` answers "which runners can take this project's
// jobs" and `view <id>` shows one runner's detail, including its tags.
//
// Honest caveat, load-bearing enough to state in the output: the REST runners
// API does NOT expose a runner's executor type (docker/shell/...), only its
// job_execution_status. A shell executor silently ignoring `image:`/`services:`
// is a real CI failure this cannot pre-empt, so `view` points at the job log's
// "Preparing the X executor" line rather than omitting the gap.
// ---------------------------------------------------------------------------

export const RUNNER_HELP = `usage: glab-axi runner <subcommand> [flags]
subcommands[2]:
  list, view <id>
flags{list}:
  --status <online|offline|stale|never_contacted>, --type <instance_type|group_type|project_type>, --tag-list <a,b> (only runners carrying every listed tag), --paused <true|false>, --limit <n> (default 30)
flags{view}:
  (none) - addresses a runner by its global id
notes:
  list shows the runners available to the resolved project (the same set CI job-to-runner matching uses); it is project-scoped (-R/--host/remote). For instance-wide runners run \`glab-axi api runners/all\`.
  Tags are not in the list response - run \`runner view <id>\` for a runner's tag_list. --tag-list uses AND semantics (a runner matches only if it carries every tag), the same rule GitLab applies to pick a runner for a job.
  The REST API does not report a runner's executor type (docker/shell/etc.); neither command can show it. Confirm it from a job log's "Preparing the X executor" line.
examples:
  glab-axi runner list
  glab-axi runner list --status online --tag-list docker
  glab-axi runner list --type project_type -R gitlab.example.com/group/project
  glab-axi runner view 175`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("id"),
  field("description"),
  field("runner_type", "type"),
  boolYesNo("online", "online"),
  boolYesNo("paused", "paused"),
  lower("status"),
];

const viewSchema: FieldDef[] = [
  field("id"),
  field("description"),
  field("runner_type", "type"),
  joinArray("tag_list", "", "tags"),
  boolYesNo("run_untagged", "run_untagged"),
  boolYesNo("online", "online"),
  boolYesNo("paused", "paused"),
  lower("status"),
  field("access_level"),
  field("platform"),
  field("version"),
  relativeTime("contacted_at", "last_contact"),
];

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runnerList(args: string[], ctx?: RepoContext): Promise<string> {
  const status = takeFlag(args, "--status");
  const type = takeFlag(args, "--type");
  const tagList = takeFlag(args, "--tag-list");
  const paused = takeFlag(args, "--paused");
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  if (tagList) params.set("tag_list", tagList);
  if (paused) params.set("paused", paused);

  const { data: items, total: totalCount } = await glApiList<Json>(
    `projects/${requireProject(ctx)}/runners?${params.toString()}`,
    { ctx },
  );
  if (items.length === 0) {
    return renderOutput([
      "runners: 0 runners found",
      renderHelp([
        `Run \`glab-axi api runners/all${repoFlag({ domain: "runner", action: "list", repo: ctx })}\` to list every runner on the instance (requires admin)`,
      ]),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: items.length, limit, totalCount }),
    renderList("runners", items, listSchema),
    renderHelp([
      `Run \`glab-axi runner view <id>${repoFlag({ domain: "runner", action: "list", repo: ctx })}\` for a runner's tags and detail`,
    ]),
  ]);
}

async function runnerView(args: string[], ctx?: RepoContext): Promise<string> {
  const id = takeNumber(args, "runner");
  const runner = await glApi<Json>(`runners/${id}`, { ctx });
  return renderOutput([
    renderDetail("runner", runner, viewSchema),
    renderHelp([
      'The executor type (docker/shell/...) is not in the API - read a job log\'s "Preparing the X executor" line to confirm it',
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runnerCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return runnerList(rest, ctx);
    case "view":
      return runnerView(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return RUNNER_HELP;
    default:
      return refuseSubcommand("runner", sub, RUNNER_HELP);
  }
}
