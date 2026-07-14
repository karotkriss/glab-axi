import { glApi, glApiResult, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { takeBody } from "../body.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, getPositional } from "../args.js";
import { readStdin } from "../stdin.js";
import {
  field,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `projects/:id/repository/...` REST path. */
function repositoryPath(ctx: RepoContext | undefined, suffix: string): string {
  return `projects/${requireProject(ctx)}/repository${suffix}`;
}

const CONTENT_SUGGESTIONS = [
  'Pass --content "<text>" or --content-file <path>, or pipe it: `cat ci.yml | glab-axi repo create-file .gitlab-ci.yml`',
];

// create-file writes UTF-8 text only; GitLab's encoding=base64 (binary) upload
// is a deliberate future addition, not implemented here.
const BINARY_CONTENT_ERROR =
  "Binary content is not supported - repo create-file writes text files only";

/**
 * Resolve the file content: --content, --content-file, or piped stdin.
 * Unlike `variable set`, a trailing newline is preserved - it is part of the
 * file being written, not shell noise. --content-file and piped content are
 * validated as UTF-8 text before use: a naive lossy decode would silently
 * corrupt binary input (e.g. an image) with no error.
 */
function resolveContent(args: string[]): string {
  const body = takeBody(args, {
    inlineFlags: ["--content"],
    fileFlags: ["--content-file"],
    label: "content",
    suggestions: CONTENT_SUGGESTIONS,
    rejectBinaryMessage: BINARY_CONTENT_ERROR,
  });
  if (body !== undefined) return body;
  const piped = readStdin({
    rejectBinaryMessage: BINARY_CONTENT_ERROR,
    suggestions: CONTENT_SUGGESTIONS,
  });
  if (piped === "") {
    throw new AxiError(
      "File content is required",
      "VALIDATION_ERROR",
      CONTENT_SUGGESTIONS,
    );
  }
  return piped;
}

/**
 * The project's own default branch, used when --branch/--ref is omitted. This
 * costs one GET, but the alternative is the caller making that same lookup
 * (`project view`) before every write.
 */
async function resolveDefaultBranch(
  ctx: RepoContext | undefined,
  suggestions: string[],
): Promise<string> {
  const proj = await glApi<Json>(`projects/${requireProject(ctx)}`, { ctx });
  const branch = proj?.default_branch;
  if (!branch) {
    throw new AxiError(
      "This project has no default branch - its repository is empty",
      "VALIDATION_ERROR",
      suggestions,
    );
  }
  return branch;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const REPO_HELP = `usage: glab-axi repo <subcommand> [flags]
subcommands[2]:
  create-file <path>, create-branch <name>
flags{create-file}:
  --content <text> | --content-file <path> (or pipe the content on stdin), --branch <name> (default: the project's default branch), --message <text> (commit message; default "Add <path>")
flags{create-branch}:
  --ref <branch|commit> (branch point; default: the project's default branch)
notes:
  repo writes the project's git contents (files, branches); \`project\` addresses the project itself. Both subcommands are idempotent: an existing file or branch is a no-op (already: true), never an overwrite - to change a file's content, commit it under a new path or branch.
  create-file commits directly to --branch, and creates that branch when the repository is still empty (the one case where --branch cannot be defaulted).
  create-file writes UTF-8 text only - binary content (images, compiled assets) is rejected with an actionable error rather than silently corrupted. Base64/binary upload support is a possible future addition, not implemented here.
examples:
  glab-axi repo create-file README.md --content "# my-service"
  glab-axi repo create-file .gitlab-ci.yml --content-file ci.yml --message "Add CI config"
  glab-axi repo create-branch feature-x --ref main
  glab-axi repo create-file src/app.ts --branch feature-x --content "export const app = 1;"`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function repoCreateFile(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  requireProject(ctx);
  // Take every flag before reading the positional, so a flag's value is never
  // mistaken for the file path.
  const branchFlag = takeFlag(args, "--branch");
  const message = takeFlag(args, "--message");
  const content = resolveContent(args);
  const path = getPositional(args, 0);
  if (!path) {
    throw new AxiError("Missing file path", "VALIDATION_ERROR", [
      'glab-axi repo create-file <path> --content "<text>" [--branch <name>] [--message "<text>"]',
    ]);
  }
  const branch =
    branchFlag ??
    (await resolveDefaultBranch(ctx, [
      "Pass --branch <name> to create the repository's first branch along with this file, e.g. `--branch main`",
    ]));

  const encodedPath = encodeURIComponent(path);
  const suggestions = renderHelp(
    getSuggestions({
      domain: "repo",
      action: "create-file",
      id: path,
      branch,
      repo: ctx,
    }),
  );

  // Idempotent: GET first so a repeat create is a definitive no-op. Any other
  // failure (e.g. 403) falls through to the POST, which surfaces the real error.
  const existing = await glApiResult(
    repositoryPath(
      ctx,
      `/files/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    ),
    { ctx },
  );
  if (existing.exitCode === 0) {
    return renderOutput([
      renderDetail("file", { file: path, branch, already: true }, [
        field("file"),
        field("branch"),
        field("already"),
      ]),
      suggestions,
    ]);
  }

  const created = await glApi<Json>(
    repositoryPath(ctx, `/files/${encodedPath}`),
    {
      method: "POST",
      rawFields: [
        `branch=${branch}`,
        `content=${content}`,
        `commit_message=${message ?? `Add ${path}`}`,
      ],
      ctx,
    },
  );

  return renderOutput([
    renderDetail(
      "created",
      { file: created?.file_path ?? path, branch: created?.branch ?? branch },
      [field("file"), field("branch")],
    ),
    suggestions,
  ]);
}

async function repoCreateBranch(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  requireProject(ctx);
  const refFlag = takeFlag(args, "--ref");
  const name = getPositional(args, 0);
  if (!name) {
    throw new AxiError("Missing branch name", "VALIDATION_ERROR", [
      "glab-axi repo create-branch <name> [--ref <branch|commit>]",
    ]);
  }
  const ref =
    refFlag ??
    (await resolveDefaultBranch(ctx, [
      'Seed the repository first: `glab-axi repo create-file README.md --branch main --content "..."`',
      "Or pass --ref <branch|commit> to branch from an existing ref",
    ]));

  const suggestions = renderHelp(
    getSuggestions({
      domain: "repo",
      action: "create-branch",
      id: name,
      repo: ctx,
    }),
  );

  const existing = await glApiResult(
    repositoryPath(ctx, `/branches/${encodeURIComponent(name)}`),
    { ctx },
  );
  if (existing.exitCode === 0) {
    return renderOutput([
      renderDetail("branch", { branch: name, already: true }, [
        field("branch"),
        field("already"),
      ]),
      suggestions,
    ]);
  }

  const created = await glApi<Json>(repositoryPath(ctx, "/branches"), {
    method: "POST",
    rawFields: [`branch=${name}`, `ref=${ref}`],
    ctx,
  });

  return renderOutput([
    renderDetail(
      "created",
      {
        branch: created?.name ?? name,
        ref,
        commit: created?.commit?.short_id ?? null,
      },
      [field("branch"), field("ref"), field("commit")],
    ),
    suggestions,
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function repoCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create-file":
      return repoCreateFile(rest, ctx);
    case "create-branch":
      return repoCreateBranch(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return REPO_HELP;
    default:
      return renderError(
        `Unknown repo subcommand: ${sub}`,
        "VALIDATION_ERROR",
        ["Run `glab-axi repo --help` to see available subcommands"],
      );
  }
}
