import { readFileSync } from "node:fs";
import { takeFlag } from "./args.js";
import { AxiError } from "./errors.js";

export interface TakeBodyOptions {
  inlineFlag?: string;
  fileFlag?: string;
  label?: string;
  required?: boolean;
}

/**
 * Extract a body/description from --body (inline) or --body-file (path),
 * removing the flags from args. Throws on conflicting or missing-required input.
 */
export function takeBody(
  args: string[],
  options: TakeBodyOptions = {},
): string | undefined {
  const inlineFlag = options.inlineFlag ?? "--body";
  const fileFlag = options.fileFlag ?? "--body-file";
  const label = options.label ?? "body";

  const inline = takeFlag(args, inlineFlag);
  const file = takeFlag(args, fileFlag);

  const suggestion = `Use ${inlineFlag} "..." for inline ${label}, or ${fileFlag} <path> for markdown from a file`;

  if (inline !== undefined && file !== undefined) {
    throw new AxiError(
      `provide only one of ${inlineFlag} or ${fileFlag}`,
      "VALIDATION_ERROR",
      [suggestion],
    );
  }
  if (inline !== undefined) {
    if (inline === "") {
      throw new AxiError(`${inlineFlag} requires a value`, "VALIDATION_ERROR");
    }
    return inline;
  }
  if (file !== undefined) {
    if (file === "") {
      throw new AxiError(`${fileFlag} requires a path`, "VALIDATION_ERROR");
    }
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new AxiError(
          `${fileFlag} path not found: ${file}`,
          "VALIDATION_ERROR",
        );
      }
      if (err.code === "EISDIR") {
        throw new AxiError(
          `${fileFlag} must point to a readable UTF-8 file, not a directory: ${file}`,
          "VALIDATION_ERROR",
        );
      }
      throw new AxiError(
        `could not read ${fileFlag}: ${file}`,
        "VALIDATION_ERROR",
      );
    }
  }
  if (options.required) {
    throw new AxiError(`${label} is required`, "VALIDATION_ERROR", [
      suggestion,
    ]);
  }
  return undefined;
}

/**
 * Truncate a long text body for detail views, appending a size hint and a
 * pointer to --full when content is actually cut.
 */
export function truncateBody(
  body: string | null | undefined,
  maxLen = 500,
): string {
  if (typeof body !== "string" || body === "") return "";
  if (body.length <= maxLen) return body;
  return `${body.slice(0, maxLen)}\n... (truncated, ${body.length} chars total - use --full to see complete body)`;
}
