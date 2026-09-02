import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { glApi, requireProject, type Json } from "../gl.js";
import { AxiError } from "../errors.js";
import type { RepoContext } from "../context.js";
import { getPositional, takeFlag } from "../args.js";
import { field, renderDetail, renderHelp, renderOutput } from "../toon.js";

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const UPLOAD_HELP = `usage: glab-axi upload <file> [flags]
args:
  <file>  path to the file to upload, or - to read the bytes from stdin
flags{upload}:
  --name <filename> (name to store the upload under; required when reading stdin, else defaults to the file's basename)
notes:
  Uploads a file to the project (POST /projects/:id/uploads) and returns the markdown snippet that embeds it in an issue or merge request description, plus its url and alt text. The upload is binary-safe - unlike \`repo create-file\`, it handles images and other binary content. It is scoped to the resolved project (-R/--host/remote); the returned url is relative to that project.
examples:
  glab-axi upload screenshot.png
  glab-axi upload evidence.png --name failure-before.png
  cat chart.png | glab-axi upload - --name chart.png
  glab-axi upload diagram.svg -R gitlab.example.com/group/project`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Content-Type for the file part, guessed from the name's extension. */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
};

function guessContentType(filename: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * A filename safe to place inside a Content-Disposition header: quotes and
 * CR/LF would let a crafted name break out of the header (or the multipart
 * framing), so they are stripped rather than escaped.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\]/g, "").trim();
  return cleaned === "" ? "upload" : cleaned;
}

/** Assemble a single-part multipart/form-data body around the file's bytes. */
function multipartBody(
  fieldName: string,
  filename: string,
  content: Buffer,
): { content: Buffer; contentType: string } {
  const boundary = `glabaxi${randomBytes(16).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${guessContentType(filename)}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    content: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Read the upload's bytes from a path, or from stdin when the path is `-`. */
function readUploadBytes(path: string): Buffer {
  if (path === "-") {
    try {
      return readFileSync(0);
    } catch {
      throw new AxiError("No data was piped on stdin", "VALIDATION_ERROR", [
        "Pipe the file's bytes, e.g. `cat image.png | glab-axi upload - --name image.png`",
      ]);
    }
  }
  try {
    return readFileSync(path);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "UNKNOWN";
    if (code === "ENOENT") {
      throw new AxiError(`File not found: ${path}`, "VALIDATION_ERROR");
    }
    if (code === "EISDIR") {
      throw new AxiError(
        `Not a file: ${path} is a directory`,
        "VALIDATION_ERROR",
      );
    }
    throw new AxiError(`Could not read ${path} (${code})`, "VALIDATION_ERROR");
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function uploadCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    return UPLOAD_HELP;
  }
  requireProject(ctx);
  const nameFlag = takeFlag(args, "--name");
  // upload has no subcommand, so the shared rejectUnknownFlags guard (keyed on a
  // subcommand name) cannot validate its flags - do it here so an unknown flag
  // fails loudly rather than being silently ignored (AXI clause 6).
  const unknown = args.find((a) => a.startsWith("--"));
  if (unknown) {
    throw new AxiError(
      `Unknown flag for \`glab-axi upload\`: ${unknown}`,
      "VALIDATION_ERROR",
      ["The only flag is --name; the file is a positional argument"],
    );
  }
  const path = getPositional(args, 0);
  if (!path) {
    throw new AxiError("Missing file to upload", "VALIDATION_ERROR", [
      "glab-axi upload <file> [--name <filename>]",
      "Or pipe bytes: `cat image.png | glab-axi upload - --name image.png`",
    ]);
  }
  if (path === "-" && !nameFlag) {
    throw new AxiError(
      "--name is required when reading the upload from stdin",
      "VALIDATION_ERROR",
      ["cat image.png | glab-axi upload - --name image.png"],
    );
  }

  const bytes = readUploadBytes(path);
  const filename = sanitizeFilename(nameFlag ?? basename(path));
  const body = multipartBody("file", filename, bytes);

  const result = await glApi<Json>(`projects/${requireProject(ctx)}/uploads`, {
    method: "POST",
    body,
    ctx,
  });

  return renderOutput([
    renderDetail(
      "uploaded",
      {
        markdown: result?.markdown ?? "",
        url: result?.url ?? result?.full_path ?? "",
        alt: result?.alt ?? "",
      },
      [field("markdown"), field("url"), field("alt")],
    ),
    renderHelp([
      "Paste the markdown into an issue or merge request body to embed the file",
      "The url is relative to the project - GitLab resolves it in that project's context",
    ]),
  ]);
}
