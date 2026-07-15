import type { RepoContext } from "./context.js";

export interface SuggestionCtx {
  domain: string;
  action: string;
  id?: string | number;
  state?: string;
  isEmpty?: boolean;
  repo?: RepoContext;
  branch?: string;
  /** Path a large payload was spilled to, when one was written. */
  logFile?: string;
  /** Chars rendered, and the total available, for a truncated payload. */
  shown?: number;
  total?: number;
}

/**
 * Reconstruct a `-R` target string for carry-forward in suggestions.
 *
 * Append this at the END of a suggested command, never straight after the
 * binary name: `-R` must follow the command word, and the pre-command form
 * (`glab-axi -R host/group/project issue list`) is rejected by our own parser.
 * A suggestion that errors is worse than no suggestion at all.
 */
export function repoFlag(c: SuggestionCtx): string {
  const r = c.repo;
  if (r && r.source === "flag") {
    const target = r.host ? `${r.host}/${r.project}` : r.project;
    return ` -R ${target}`;
  }
  return "";
}

interface Entry {
  match: (c: SuggestionCtx) => boolean;
  lines: (c: SuggestionCtx) => string[];
}

const table: Entry[] = [
  // ---- home ----
  {
    match: (c) => c.domain === "home",
    lines: () => [
      "Run `glab-axi <command> <subcommand>` — commands: issue, mr, ci, project, repo, label, variable, secret, release, search, api",
    ],
  },

  // ---- issue ----
  {
    match: (c) => c.domain === "issue" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi issue view <iid>${repoFlag(c)}\` to view details`,
      `Run \`glab-axi issue create --title "..." --body-file <path>${repoFlag(c)}\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi issue create --title "..." --body-file <path>${repoFlag(c)}\` to create an issue`,
      `Run \`glab-axi issue list --state closed${repoFlag(c)}\` to see closed issues`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "opened",
    lines: (c) => [
      `Run \`glab-axi issue comment ${c.id} --body-file <path>${repoFlag(c)}\` to comment`,
      `Run \`glab-axi issue close ${c.id}${repoFlag(c)}\` to close`,
      `Run \`glab-axi issue edit ${c.id} --assignee <user>${repoFlag(c)}\` to assign`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "closed",
    lines: (c) => [
      `Run \`glab-axi issue reopen ${c.id}${repoFlag(c)}\` to reopen`,
      `Run \`glab-axi issue comment ${c.id} --body-file <path>${repoFlag(c)}\` to comment`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "links",
    lines: (c) => [
      `Run \`glab-axi issue view <iid>${repoFlag(c)}\` to view a linked issue`,
      `Run \`glab-axi issue view ${c.id}${repoFlag(c)}\` to see the source issue`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi issue view ${c.id}${repoFlag(c)}\` to see the full issue`,
      `Run \`glab-axi issue edit ${c.id} --label <label>${repoFlag(c)}\` to label`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "close",
    lines: (c) => [
      `Run \`glab-axi issue reopen ${c.id}${repoFlag(c)}\` to reopen`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "reopen",
    lines: (c) => [
      `Run \`glab-axi issue close ${c.id}${repoFlag(c)}\` to close`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && (c.action === "edit" || c.action === "comment"),
    lines: (c) => [
      `Run \`glab-axi issue view ${c.id}${repoFlag(c)}\` to see the issue`,
    ],
  },

  // ---- mr ----
  {
    match: (c) => c.domain === "mr" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi mr view <iid>${repoFlag(c)}\` to view details`,
      `Run \`glab-axi mr create --title "..." --source-branch <b>${repoFlag(c)}\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi mr create --title "..." --source-branch <b>${repoFlag(c)}\` to create a merge request`,
      `Run \`glab-axi mr list --state merged${repoFlag(c)}\` to see merged MRs`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "opened",
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` for merge status and pipeline`,
      `Run \`glab-axi mr approve ${c.id}${repoFlag(c)}\` to approve`,
      `Run \`glab-axi mr merge ${c.id}${repoFlag(c)}\` to merge`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "merged",
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` to see merge details`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "closed",
    lines: (c) => [
      `Run \`glab-axi mr update ${c.id} --reopen${repoFlag(c)}\` to reopen`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` to see the merge request`,
      `Run \`glab-axi ci status --mr ${c.id}${repoFlag(c)}\` to check its pipeline`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "merge",
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` to confirm merged state`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "checks",
    lines: (c) => [
      `Run \`glab-axi ci status --mr ${c.id}${repoFlag(c)}\` for the full pipeline and jobs`,
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` for merge status and head SHA`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "diff",
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --reviews${repoFlag(c)}\` to see approvals and thread resolution`,
      `Run \`glab-axi mr approve ${c.id}${repoFlag(c)}\` to approve`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" &&
      (c.action === "update" ||
        c.action === "approve" ||
        c.action === "unapprove" ||
        c.action === "comment"),
    lines: (c) => [
      `Run \`glab-axi mr view ${c.id} --full${repoFlag(c)}\` to see updated state`,
    ],
  },

  // ---- ci ----
  {
    match: (c) => c.domain === "ci" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi ci view <id>${repoFlag(c)}\` to see pipeline jobs`,
      `Run \`glab-axi ci status --branch <b>${repoFlag(c)}\` for the latest pipeline on a branch`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi ci status --branch <b>${repoFlag(c)}\` to check a branch pipeline`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && (c.action === "view" || c.action === "status"),
    lines: (c) => {
      const pid = c.id ?? "<pipeline-id>";
      return [
        `Run \`glab-axi ci jobs ${pid}${repoFlag(c)}\` to list jobs`,
        `Run \`glab-axi ci log <job-id>${repoFlag(c)}\` to see a job's log`,
        `Run \`glab-axi ci retry ${pid}${repoFlag(c)}\` to retry failed jobs`,
      ];
    },
  },
  {
    match: (c) => c.domain === "ci" && c.action === "watch",
    lines: (c) => {
      const pid = c.id ?? "<pipeline-id>";
      return [
        `Run \`glab-axi ci view ${pid}${repoFlag(c)}\` to inspect the finished jobs`,
        `Run \`glab-axi ci log <job-id>${repoFlag(c)}\` to see a failed job's log`,
      ];
    },
  },
  {
    match: (c) => c.domain === "ci" && c.action === "jobs",
    lines: (c) => [
      `Run \`glab-axi ci log <job-id>${repoFlag(c)}\` to see a job's log`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "log",
    lines: (c) => {
      const lines: string[] = [];
      // Grepping the spill file is the cheap escape, so lead with it: `--full`
      // pays for the whole trace in context to answer the same question.
      if (c.logFile) {
        lines.push(
          `Output shows the last ${c.shown} of ${c.total} chars; full log saved to ${c.logFile} - grep it for earlier context`,
        );
      }
      lines.push(
        `Run \`glab-axi ci log ${c.id} --full${repoFlag(c)}\` for the complete trace`,
      );
      return lines;
    },
  },
  {
    match: (c) => c.domain === "ci" && c.action === "retry",
    lines: (c) => [
      `Run \`glab-axi ci view ${c.id}${repoFlag(c)}\` to monitor the retried pipeline`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "run",
    lines: (c) => [
      `Run \`glab-axi ci watch ${c.id}${repoFlag(c)}\` to block until the pipeline finishes`,
      `Run \`glab-axi ci jobs ${c.id}${repoFlag(c)}\` to see its jobs`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "cancel",
    lines: (c) => [
      `Run \`glab-axi ci retry ${c.id}${repoFlag(c)}\` to start it again`,
    ],
  },

  // ---- project ----
  {
    match: (c) => c.domain === "project" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi issue list${repoFlag(c)}\` to see issues`,
      `Run \`glab-axi mr list${repoFlag(c)}\` to see merge requests`,
    ],
  },
  {
    match: (c) => c.domain === "project" && c.action === "list",
    lines: () => [
      `Run \`glab-axi project view -R [host/]group/project\` to view a project`,
    ],
  },
  {
    match: (c) => c.domain === "project" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi project view -R ${c.id}\` to view the new project`,
      `Run \`glab-axi repo create-file README.md -R ${c.id} --content "..."\` to seed its repository`,
    ],
  },
  {
    match: (c) => c.domain === "project" && c.action === "delete",
    // No -R carry-forward: it would name the project that no longer exists.
    lines: () => ["Run `glab-axi project list` to see your remaining projects"],
  },

  // ---- repo ----
  {
    match: (c) => c.domain === "repo" && c.action === "create-file",
    lines: (c) => [
      `Run \`glab-axi repo create-branch <name> --ref ${c.branch}${repoFlag(c)}\` to branch from this commit`,
      `Run \`glab-axi ci list --ref ${c.branch}${repoFlag(c)}\` to see the pipeline it triggered`,
    ],
  },
  {
    match: (c) => c.domain === "repo" && c.action === "create-branch",
    lines: (c) => [
      `Run \`glab-axi repo create-file <path> --branch ${c.id} --content "..."${repoFlag(c)}\` to add a file to it`,
      `Run \`glab-axi mr create --source-branch ${c.id} --title "..."${repoFlag(c)}\` to open a merge request`,
    ],
  },

  // ---- label ----
  {
    match: (c) => c.domain === "label" && c.action === "list",
    lines: (c) => [
      `Run \`glab-axi label create --name "..." --color "#ed9121"${repoFlag(c)}\` to create a label`,
    ],
  },
  {
    match: (c) =>
      c.domain === "label" &&
      (c.action === "create" || c.action === "edit" || c.action === "delete"),
    lines: (c) => [
      `Run \`glab-axi label list${repoFlag(c)}\` to see all labels`,
    ],
  },

  // ---- variable ----
  {
    match: (c) => c.domain === "variable" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi variable get <name>${repoFlag(c)}\` to see a variable's value`,
      `Run \`glab-axi variable set <name> --value "..."${repoFlag(c)}\` to set one`,
    ],
  },
  {
    match: (c) =>
      c.domain === "variable" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi variable set <name> --value "..."${repoFlag(c)}\` to create a variable`,
      `Run \`glab-axi secret list${repoFlag(c)}\` to see masked CI/CD variables`,
    ],
  },
  {
    match: (c) =>
      c.domain === "variable" && c.action === "get" && c.state === "masked",
    lines: (c) => [
      `Run \`glab-axi secret list${repoFlag(c)}\` to see masked variables (values are not shown)`,
      `Run \`glab-axi variable delete ${c.id}${repoFlag(c)}\` to delete it`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "get",
    lines: (c) => [
      `Run \`glab-axi variable set ${c.id} --value "..."${repoFlag(c)}\` to update it`,
      `Run \`glab-axi variable delete ${c.id}${repoFlag(c)}\` to delete it`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "set",
    lines: (c) => [
      `Run \`glab-axi variable get ${c.id}${repoFlag(c)}\` to confirm the value`,
      `Run \`glab-axi variable list${repoFlag(c)}\` to see all variables`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi variable list${repoFlag(c)}\` to see remaining variables`,
    ],
  },

  // ---- secret ----
  {
    match: (c) => c.domain === "secret" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi secret set <name> --value "..."${repoFlag(c)}\` to set a masked secret`,
    ],
  },
  {
    match: (c) =>
      c.domain === "secret" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi secret set <name> --value "..."${repoFlag(c)}\` to create a masked secret`,
      `Run \`glab-axi variable list${repoFlag(c)}\` to see plain CI/CD variables`,
    ],
  },
  {
    match: (c) => c.domain === "secret" && c.action === "set",
    lines: (c) => [
      `Run \`glab-axi secret list${repoFlag(c)}\` to see all secrets`,
    ],
  },
  {
    match: (c) => c.domain === "secret" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi secret list${repoFlag(c)}\` to see remaining secrets`,
    ],
  },

  // ---- release ----
  {
    match: (c) => c.domain === "release" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi release view <tag>${repoFlag(c)}\` to view details`,
      `Run \`glab-axi release create <tag> --body-file <path>${repoFlag(c)}\` to create a release`,
    ],
  },
  {
    match: (c) =>
      c.domain === "release" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi release create <tag> --body-file <path>${repoFlag(c)}\` to create a release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi release delete ${c.id}${repoFlag(c)}\` to delete this release`,
    ],
  },
  {
    match: (c) =>
      c.domain === "release" && (c.action === "create" || c.action === "edit"),
    lines: (c) => [
      `Run \`glab-axi release view ${c.id}${repoFlag(c)}\` to view the release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi release list${repoFlag(c)}\` to see remaining releases`,
    ],
  },

  // ---- search / api ----
  { match: (c) => c.domain === "search", lines: () => [] },
  { match: (c) => c.domain === "api", lines: () => [] },
];

export function getSuggestions(ctx: SuggestionCtx): string[] {
  for (const entry of table) {
    if (entry.match(ctx)) {
      return entry.lines(ctx);
    }
  }
  return [];
}
