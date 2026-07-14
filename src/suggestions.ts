import type { RepoContext } from "./context.js";

export interface SuggestionCtx {
  domain: string;
  action: string;
  id?: string | number;
  state?: string;
  isEmpty?: boolean;
  repo?: RepoContext;
  branch?: string;
}

/** Reconstruct a `-R` target string for carry-forward in suggestions. */
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
      "Run `glab-axi <command> <subcommand>` — commands: issue, mr, ci, project, label, variable, secret, release, search, api",
    ],
  },

  // ---- issue ----
  {
    match: (c) => c.domain === "issue" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view <iid>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} issue create --title "..." --body-file <path>\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue create --title "..." --body-file <path>\` to create an issue`,
      `Run \`glab-axi${repoFlag(c)} issue list --state closed\` to see closed issues`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "opened",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue comment ${c.id} --body-file <path>\` to comment`,
      `Run \`glab-axi${repoFlag(c)} issue close ${c.id}\` to close`,
      `Run \`glab-axi${repoFlag(c)} issue edit ${c.id} --assignee <user>\` to assign`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "closed",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue reopen ${c.id}\` to reopen`,
      `Run \`glab-axi${repoFlag(c)} issue comment ${c.id} --body-file <path>\` to comment`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "links",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view <iid>\` to view a linked issue`,
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see the source issue`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see the full issue`,
      `Run \`glab-axi${repoFlag(c)} issue edit ${c.id} --label <label>\` to label`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "close",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue reopen ${c.id}\` to reopen`,
    ],
  },
  {
    match: (c) => c.domain === "issue" && c.action === "reopen",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue close ${c.id}\` to close`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && (c.action === "edit" || c.action === "comment"),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see the issue`,
    ],
  },

  // ---- mr ----
  {
    match: (c) => c.domain === "mr" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view <iid>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} mr create --title "..." --source-branch <b>\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr create --title "..." --source-branch <b>\` to create a merge request`,
      `Run \`glab-axi${repoFlag(c)} mr list --state merged\` to see merged MRs`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "opened",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` for merge status and pipeline`,
      `Run \`glab-axi${repoFlag(c)} mr approve ${c.id}\` to approve`,
      `Run \`glab-axi${repoFlag(c)} mr merge ${c.id}\` to merge`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "merged",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` to see merge details`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "view" && c.state === "closed",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr update ${c.id} --reopen\` to reopen`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` to see the merge request`,
      `Run \`glab-axi${repoFlag(c)} ci status --mr ${c.id}\` to check its pipeline`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "merge",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` to confirm merged state`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "checks",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci status --mr ${c.id}\` for the full pipeline and jobs`,
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` for merge status and head SHA`,
    ],
  },
  {
    match: (c) => c.domain === "mr" && c.action === "diff",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --reviews\` to see approvals and thread resolution`,
      `Run \`glab-axi${repoFlag(c)} mr approve ${c.id}\` to approve`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" &&
      (c.action === "update" ||
        c.action === "approve" ||
        c.action === "comment"),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --full\` to see updated state`,
    ],
  },

  // ---- ci ----
  {
    match: (c) => c.domain === "ci" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view <id>\` to see pipeline jobs`,
      `Run \`glab-axi${repoFlag(c)} ci status --branch <b>\` for the latest pipeline on a branch`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci status --branch <b>\` to check a branch pipeline`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && (c.action === "view" || c.action === "status"),
    lines: (c) => {
      const pid = c.id ?? "<pipeline-id>";
      return [
        `Run \`glab-axi${repoFlag(c)} ci jobs ${pid}\` to list jobs`,
        `Run \`glab-axi${repoFlag(c)} ci log <job-id>\` to see a job's log`,
        `Run \`glab-axi${repoFlag(c)} ci retry ${pid}\` to retry failed jobs`,
      ];
    },
  },
  {
    match: (c) => c.domain === "ci" && c.action === "watch",
    lines: (c) => {
      const pid = c.id ?? "<pipeline-id>";
      return [
        `Run \`glab-axi${repoFlag(c)} ci view ${pid}\` to inspect the finished jobs`,
        `Run \`glab-axi${repoFlag(c)} ci log <job-id>\` to see a failed job's log`,
      ];
    },
  },
  {
    match: (c) => c.domain === "ci" && c.action === "jobs",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci log <job-id>\` to see a job's log`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "log",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci log ${c.id} --full\` for the complete trace`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "retry",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view ${c.id}\` to monitor the retried pipeline`,
    ],
  },

  // ---- project ----
  {
    match: (c) => c.domain === "project" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue list\` to see issues`,
      `Run \`glab-axi${repoFlag(c)} mr list\` to see merge requests`,
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
      `Run \`glab-axi mr list -R ${c.id}\` to see its merge requests`,
    ],
  },

  // ---- label ----
  {
    match: (c) => c.domain === "label" && c.action === "list",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label create --name "..." --color "#ed9121"\` to create a label`,
    ],
  },
  {
    match: (c) =>
      c.domain === "label" && (c.action === "create" || c.action === "delete"),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label list\` to see all labels`,
    ],
  },

  // ---- variable ----
  {
    match: (c) => c.domain === "variable" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} variable get <name>\` to see a variable's value`,
      `Run \`glab-axi${repoFlag(c)} variable set <name> --value "..."\` to set one`,
    ],
  },
  {
    match: (c) =>
      c.domain === "variable" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} variable set <name> --value "..."\` to create a variable`,
      `Run \`glab-axi${repoFlag(c)} secret list\` to see masked CI/CD variables`,
    ],
  },
  {
    match: (c) =>
      c.domain === "variable" && c.action === "get" && c.state === "masked",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} secret list\` to see masked variables (values are not shown)`,
      `Run \`glab-axi${repoFlag(c)} variable delete ${c.id}\` to delete it`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "get",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} variable set ${c.id} --value "..."\` to update it`,
      `Run \`glab-axi${repoFlag(c)} variable delete ${c.id}\` to delete it`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "set",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} variable get ${c.id}\` to confirm the value`,
      `Run \`glab-axi${repoFlag(c)} variable list\` to see all variables`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} variable list\` to see remaining variables`,
    ],
  },

  // ---- secret ----
  {
    match: (c) => c.domain === "secret" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} secret set <name> --value "..."\` to set a masked secret`,
    ],
  },
  {
    match: (c) =>
      c.domain === "secret" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} secret set <name> --value "..."\` to create a masked secret`,
      `Run \`glab-axi${repoFlag(c)} variable list\` to see plain CI/CD variables`,
    ],
  },
  {
    match: (c) => c.domain === "secret" && c.action === "set",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} secret list\` to see all secrets`,
    ],
  },
  {
    match: (c) => c.domain === "secret" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} secret list\` to see remaining secrets`,
    ],
  },

  // ---- release ----
  {
    match: (c) => c.domain === "release" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view <tag>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} release create <tag> --body-file <path>\` to create a release`,
    ],
  },
  {
    match: (c) =>
      c.domain === "release" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release create <tag> --body-file <path>\` to create a release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release delete ${c.id}\` to delete this release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view ${c.id}\` to view the release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release list\` to see remaining releases`,
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
