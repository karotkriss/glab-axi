import type { RepoContext } from "./context.js";

/**
 * Render the disambiguating -R flag to carry forward into a suggested command,
 * but only when the context did not come from the cwd git remote (in which case
 * the next invocation auto-detects it too).
 */
export function repoFlag(ctx?: RepoContext): string {
  if (ctx && ctx.source !== "git") {
    const target = ctx.host ? `${ctx.host}/${ctx.project}` : ctx.project;
    return ` -R ${target}`;
  }
  return "";
}

/** A short, human-readable label for the resolved project (for headers). */
export function projectLabel(ctx?: RepoContext): string | undefined {
  if (!ctx) return undefined;
  return ctx.host ? `${ctx.host}/${ctx.project}` : ctx.project;
}
