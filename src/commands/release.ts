import { glApi, glApiResult, requireProject, type Json } from "../gl.js";
import { AxiError, scrubTool } from "../errors.js";
import type { RepoContext } from "../context.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { refuseSubcommand } from "../refusals.js";
import {
  takeFlag,
  takeBoolFlag,
  takeAllFlags,
  getPositional,
  parseLimit,
} from "../args.js";
import {
  field,
  pluck,
  relativeTime,
  custom,
  renderList,
  renderDetail,
  renderHelp,
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

// GitLab has no "prerelease" flag. Its nearest analogue is an "upcoming"
// release: one whose `released_at` is in the future shows as upcoming (not yet
// released) until an edit brings the date into the past. We date `--prerelease`
// far in the future so it stays upcoming until deliberately promoted, matching
// how a GitHub prerelease persists until it's marked as the full release.
const PRERELEASE_RELEASED_AT = "9999-01-01T00:00:00Z";

/**
 * Parse a `--asset` value into a GitLab release asset link.
 *
 * GitLab does not upload files as release assets the way GitHub does; it models
 * assets as links to already-hosted URLs. So an asset is given as its URL, with
 * an optional display name appended after `#` (mirroring gh's `file#label`):
 *   --asset https://host/dl/app.zip
 *   --asset https://host/dl/app.zip#App bundle
 * With no `#name`, the name is derived from the URL's last path segment.
 */
function parseAsset(raw: string): { name: string; url: string } {
  const hash = raw.indexOf("#");
  const url = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  const explicitName = hash === -1 ? "" : raw.slice(hash + 1).trim();
  if (!url) {
    throw new AxiError(`--asset requires a URL: ${raw}`, "VALIDATION_ERROR", [
      "Pass an asset link, e.g. `--asset https://host/downloads/app.zip#App bundle`",
    ]);
  }
  const name = explicitName || url.split("/").filter(Boolean).pop() || url;
  return { name, url };
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
subcommands[5]:
  list, view <tag>, create <tag>, edit <tag>, delete <tag>
flags{list}:
  --limit <n> (default 30)
flags{view}:
  --full (full release notes / description)
flags{create}:
  --name <text>, --body <text> or --body-file <path>, --target <commit|branch> (source for a new tag; alias --ref), --prerelease (mark "upcoming" via a future released_at), --asset <url>[#name] (attach an asset link, repeatable)
flags{edit}:
  --name <text>, --body <text> or --body-file <path>, --prerelease; at least one is required. A tag's ref is fixed once created, so --target/--ref do not apply.
flags{delete}:
  (none)
notes:
  GitLab's Releases API has no draft/prerelease/generate-notes concepts. --prerelease dates the release in the future so it shows as "upcoming"; assets are links to hosted URLs, not uploaded files. --draft and --generate-notes are rejected with guidance (use --prerelease or omit; supply --body/--body-file) rather than silently ignored.
  upload/download are rejected for the same reason: GitLab links release assets rather than hosting them, so attach a link with \`create --asset\` instead.
examples:
  glab-axi release list
  glab-axi release view v1.0.0 --full
  glab-axi release create v1.0.0 --name "v1.0.0" --body-file notes.md --target main
  glab-axi release create v2.0.0-rc1 --prerelease --asset https://host/dl/app.zip#App bundle
  glab-axi release edit v1.0.0 --body-file notes.md
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

/**
 * GitLab's Releases API has no draft or note-generation concept. Rather than
 * silently no-op (a silent publish of a meant-to-be-hidden release is a real
 * surprise) or emulate an approximation, refuse loudly with a usage error
 * (VALIDATION_ERROR -> exit 2) that guides the agent to the real GitLab path.
 * Both `create` and `edit` take these flags in gh-axi, so both refuse them.
 */
function refuseGitHubOnlyFlags(args: string[], verb: "create" | "edit"): void {
  if (takeBoolFlag(args, "--draft")) {
    throw new AxiError(
      `GitLab releases have no draft state - the Releases API cannot ${verb === "create" ? "create an unpublished release" : "unpublish a release"}`,
      "VALIDATION_ERROR",
      [
        `Use --prerelease to mark the release upcoming (a future released_at), or omit --draft to ${verb === "create" ? "publish immediately" : "leave it published"}`,
      ],
    );
  }
  if (takeBoolFlag(args, "--generate-notes")) {
    throw new AxiError(
      "GitLab releases have no note-generation concept - the Releases API cannot auto-generate notes",
      "VALIDATION_ERROR",
      ['Provide notes explicitly with --body "..." or --body-file <path>'],
    );
  }
}

async function releaseCreate(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  requireProject(ctx);
  refuseGitHubOnlyFlags(args, "create");
  const name = takeFlag(args, "--name");
  const body = takeBody(args);
  // `--target` mirrors gh-axi; `--ref` is the original glab-axi name. Both map
  // to GitLab's `ref` (the commit/branch a new tag is created from).
  const target = takeFlag(args, "--target");
  const refFlag = takeFlag(args, "--ref");
  const ref = target ?? refFlag;
  const prerelease = takeBoolFlag(args, "--prerelease");
  const assets = takeAllFlags(args, "--asset").map(parseAsset);
  const tag = requireTag(args);

  const rawFields = [`tag_name=${tag}`];
  if (name) rawFields.push(`name=${name}`);
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (ref) rawFields.push(`ref=${ref}`);
  if (prerelease) rawFields.push(`released_at=${PRERELEASE_RELEASED_AT}`);
  for (const asset of assets) {
    // Emit name then url per asset: GitLab's Rails param parser starts a new
    // link object when it sees a subkey (`name`) that the current one already
    // has, so paired name/url runs group into distinct links.
    rawFields.push(`assets[links][][name]=${asset.name}`);
    rawFields.push(`assets[links][][url]=${asset.url}`);
  }

  try {
    const release = await glApi<Json>(releasesPath(ctx), {
      method: "POST",
      rawFields,
      ctx,
    });
    const created: Record<string, unknown> = {
      tag: release.tag_name ?? tag,
      name: release.name ?? name ?? null,
    };
    const createdFields = [field("tag"), field("name")];
    if (prerelease) {
      created.upcoming = true;
      createdFields.push(field("upcoming"));
    }
    if (assets.length > 0) {
      created.assets = assets.length;
      createdFields.push(field("assets"));
    }
    return renderOutput([
      renderDetail("created", created, createdFields),
      renderHelp(
        getSuggestions({
          domain: "release",
          action: "create",
          id: tag,
          repo: ctx,
        }),
      ),
    ]);
  } catch (err) {
    // Idempotent: GitLab returns a 409 ("Release already exists") when a
    // release for this tag is already present. Treat it as a no-op.
    if (
      err instanceof AxiError &&
      (err.code === "CONFLICT" || /already exists/i.test(err.message))
    ) {
      return renderOutput([
        renderDetail("release", { tag, already: true }, [
          field("tag"),
          field("already"),
        ]),
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
    throw err;
  }
}

async function releaseEdit(args: string[], ctx?: RepoContext): Promise<string> {
  refuseGitHubOnlyFlags(args, "edit");
  const name = takeFlag(args, "--name");
  const body = takeBody(args);
  const prerelease = takeBoolFlag(args, "--prerelease");
  const tag = requireTag(args);
  // GitLab's PUT accepts name/description/released_at only: a tag's ref is
  // fixed once the tag exists, so --target/--ref have nothing to update here.
  if (name === undefined && body === undefined && !prerelease)
    throw new AxiError(
      "Nothing to edit - pass at least one of --name, --body/--body-file, or --prerelease",
      "VALIDATION_ERROR",
      [
        `glab-axi release edit ${tag} --body "..."`,
        `glab-axi release edit ${tag} --name "<title>"`,
      ],
    );

  const rawFields: string[] = [];
  if (name !== undefined) rawFields.push(`name=${name}`);
  if (body !== undefined) rawFields.push(`description=${body}`);
  if (prerelease) rawFields.push(`released_at=${PRERELEASE_RELEASED_AT}`);

  const release = await glApi<Json>(releasePath(ctx, tag), {
    method: "PUT",
    rawFields,
    ctx,
  });

  const updated: Record<string, unknown> = {
    tag: release.tag_name ?? tag,
    name: release.name ?? name ?? null,
  };
  const updatedFields = [field("tag"), field("name")];
  if (prerelease) {
    updated.upcoming = true;
    updatedFields.push(field("upcoming"));
  }
  return renderOutput([
    renderDetail("updated", updated, updatedFields),
    renderHelp(
      getSuggestions({ domain: "release", action: "edit", id: tag, repo: ctx }),
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
    case "edit":
    case "update":
      return releaseEdit(rest, ctx);
    case "delete":
      return releaseDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return RELEASE_HELP;
    default:
      return refuseSubcommand("release", sub);
  }
}
