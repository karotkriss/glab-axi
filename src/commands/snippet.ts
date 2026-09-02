import { readFileSync } from "node:fs";
import { glApi, glRaw, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { refuseSubcommand } from "../refusals.js";
import { takeFlag, takeAllFlags, takeNumber, parseLimit } from "../args.js";
import {
  field,
  custom,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// snippet: multi-file personal snippets (GitLab's /snippets API).
//
// A snippet is a small git repo of one or more files, addressed by its global
// id and scoped to a host (not a project) - so this command is host-scoped like
// `search`/`auth`, targeting via -R/--host/remote, and never requireProject's.
//
// The multi-file `files[]` array cannot be expressed with `-f`/`-F` form fields
// (a nested array), which is why create/edit send a real JSON body through
// gl.ts's raw-body mode rather than the api passthrough.
// ---------------------------------------------------------------------------

const JSON_TYPE = "application/json";

export const SNIPPET_HELP = `usage: glab-axi snippet <subcommand> [flags]
subcommands[5]:
  list, view <id> [--file <name>], create, edit <id>, delete <id>
flags{list}:
  --limit <n> (default 30)
flags{view}:
  --file <name> (print one file's raw content instead of the file list)
flags{create}:
  --title <text> (required), --file <name=@path|name=@-|name=text> (required, repeatable), --description <text>, --visibility <private|internal|public> (default private)
flags{edit,update}:
  --file <name=@path|name=@-|name=text> (create or update a file, repeatable), --delete-file <name> (remove a file, repeatable), --title <text>, --description <text>, --visibility <private|internal|public>
flags{delete}:
  (none)
notes:
  snippet addresses personal snippets by their global id and is host-scoped (-R/--host/remote select only the host), not project-scoped.
  A file source name=@path reads the file, name=@- reads stdin (only one), and name=text is literal inline content.
  edit sends the whole files[] change set in one request: an existing file is updated, a new one is created, and --delete-file removes one - so a re-sync of several files is a single atomic edit.
examples:
  glab-axi snippet list --host gitlab.example.com
  glab-axi snippet view 13 --host gitlab.example.com
  glab-axi snippet view 13 --file install.sh --host gitlab.example.com
  glab-axi snippet create --title "Installer" --file install.sh=@install.sh --file README.md="# Installer" --host gitlab.example.com
  glab-axi snippet edit 13 --file install.sh=@install.sh --delete-file old.sh --host gitlab.example.com`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("id"),
  field("title"),
  lower("visibility"),
  custom("files", (s) => (Array.isArray(s.files) ? s.files.length : 0)),
  relativeTime("updated_at", "updated"),
];

const viewSchema: FieldDef[] = [
  field("id"),
  field("title"),
  field("description"),
  lower("visibility"),
  custom("files", (s) =>
    Array.isArray(s.files)
      ? s.files.map((f: Json) => f?.path).filter(Boolean)
      : [],
  ),
  field("web_url", "url"),
];

// ---------------------------------------------------------------------------
// File-source parsing
// ---------------------------------------------------------------------------

interface FileSource {
  path: string;
  content: string;
}

/**
 * Parse a `--file name=@path | name=@- | name=text` spec into a file path and
 * its content. `@path` reads the file, `@-` reads stdin (only one such source),
 * anything else is literal inline content.
 */
function parseFileSpec(raw: string, stdinUsed: { taken: boolean }): FileSource {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new AxiError(
      `--file must be name=@path, name=@-, or name=text: ${raw}`,
      "VALIDATION_ERROR",
      ["glab-axi snippet create --title T --file config.yml=@config.yml"],
    );
  }
  const path = raw.slice(0, eq);
  const spec = raw.slice(eq + 1);
  if (spec === "@-") {
    if (stdinUsed.taken) {
      throw new AxiError(
        "Only one --file can read from stdin (@-)",
        "VALIDATION_ERROR",
      );
    }
    stdinUsed.taken = true;
    return { path, content: readStdinText() };
  }
  if (spec.startsWith("@")) {
    return { path, content: readFileText(spec.slice(1)) };
  }
  return { path, content: spec };
}

function readStdinText(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new AxiError("No data was piped on stdin for @-", "VALIDATION_ERROR");
  }
}

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "UNKNOWN";
    if (code === "ENOENT") {
      throw new AxiError(`--file path not found: ${path}`, "VALIDATION_ERROR");
    }
    throw new AxiError(
      `Could not read --file path: ${path} (${code})`,
      "VALIDATION_ERROR",
    );
  }
}

function jsonBody(payload: unknown): { content: string; contentType: string } {
  return { content: JSON.stringify(payload), contentType: JSON_TYPE };
}

function validateVisibility(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!["private", "internal", "public"].includes(v)) {
    throw new AxiError(
      "--visibility must be one of: private, internal, public",
      "VALIDATION_ERROR",
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function snippetList(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = parseLimit(takeFlag(args, "--limit"), 30);
  const snippets = await glApi<Json[]>(`snippets?per_page=${limit}`, { ctx });
  const items = snippets ?? [];
  if (items.length === 0) {
    return renderOutput([
      "snippets: 0 snippets found",
      renderHelp([
        'Run `glab-axi snippet create --title "..." --file name=@path` to create one',
      ]),
    ]);
  }
  return renderOutput([
    `count: ${items.length}`,
    renderList("snippets", items, listSchema),
    renderHelp(["Run `glab-axi snippet view <id>` to see a snippet's files"]),
  ]);
}

/** The ref a snippet's files live on, read from a file's raw_url (`/raw/<ref>/`). */
function refFromRawUrl(rawUrl: unknown): string {
  const m =
    typeof rawUrl === "string" ? rawUrl.match(/\/raw\/([^/]+)\//) : null;
  return m ? m[1] : "master";
}

async function snippetView(args: string[], ctx?: RepoContext): Promise<string> {
  const file = takeFlag(args, "--file");
  const id = takeNumber(args, "snippet");
  const snippet = await glApi<Json>(`snippets/${id}`, { ctx });

  if (file) {
    const files: Json[] = Array.isArray(snippet.files) ? snippet.files : [];
    const match = files.find((f) => f?.path === file);
    if (!match) {
      const names = files.map((f) => f?.path).filter(Boolean);
      throw new AxiError(
        `Snippet ${id} has no file named ${file}`,
        "NOT_FOUND",
        names.length
          ? [`Files in this snippet: ${names.join(", ")}`]
          : ["This snippet has no files"],
      );
    }
    const ref = refFromRawUrl(match.raw_url);
    const content = await glRaw(
      `snippets/${id}/files/${ref}/${encodeURIComponent(file)}/raw`,
      { ctx },
    );
    return renderOutput([
      renderDetail("snippet_file", { snippet: id, file, content }, [
        field("snippet"),
        field("file"),
        field("content"),
      ]),
    ]);
  }

  return renderOutput([
    renderDetail("snippet", snippet, viewSchema),
    renderHelp([
      `Run \`glab-axi snippet view ${id} --file <name>\` to read one file's content`,
      `Run \`glab-axi snippet edit ${id} --file <name>=@path\` to update a file`,
    ]),
  ]);
}

async function snippetCreate(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const title = takeFlag(args, "--title");
  const description = takeFlag(args, "--description");
  const visibility = validateVisibility(takeFlag(args, "--visibility"));
  const fileSpecs = takeAllFlags(args, "--file");
  if (!title) {
    throw new AxiError("--title is required", "VALIDATION_ERROR", [
      'glab-axi snippet create --title "..." --file name=@path',
    ]);
  }
  if (fileSpecs.length === 0) {
    throw new AxiError("At least one --file is required", "VALIDATION_ERROR", [
      "glab-axi snippet create --title T --file config.yml=@config.yml",
    ]);
  }
  const stdinUsed = { taken: false };
  const files = fileSpecs.map((s) => {
    const src = parseFileSpec(s, stdinUsed);
    return { file_path: src.path, content: src.content };
  });

  const payload: Record<string, unknown> = {
    title,
    visibility: visibility ?? "private",
    files,
  };
  if (description !== undefined) payload.description = description;

  const created = await glApi<Json>("snippets", {
    method: "POST",
    body: jsonBody(payload),
    ctx,
  });
  return renderOutput([
    renderDetail(
      "created",
      {
        id: created?.id,
        title: created?.title,
        visibility: created?.visibility,
        files: files.map((f) => f.file_path),
        url: created?.web_url ?? "",
      },
      [
        field("id"),
        field("title"),
        lower("visibility"),
        field("files"),
        field("url"),
      ],
    ),
    renderHelp([
      `Run \`glab-axi snippet view ${created?.id}\` to see the snippet`,
    ]),
  ]);
}

async function snippetEdit(args: string[], ctx?: RepoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  const description = takeFlag(args, "--description");
  const visibility = validateVisibility(takeFlag(args, "--visibility"));
  const fileSpecs = takeAllFlags(args, "--file");
  const deletions = takeAllFlags(args, "--delete-file");
  const id = takeNumber(args, "snippet");

  const hasFileChange = fileSpecs.length > 0 || deletions.length > 0;
  const hasMeta =
    title !== undefined ||
    description !== undefined ||
    visibility !== undefined;
  if (!hasFileChange && !hasMeta) {
    throw new AxiError("No changes provided", "VALIDATION_ERROR", [
      "Pass at least one of --file, --delete-file, --title, --description, --visibility",
    ]);
  }

  // GitLab's files[] update needs the right action per file (create vs update vs
  // delete), so read the current file set first. This also lets --delete-file
  // fail loudly on a file that isn't there rather than 400 opaquely.
  const current = await glApi<Json>(`snippets/${id}`, { ctx });
  const existing = new Set<string>(
    (Array.isArray(current.files) ? current.files : [])
      .map((f: Json) => f?.path)
      .filter((p: unknown): p is string => typeof p === "string"),
  );

  const stdinUsed = { taken: false };
  const files: Array<Record<string, string>> = [];
  for (const spec of fileSpecs) {
    const src = parseFileSpec(spec, stdinUsed);
    files.push({
      action: existing.has(src.path) ? "update" : "create",
      file_path: src.path,
      content: src.content,
    });
  }
  for (const name of deletions) {
    if (!existing.has(name)) {
      throw new AxiError(
        `Snippet ${id} has no file named ${name} to delete`,
        "VALIDATION_ERROR",
        existing.size
          ? [`Files in this snippet: ${[...existing].join(", ")}`]
          : [],
      );
    }
    files.push({ action: "delete", file_path: name });
  }

  const payload: Record<string, unknown> = {};
  if (title !== undefined) payload.title = title;
  if (description !== undefined) payload.description = description;
  if (visibility !== undefined) payload.visibility = visibility;
  if (files.length > 0) payload.files = files;

  const updated = await glApi<Json>(`snippets/${id}`, {
    method: "PUT",
    body: jsonBody(payload),
    ctx,
  });
  return renderOutput([
    renderDetail(
      "updated",
      {
        id: updated?.id ?? id,
        title: updated?.title,
        visibility: updated?.visibility,
        files: (Array.isArray(updated?.files) ? updated.files : [])
          .map((f: Json) => f?.path)
          .filter(Boolean),
        url: updated?.web_url ?? "",
      },
      [
        field("id"),
        field("title"),
        lower("visibility"),
        field("files"),
        field("url"),
      ],
    ),
    renderHelp([`Run \`glab-axi snippet view ${id}\` to confirm the changes`]),
  ]);
}

async function snippetDelete(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const id = takeNumber(args, "snippet");
  await glApi<Json>(`snippets/${id}`, { method: "DELETE", ctx });
  return renderOutput([
    renderDetail("deleted", { snippet: id, status: "ok" }, [
      field("snippet"),
      field("status"),
    ]),
    renderHelp(["Run `glab-axi snippet list` to see your remaining snippets"]),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function snippetCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return snippetList(rest, ctx);
    case "view":
      return snippetView(rest, ctx);
    case "create":
      return snippetCreate(rest, ctx);
    case "edit":
    case "update":
      return snippetEdit(rest, ctx);
    case "delete":
      return snippetDelete(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return SNIPPET_HELP;
    default:
      return refuseSubcommand("snippet", sub, SNIPPET_HELP);
  }
}
