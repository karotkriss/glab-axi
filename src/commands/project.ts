import {
  glApi,
  glApiResult,
  projectId,
  requireProject,
  type Json,
} from "../gl.js";
import { AxiError, scrubTool } from "../errors.js";
import { parseRepoArg, type RepoContext } from "../context.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, takeBoolFlag, getPositional, parseLimit } from "../args.js";
import {
  field,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const viewSchema: FieldDef[] = [
  field("path_with_namespace", "project"),
  field("description"),
  field("default_branch"),
  lower("visibility"),
  field("star_count", "stars"),
  field("forks_count", "forks"),
  field("open_issues_count", "open_issues"),
  relativeTime("last_activity_at", "last_activity"),
  field("web_url", "url"),
];

const listSchema: FieldDef[] = [
  field("path_with_namespace", "project"),
  field("description"),
  field("default_branch"),
  relativeTime("last_activity_at", "last_activity"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const PROJECT_HELP = `usage: glab-axi project <subcommand> [flags]
subcommands[4]:
  view, list, create <[namespace/]name>, delete <id|[host/]group/project>
flags{view}:
  (none — addresses the resolved project)
flags{list}:
  --search <q>, --limit <n> (default 30)
flags{create}:
  --public | --internal | --private (visibility; default private), --description <text>, --readme (initialize with a README)
flags{delete}:
  --yes/-y (required: confirms the deletion)
notes:
  create takes the new project as a positional [namespace/]name (mirroring \`owner/repo\`): a leading group or user namespace is resolved to namespace_id, else the project lands under your own account. The host comes from -R/GITLAB_HOST, not the positional. --template and --clone (GitHub concepts) are refused with guidance rather than silently ignored.
  delete names its target explicitly as a positional (a numeric project id, or a path) - it never falls back to the resolved project, so it cannot delete the project you happen to be standing in. It destroys the repository, issues, and merge requests, so it requires --yes and never prompts. A repeat delete is a no-op (already_absent). Where the instance enables delayed project deletion, the project is marked for deletion rather than removed immediately.
examples:
  glab-axi project view -R gitlab.example.com/group/project
  glab-axi project list --search platform
  glab-axi project create my-service --description "Payments service"
  glab-axi project create my-group/my-service --internal --readme
  glab-axi project delete my-group/my-service --yes
  glab-axi project delete 1234 --yes`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function projectView(ctx?: RepoContext): Promise<string> {
  // requireProject throws an actionable error when ctx is unresolved.
  requireProject(ctx);
  const proj = await glApi<Json>(`projects/${projectId(ctx)}`, { ctx });
  return renderOutput([
    renderDetail("project", proj, viewSchema),
    renderHelp(
      getSuggestions({ domain: "project", action: "view", repo: ctx }),
    ),
  ]);
}

async function projectList(args: string[], ctx?: RepoContext): Promise<string> {
  const search = takeFlag(args, "--search");
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  params.set("membership", "true");
  params.set("per_page", String(limit));
  params.set("order_by", "last_activity_at");
  if (search) params.set("search", search);

  const items =
    (await glApi<Json[]>(`projects?${params.toString()}`, { ctx })) ?? [];
  const isEmpty = items.length === 0;

  if (isEmpty) {
    return renderOutput([
      "projects: 0 projects found",
      renderHelp(
        getSuggestions({
          domain: "project",
          action: "list",
          isEmpty,
          repo: ctx,
        }),
      ),
    ]);
  }
  return renderOutput([
    formatCountLine({ count: items.length, limit }),
    renderList("projects", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "project", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

/**
 * Resolve a group/user namespace path to its numeric id and canonical full
 * path. GitLab's `POST /projects` only accepts `namespace_id` (an integer),
 * never a path, so an org-owned create must look the namespace up first.
 */
async function resolveNamespace(
  namespacePath: string,
  ctx?: RepoContext,
): Promise<{ id: number; fullPath: string }> {
  try {
    const ns = await glApi<Json>(
      `namespaces/${encodeURIComponent(namespacePath)}`,
      { ctx },
    );
    return { id: ns.id, fullPath: ns.full_path ?? namespacePath };
  } catch (err) {
    if (err instanceof AxiError && err.code === "NOT_FOUND") {
      throw new AxiError(
        `Namespace not found: ${namespacePath}`,
        "VALIDATION_ERROR",
        [
          "Pass an existing group or user namespace, e.g. `glab-axi project create my-group/my-service`",
          "Omit the namespace to create the project under your own account",
        ],
      );
    }
    throw err;
  }
}

/** Build a `-R` target (host-qualified when known) for follow-up suggestions. */
function suggestTarget(ctx: RepoContext | undefined, path: string): string {
  return ctx?.host ? `${ctx.host}/${path}` : path;
}

async function projectCreate(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  // GitHub concepts with no clean `glab api` create path. Refuse loudly (like
  // release's --draft) rather than silently ignore: an agent carrying gh muscle
  // memory would otherwise believe it cloned/templated when nothing happened.
  if (takeBoolFlag(args, "--clone")) {
    throw new AxiError(
      "Cloning after create is not supported - this creates the project through the GitLab API only",
      "VALIDATION_ERROR",
      ["Create the project, then `git clone` the returned url yourself"],
    );
  }
  if (takeFlag(args, "--template") !== undefined) {
    throw new AxiError(
      "Creating from a template repository is not supported - GitLab templates work differently from GitHub's",
      "VALIDATION_ERROR",
      [
        "Create an empty project here, or apply a GitLab group/instance project template via the GitLab UI",
      ],
    );
  }

  const isPublic = takeBoolFlag(args, "--public");
  const isInternal = takeBoolFlag(args, "--internal");
  const isPrivate = takeBoolFlag(args, "--private");
  const chosen = [
    isPublic ? "public" : undefined,
    isInternal ? "internal" : undefined,
    isPrivate ? "private" : undefined,
  ].filter((v): v is string => v !== undefined);
  if (chosen.length > 1) {
    throw new AxiError(
      "Choose a single visibility: --public, --internal, or --private",
      "VALIDATION_ERROR",
    );
  }
  // Default private: GitLab's own API default and the safe choice - never
  // create a public project unless the caller explicitly asks.
  const visibility = chosen[0] ?? "private";
  const description = takeFlag(args, "--description");
  const readme = takeBoolFlag(args, "--readme");

  const raw = getPositional(args, 0);
  if (!raw) {
    throw new AxiError("Missing project name", "VALIDATION_ERROR", [
      'glab-axi project create [namespace/]<name> [--public|--internal|--private] [--description "..."] [--readme]',
    ]);
  }
  const slash = raw.lastIndexOf("/");
  const namespacePath = slash === -1 ? undefined : raw.slice(0, slash);
  const name = slash === -1 ? raw : raw.slice(slash + 1);
  if (!name) {
    throw new AxiError(`Invalid project name: ${raw}`, "VALIDATION_ERROR", [
      "glab-axi project create [namespace/]<name>",
    ]);
  }

  // Resolve the owner path (group full_path or your own username) so the create
  // is idempotent: a GET on the target path avoids a duplicate POST and gives a
  // definitive no-op when the project already exists.
  let namespaceId: number | undefined;
  let ownerPath: string;
  if (namespacePath) {
    const ns = await resolveNamespace(namespacePath, ctx);
    namespaceId = ns.id;
    ownerPath = ns.fullPath;
  } else {
    const me = await glApi<Json>("user", { ctx });
    ownerPath = me?.username ?? "";
  }
  const fullPath = ownerPath ? `${ownerPath}/${name}` : name;

  const existing = await glApiResult(
    `projects/${encodeURIComponent(fullPath)}`,
    { ctx },
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    let proj: Json = {};
    try {
      proj = JSON.parse(existing.stdout);
    } catch {
      /* fall back to the values we already know */
    }
    const path = proj.path_with_namespace ?? fullPath;
    return renderOutput([
      renderDetail(
        "project",
        {
          project: path,
          visibility: proj.visibility ?? visibility,
          url: proj.web_url ?? null,
          already: true,
        },
        [field("project"), lower("visibility"), field("url"), field("already")],
      ),
      renderHelp(
        getSuggestions({
          domain: "project",
          action: "create",
          id: suggestTarget(ctx, path),
          repo: ctx,
        }),
      ),
    ]);
  }

  const rawFields = [
    `name=${name}`,
    `path=${name}`,
    `visibility=${visibility}`,
  ];
  if (description !== undefined) rawFields.push(`description=${description}`);
  const fields: string[] = [];
  if (namespaceId !== undefined) fields.push(`namespace_id=${namespaceId}`);
  if (readme) fields.push("initialize_with_readme=true");

  const created = await glApi<Json>("projects", {
    method: "POST",
    rawFields,
    fields,
    ctx,
  });
  const path = created.path_with_namespace ?? fullPath;
  return renderOutput([
    renderDetail(
      "created",
      {
        project: path,
        visibility: created.visibility ?? visibility,
        url: created.web_url ?? null,
      },
      [field("project"), lower("visibility"), field("url")],
    ),
    renderHelp(
      getSuggestions({
        domain: "project",
        action: "create",
        id: suggestTarget(ctx, path),
        repo: ctx,
      }),
    ),
  ]);
}

/**
 * Resolve `delete`'s target from its positional: a numeric project id, or a
 * `[host/]group/project` path. A path may carry its own host, which targets the
 * request unless an explicit `-R` flag was given (precedence: `-R` flag >
 * positional host > git remote), mirroring how `mr view` treats an MR URL.
 */
function resolveDeleteTarget(
  raw: string,
  ctx?: RepoContext,
): { id: string; label: string; ctx?: RepoContext } {
  // A numeric id addresses the project directly as the REST :id; only the host
  // comes from the context.
  if (/^\d+$/.test(raw)) return { id: raw, label: raw, ctx };

  const parsed = parseRepoArg(raw, "flag");
  if (!parsed) {
    throw new AxiError(`Invalid project: ${raw}`, "VALIDATION_ERROR", [
      "Pass a numeric project id or a [host/]group/project path, e.g. `glab-axi project delete my-group/my-service --yes`",
    ]);
  }
  const flagHost = ctx?.source === "flag" ? ctx.host : undefined;
  const host = flagHost ?? parsed.host ?? ctx?.host;
  return {
    id: encodeURIComponent(parsed.project),
    label: parsed.project,
    ctx: { ...parsed, host },
  };
}

async function projectDelete(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  // Consume both aliases unconditionally (not `||`, which short-circuits and
  // leaves the other flag in args to be misread as the target positional).
  const confirmedYes = takeBoolFlag(args, "--yes");
  const confirmedY = takeBoolFlag(args, "-y");
  const confirmed = confirmedYes || confirmedY;
  const raw = getPositional(args, 0);
  if (!raw) {
    throw new AxiError("Missing project", "VALIDATION_ERROR", [
      "glab-axi project delete <id|[host/]group/project> --yes",
    ]);
  }
  const target = resolveDeleteTarget(raw, ctx);

  // Destructive and irreversible, so it is confirmed by flag. An agent cannot
  // answer a prompt, so this refuses instead of asking (AXI: no interactive
  // prompts - every operation completes with flags alone).
  if (!confirmed) {
    throw new AxiError(
      `Refusing to delete project ${target.label} without confirmation - this destroys its repository, issues, and merge requests`,
      "VALIDATION_ERROR",
      [`Re-run with --yes: \`glab-axi project delete ${raw} --yes\``],
    );
  }

  const path = `projects/${target.id}`;
  const hints = getSuggestions({ domain: "project", action: "delete" });

  // Idempotent: GET first so a repeat delete is a definitive no-op rather than
  // an error (mirrors `release delete`).
  const existing = await glApiResult(path, { ctx: target.ctx });
  if (existing.exitCode !== 0) {
    const text = `${existing.stderr} ${existing.stdout}`;
    if (/404|not found/i.test(text)) {
      return renderOutput([
        renderDetail(
          "project",
          { project: target.label, already_absent: true },
          [field("project"), field("already_absent")],
        ),
        renderHelp(hints),
      ]);
    }
    throw new AxiError(
      scrubTool(existing.stderr || existing.stdout) ||
        "Failed to look up project",
      "UNKNOWN",
    );
  }

  const before = parseProject(existing.stdout);

  // Where the instance defers deletion, a second DELETE is rejected with a 400
  // ("already marked for deletion"). It is already in the target state, so
  // report that instead of erroring.
  if (before?.marked_for_deletion_on) {
    return renderScheduled(
      target.label,
      before.marked_for_deletion_on,
      true,
      hints,
    );
  }

  const result = await glApiResult(path, { method: "DELETE", ctx: target.ctx });
  if (result.exitCode !== 0) {
    throw new AxiError(
      scrubTool(result.stderr || result.stdout) || "Failed to delete project",
      "UNKNOWN",
    );
  }

  // Report what the server did, not what was asked of it. GitLab's DELETE
  // answers "202 Accepted" either way, so the outcome has to be read back:
  // where delayed deletion is enabled the project still exists, renamed to
  // <path>-deletion_scheduled-<id>. That rename is why the read-back goes by
  // numeric id - the path we deleted by now 404s even though the project lives.
  const verification: DeleteVerification =
    before?.id === undefined
      ? {
          status: "unverifiable",
          reason: "No numeric project id was captured before deletion",
        }
      : await readMarkedForDeletion(`projects/${before.id}`, target.ctx);

  if (verification.status === "scheduled") {
    return renderScheduled(target.label, verification.purgeAfter, false, hints);
  }
  if (verification.status === "unverifiable") {
    return renderUnverifiable(target.label, verification.reason, hints);
  }

  return renderOutput([
    renderDetail("deleted", { project: target.label, status: "ok" }, [
      field("project"),
      field("status"),
    ]),
    renderHelp(hints),
  ]);
}

/** Parse a project response body, tolerating a non-JSON payload. */
function parseProject(body: string): Json | undefined {
  try {
    return JSON.parse(body) as Json;
  } catch {
    return undefined;
  }
}

/**
 * The outcome of reading a project back after DELETE: purged (a genuine 404 -
 * the project is really gone), scheduled (still exists, marked for deferred
 * deletion), or unverifiable (the read-back itself failed for a reason other
 * than "not found", so the true state is unknown).
 */
type DeleteVerification =
  | { status: "purged" }
  | { status: "scheduled"; purgeAfter: string }
  | { status: "unverifiable"; reason: string };

/** Read back a project post-DELETE to distinguish purged/scheduled/unverifiable. */
async function readMarkedForDeletion(
  path: string,
  ctx?: RepoContext,
): Promise<DeleteVerification> {
  const result = await glApiResult(path, { ctx });
  if (result.exitCode !== 0) {
    const text = `${result.stderr} ${result.stdout}`;
    if (/404|not found/i.test(text)) return { status: "purged" };
    return {
      status: "unverifiable",
      reason:
        scrubTool(result.stderr || result.stdout) ||
        "Verification request failed",
    };
  }
  const proj = parseProject(result.stdout);
  if (proj === undefined) {
    return {
      status: "unverifiable",
      reason: "Verification response could not be parsed",
    };
  }
  if (proj.marked_for_deletion_on) {
    return { status: "scheduled", purgeAfter: proj.marked_for_deletion_on };
  }
  return {
    status: "unverifiable",
    reason: "Project still exists but was not marked for deletion",
  };
}

/** Render a deletion whose outcome could not be confirmed against the server. */
function renderUnverifiable(
  label: string,
  reason: string,
  hints: string[],
): string {
  return renderOutput([
    renderDetail("deleted", { project: label, status: "unknown", reason }, [
      field("project"),
      field("status"),
      field("reason"),
    ]),
    renderHelp([
      "The delete request was accepted, but its outcome could not be verified - re-run the same delete command (idempotent) or run `glab-axi project view -R <project>` to check the current state",
      ...hints,
    ]),
  ]);
}

/** Render a deletion the instance deferred rather than performed. */
function renderScheduled(
  label: string,
  purgeAfter: string,
  already: boolean,
  hints: string[],
): string {
  const detail: Json = {
    project: label,
    status: "scheduled",
    purge_after: purgeAfter,
  };
  const schema = [field("project"), field("status"), field("purge_after")];
  if (already) {
    detail.already = true;
    schema.push(field("already"));
  }
  return renderOutput([
    renderDetail("deleted", detail, schema),
    renderHelp([
      "This instance defers project deletion - the project still exists, marked for deletion, and is purged on the instance's own retention schedule",
      ...hints,
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function projectCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "view":
      return projectView(ctx);
    case "list":
      return projectList(rest, ctx);
    case "create":
      return projectCreate(rest, ctx);
    case "delete":
      return projectDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return PROJECT_HELP;
    default:
      return renderError(
        `Unknown project subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi project --help` to see available subcommands"],
      );
  }
}
