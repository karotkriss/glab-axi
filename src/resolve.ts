import { glApi, projectId, type Json } from "./gl.js";
import { AxiError } from "./errors.js";
import type { RepoContext } from "./context.js";

/** Resolve a username to a numeric user id via GET /users?username=. */
export async function resolveUserId(
  username: string,
  ctx?: RepoContext,
): Promise<number> {
  const users = await glApi<Json[]>(
    `users?username=${encodeURIComponent(username)}`,
    { ctx },
  );
  if (!Array.isArray(users) || users.length === 0) {
    throw new AxiError(
      `No user found with username "${username}"`,
      "NOT_FOUND",
    );
  }
  return users[0].id as number;
}

/**
 * Resolve a milestone title to a numeric milestone id via
 * GET projects/:id/milestones?title=.
 */
export async function resolveMilestoneId(
  title: string,
  ctx?: RepoContext,
): Promise<number> {
  const ms = await glApi<Json[]>(
    `projects/${projectId(ctx)}/milestones?title=${encodeURIComponent(title)}`,
    { ctx },
  );
  if (!Array.isArray(ms) || ms.length === 0) {
    throw new AxiError(
      `No milestone found with title "${title}"`,
      "NOT_FOUND",
      [`Run \`glab-axi project view\` or check the milestone title`],
    );
  }
  return ms[0].id as number;
}
