import { glApi, glApiResult, requireProject, type Json } from "../gl.js";
import { AxiError, scrubTool } from "../errors.js";
import type { RepoContext } from "../context.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, takeBoolFlag, getPositional, parseLimit } from "../args.js";
import {
  field,
  pluck,
  relativeTime,
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

/** Pull the release tag positional (e.g. "v1.0.0"), or throw if missing. */
function requireTag(args: string[]): string {
  const tag = getPositional(args, 0);
  if (!tag) {
    throw new AxiError("Missing release tag", "VALIDATION_ERROR", [
      "Pass the release tag, e.g. `glab-axi release view v1.0.0`",
    ]);
  }
  return tag;
}

function releasesPath(ctx: RepoContext | undefined, suffix = ""): string {
  return `projects/${requireProject(ctx)}/releases${suffix}`;
}

function releasePath(ctx: RepoContext | undefined, tag: string): string {
  return releasesPath(ctx, `/${encodeURIComponent(tag)}`);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("tag_name", "tag"),
  field("name"),
  relativeTime("released_at", "released"),
  pluck("author", "username", "author"),
];

function viewSchema(full: boolean): FieldDef[] {
  return [
    field("tag_name", "tag"),
    field("name"),
    pluck("author", "username", "author"),
    relativeTime("released_at", "released"),
    custom("assets", (r) => r.assets?.count ?? 0),
    custom("body", (r) =>
      full
        ? typeof r.description === "string"
          ? r.description
          : ""
        : truncateBody(r.description, 500),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const RELEASE_HELP = `usage: glab-axi release <subcommand> [flags]
subcommands[4]:
  list, view <tag>, create <tag>, delete <tag>
flags{list}:
  --limit <n> (default 30)
flags{view}:
  --full (full release notes / description)
flags{create}:
  --name <text>, --body <text> or --body-file <path>, --ref <commit|branch> (source for a new tag)
flags{delete}:
  (none)
examples:
  glab-axi release list
  glab-axi release view v1.0.0 --full
  glab-axi release create v1.0.0 --name "v1.0.0" --body-file notes.md --ref main
  glab-axi release delete v1.0.0`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function releaseList(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 30);

  const params = new URLSearchParams();
  params.set("per_page", String(limit));

  const items =
    (await glApi<Json[]>(`${releasesPath(ctx)}?${params.toString()}`, {
      ctx,
    })) ?? [];
  const isEmpty = items.length === 0;
  const countLine = formatCountLine({ count: items.length, limit });

  if (isEmpty) {
    return renderOutput([
      "releases: 0 releases found",
      renderHelp(
        getSuggestions({
          domain: "release",
          action: "list",
          isEmpty,
          repo: ctx,
        }),
      ),
    ]);
  }
  return renderOutput([
    countLine,
    renderList("releases", items, listSchema),
    renderHelp(
      getSuggestions({ domain: "release", action: "list", isEmpty, repo: ctx }),
    ),
  ]);
}

async function releaseView(args: string[], ctx?: RepoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const tag = requireTag(args);
  const release = await glApi<Json>(releasePath(ctx, tag), { ctx });

  return renderOutput([
    renderDetail("release", release, viewSchema(full)),
    renderHelp(
      getSuggestions({ domain: "release", action: "view", id: tag, repo: ctx }),
    ),
  ]);
}

async function releaseCreate(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  requireProject(ctx);
  const name = takeFlag(args, "--name");
  const body = takeBody(args);
  const ref = takeFlag(args, "--ref");
  const tag = requireTag(args);

  const rawFields = [`tag_name=${tag}`];
  if (name) rawFields.push(`name=${name}`);
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (ref) rawFields.push(`ref=${ref}`);

  const release = await glApi<Json>(releasesPath(ctx), {
    method: "POST",
    rawFields,
    ctx,
  });
  return renderOutput([
    renderDetail(
      "created",
      { tag: release.tag_name ?? tag, name: release.name ?? name ?? null },
      [field("tag"), field("name")],
    ),
    renderHelp(
      getSuggestions({
        domain: "release",
        action: "create",
        id: tag,
        repo: ctx,
      }),
    ),
  ]);
}

async function releaseDelete(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const tag = requireTag(args);

  // Idempotent: GET first. A missing release returns 404 on GET (whereas DELETE
  // on a missing release can return an ambiguous 403), so this is the reliable
  // way to make a repeat delete a no-op.
  const existing = await glApiResult(releasePath(ctx, tag), { ctx });
  if (existing.exitCode !== 0) {
    const text = `${existing.stderr} ${existing.stdout}`;
    if (/404|not found/i.test(text)) {
      return renderOutput([
        renderDetail("release", { tag, already_absent: true }, [
          field("tag"),
          field("already_absent"),
        ]),
        renderHelp(
          getSuggestions({
            domain: "release",
            action: "delete",
            id: tag,
            repo: ctx,
          }),
        ),
      ]);
    }
    throw new AxiError(
      scrubTool(existing.stderr || existing.stdout) ||
        "Failed to look up release",
      "UNKNOWN",
    );
  }

  const result = await glApiResult(releasePath(ctx, tag), {
    method: "DELETE",
    ctx,
  });
  if (result.exitCode !== 0) {
    throw new AxiError(
      scrubTool(result.stderr || result.stdout) || "Failed to delete release",
      "UNKNOWN",
    );
  }

  return renderOutput([
    renderDetail("deleted", { tag, status: "ok" }, [
      field("tag"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({
        domain: "release",
        action: "delete",
        id: tag,
        repo: ctx,
      }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function releaseCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return releaseList(rest, ctx);
    case "view":
      return releaseView(rest, ctx);
    case "create":
      return releaseCreate(rest, ctx);
    case "delete":
      return releaseDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return RELEASE_HELP;
    default:
      return renderError(
        `Unknown release subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi release --help` to see available subcommands"],
      );
  }
}
