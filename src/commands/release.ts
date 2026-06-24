import { glApi, projectId } from "../gl.js";
import type { RepoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { hasFlag, getFlag, getPositional } from "../args.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { repoFlag } from "../suggestions.js";
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
  type Def,
} from "../toon.js";

export const RELEASE_HELP = `usage: glab-axi release <subcommand> [flags]
subcommands:
  list, view <tag>, create <tag>, delete <tag>
flags{list}:
  --limit <n> (default 20)
flags{view}:
  --full (untruncated release notes)
flags{create}:
  --name <text>, --notes <text> or --notes-file <path>, --ref <commit/branch>
examples:
  glab-axi release list
  glab-axi release view v1.2.0
  glab-axi release create v1.2.0 --name "1.2.0" --notes-file CHANGELOG.md
notes:
  Releases are addressed by tag name (a string, not a number). 'release delete'
  is idempotent: deleting an absent tag is a no-op.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const listSchema: Def[] = [
  field("tag_name", "tag"),
  field("name"),
  relativeTime("released_at", "released_at"),
  pluck("author", "username", "author"),
];

const viewSchema: Def[] = [
  field("tag_name", "tag"),
  field("name"),
  pluck("author", "username", "author"),
  pluck("commit", "short_id", "commit"),
  relativeTime("released_at", "released_at"),
  relativeTime("created_at", "created"),
  custom("url", (r: Json) => r._links?.self ?? null),
  custom("description", (r: Json) => truncateBody(r.description, 1000)),
];

const viewSchemaFull: Def[] = viewSchema.map((d) =>
  d.type === "custom" && d.as === "description"
    ? custom("description", (r: Json) =>
        typeof r.description === "string" ? r.description : "",
      )
    : d,
);

const createdSchema: Def[] = [
  field("tag_name", "tag"),
  field("name"),
  custom("url", (r: Json) => r._links?.self ?? null),
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

async function listReleases(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const limit = parseInt(getFlag(args, "--limit") ?? "20", 10);

  const items = await glApi<Json[]>(
    `projects/${projectId(repo)}/releases?per_page=${limit}`,
    { ctx: repo },
  );
  const isEmpty = items.length === 0;
  const blocks = [
    formatCountLine({ count: items.length, limit }),
    renderList("releases", items, listSchema),
  ];
  const help = isEmpty
    ? [
        `Run \`glab-axi${repoFlag(repo)} release create <tag> --name "..."\` to publish a release`,
      ]
    : [`Run \`glab-axi${repoFlag(repo)} release view <tag>\` for details`];
  blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

async function viewRelease(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const tag = getPositional(args, 1);
  if (!tag) throw new AxiError("release tag is required", "VALIDATION_ERROR");
  const full = hasFlag(args, "--full");

  const release = await glApi<Json>(
    `projects/${projectId(repo)}/releases/${encodeURIComponent(tag)}`,
    { ctx: repo },
  );
  return renderOutput([
    renderDetail("release", release, full ? viewSchemaFull : viewSchema),
  ]);
}

async function createRelease(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const tag = getPositional(args, 1);
  if (!tag) throw new AxiError("release tag is required", "VALIDATION_ERROR");
  const name = getFlag(args, "--name");
  const ref = getFlag(args, "--ref");
  const notes = takeBody(args, {
    inlineFlag: "--notes",
    fileFlag: "--notes-file",
    label: "release notes",
  });

  const fields: Record<string, string> = { tag_name: tag };
  if (name) fields["name"] = name;
  if (notes !== undefined) fields["description"] = notes;
  if (ref) fields["ref"] = ref;

  const release = await glApi<Json>(`projects/${projectId(repo)}/releases`, {
    method: "POST",
    fields,
    ctx: repo,
  });
  return renderOutput([
    renderDetail("created", release, createdSchema),
    renderHelp([
      `Run \`glab-axi${repoFlag(repo)} release view ${tag}\` to see the full release`,
    ]),
  ]);
}

async function deleteRelease(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const repo = requireCtx(ctx);
  const tag = getPositional(args, 1);
  if (!tag) throw new AxiError("release tag is required", "VALIDATION_ERROR");

  const path = `projects/${projectId(repo)}/releases/${encodeURIComponent(tag)}`;
  // Idempotent: a missing tag is treated as already-deleted.
  try {
    await glApi<Json>(path, { method: "DELETE", ctx: repo });
  } catch (e) {
    if (e instanceof AxiError && e.code === "NOT_FOUND") {
      return renderOutput([
        renderDetail("deleted", { tag_name: tag, status: "already deleted" }, [
          field("tag_name", "tag"),
          field("status"),
        ]),
      ]);
    }
    throw e;
  }
  return renderOutput([
    renderDetail("deleted", { tag_name: tag, status: "ok" }, [
      field("tag_name", "tag"),
      field("status"),
    ]),
  ]);
}

export async function releaseCommand(
  args: string[],
  ctx: RepoContext | undefined,
): Promise<string> {
  const sub = args[0];
  if (!sub || hasFlag(args, "--help")) return renderOutput([RELEASE_HELP]);
  switch (sub) {
    case "list":
      return listReleases(args, ctx);
    case "view":
      return viewRelease(args, ctx);
    case "create":
      return createRelease(args, ctx);
    case "delete":
      return deleteRelease(args, ctx);
    default:
      return renderError(
        `unknown release subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi release --help` for usage"],
      );
  }
}
