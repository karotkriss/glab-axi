import { AxiError } from "./errors.js";
import { parseHelpFlags } from "./args.js";

// ---------------------------------------------------------------------------
// Deliberate refusals, at the VERB layer.
//
// glab-axi already refuses GitHub-only *flags* (--draft, --template, --clone)
// with a reason and a redirect. This is the same model applied to subcommands,
// for one reason: without it every unbuilt verb collapses to the same
// "Unknown <domain> subcommand" string, so an agent cannot tell "GitLab has no
// such concept, stop asking" from "not built yet, use `api` for now". Those are
// opposite facts and the undifferentiated error reports neither.
//
// Every entry answers both halves: WHY the verb is absent, and WHAT to run
// instead. Three kinds live here:
//   - divergence: GitLab has no such concept       -> redirect to the real model
//   - renamed:    the capability exists under another name -> name it
//   - unbuilt:    a real endpoint exists, unwritten -> hand over the `api` call
//
// A refusal is only worth shipping if its suggestion runs. Every command
// emitted below is a complete, runnable glab-axi invocation ({project} is
// expanded by `api`), not a sketch.
// ---------------------------------------------------------------------------

interface Refusal {
  /** Why this verb does not exist here. Never a bare "unknown subcommand". */
  reason: string;
  /** Complete commands that get the agent to the real path. */
  help: string[];
}

const REFUSALS: Record<string, Record<string, Refusal>> = {
  auth: {
    login: {
      reason:
        "`auth login` is not wrapped - authenticating a new host is interactive, and this tool refuses interactive prompts by design",
      help: [
        "Set GITLAB_TOKEN in the environment to supply a credential for the host non-interactively",
        "Run `glab-axi auth status --host <host>` to check whether a credential already works",
      ],
    },
    logout: {
      reason:
        "`auth logout` is not wrapped - this command never writes, rotates, or erases a credential, it only reads the one the GitLab CLI already manages",
      help: [
        "Run `glab-axi auth git-credential erase` with git's credential protocol on stdin to remove a stored credential",
        "Run `glab-axi auth status --host <host>` to check whether a credential still works",
      ],
    },
  },

  config: {
    set: {
      reason:
        "`config set` is not wrapped - this command only reads configuration, so it can never leave a machine in a state its own report does not describe",
      help: [
        "Run `glab-axi config get <key>` to read a configuration value",
        "Run `glab-axi auth status` to see the resolved binary, config file, and default host",
      ],
    },
    list: {
      reason:
        "`config list` is not wrapped - a bulk dump of the configuration file would carry the per-host token straight to stdout, which this tool never emits",
      help: [
        "Run `glab-axi config get <key>` to read one non-credential value",
        "Run `glab-axi auth status` for the hosts, their credential presence, and the config file path",
      ],
    },
  },

  issue: {
    subissue: {
      reason:
        "GitLab has no sub-issue concept - issues are related through typed links (relates_to, blocks), not a parent/child hierarchy",
      help: [
        "Run `glab-axi issue links <iid>` to see an issue's linked issues",
        'Run `glab-axi api POST "projects/{project}/issues/<iid>/links" --raw-field target_project_id=<id> --raw-field target_issue_iid=<iid>` to link two issues',
      ],
    },
    pin: {
      reason:
        "GitLab has no issue pinning - there is no pinned-issue concept to set",
      help: [
        'Run `glab-axi label create --name "pinned" --color "#ed9121"` and label the issues you want to surface',
      ],
    },
    unpin: {
      reason:
        "GitLab has no issue pinning - there is no pinned-issue concept to clear",
      help: [
        "Run `glab-axi issue list --label pinned` if you are using a label to track them",
      ],
    },
    delete: {
      reason:
        "`issue delete` is not implemented - GitLab can delete an issue, but this verb is not built yet",
      help: [
        'Run `glab-axi api DELETE "projects/{project}/issues/<iid>"` to delete it through the API passthrough',
        "Run `glab-axi issue close <iid>` if closing it is enough",
      ],
    },
    lock: {
      reason:
        "`issue lock` is not implemented - GitLab locks an issue's discussion, but this verb is not built yet",
      help: [
        'Run `glab-axi api PUT "projects/{project}/issues/<iid>" --field discussion_locked=true` to lock the discussion',
      ],
    },
    unlock: {
      reason:
        "`issue unlock` is not implemented - GitLab locks an issue's discussion, but this verb is not built yet",
      help: [
        'Run `glab-axi api PUT "projects/{project}/issues/<iid>" --field discussion_locked=false` to unlock the discussion',
      ],
    },
    transfer: {
      reason:
        "`issue transfer` is not implemented - GitLab moves an issue between projects, but this verb is not built yet",
      help: [
        'Run `glab-axi api POST "projects/{project}/issues/<iid>/move" --field to_project_id=<id>` to move it',
      ],
    },
  },

  mr: {
    review: {
      reason:
        "GitLab has no review-submission concept - a review is an approval plus discussion threads, not a single submitted verdict",
      help: [
        "Run `glab-axi mr approve <iid>` to approve, or `glab-axi mr unapprove <iid>` to withdraw approval",
        'Run `glab-axi mr comment <iid> --body "..."` to leave feedback (GitLab\'s equivalent of requesting changes)',
        "Run `glab-axi mr view <iid> --reviews` to see approvals and thread resolution",
      ],
    },
    close: {
      reason: "`mr close` is not a separate verb here - closing is an update",
      help: [
        "Run `glab-axi mr update <iid> --close` to close the merge request",
      ],
    },
    reopen: {
      reason:
        "`mr reopen` is not a separate verb here - reopening is an update",
      help: [
        "Run `glab-axi mr update <iid> --reopen` to reopen the merge request",
      ],
    },
    ready: {
      reason:
        "`mr ready` is not a separate verb here - clearing Draft status is an update",
      help: [
        "Run `glab-axi mr update <iid> --ready` to clear Draft status",
        "Run `glab-axi mr update <iid> --draft` to mark it Draft again",
      ],
    },
    checkout: {
      reason:
        "Checking out a merge request is not supported - glab-axi talks to the GitLab API and never touches your working tree",
      help: [
        "Run `glab-axi mr view <iid> --full` to read the source branch, then `git fetch` and `git checkout` it yourself",
      ],
    },
    revert: {
      reason:
        "`mr revert` is not implemented - GitLab reverts a commit rather than a merge request, and this verb is not built yet",
      help: [
        'Run `glab-axi mr view <iid> --full` to get the merge commit sha, then `glab-axi api POST "projects/{project}/commits/<sha>/revert" --raw-field branch=<branch>`',
      ],
    },
    "update-branch": {
      reason:
        "`mr update-branch` is not implemented - GitLab rebases a merge request onto its target, but this verb is not built yet",
      help: [
        'Run `glab-axi api PUT "projects/{project}/merge_requests/<iid>/rebase"` to rebase the source branch onto the target',
        "Run `glab-axi mr merge <iid> --rebase` if you are rebasing in order to merge",
      ],
    },
  },

  ci: {
    rerun: {
      reason: "`ci rerun` is not the name here - the verb is `ci retry`",
      help: ["Run `glab-axi ci retry <pipeline-id>` to retry a pipeline"],
    },
    delete: {
      reason:
        "`ci delete` is not implemented - GitLab can delete a pipeline, but this verb is not built yet",
      help: [
        'Run `glab-axi api DELETE "projects/{project}/pipelines/<pipeline-id>"` to delete a pipeline',
        "Run `glab-axi ci cancel <pipeline-id>` if you only want to stop it",
      ],
    },
    download: {
      reason:
        "`ci download` is not implemented - GitLab exposes job artifacts, but this verb is not built yet",
      help: [
        'Run `glab-axi api "projects/{project}/jobs/<job-id>/artifacts" --raw > artifacts.zip` to fetch a job\'s artifacts',
        "Run `glab-axi ci jobs <pipeline-id>` to find the job id",
      ],
    },
  },

  release: {
    upload: {
      reason:
        "GitLab does not host release assets - a release links to assets stored elsewhere, so there is nothing to upload to",
      help: [
        "Run `glab-axi release create <tag> --asset <url>#<name>` to attach an asset link at create time",
        'Run `glab-axi api POST "projects/{project}/releases/<tag>/assets/links" --raw-field name="<name>" --raw-field url="<url>"` to add a link to an existing release',
      ],
    },
    download: {
      reason:
        "GitLab does not host release assets - a release links to assets stored elsewhere, so there is nothing to download from it",
      help: [
        "Run `glab-axi release view <tag>` to see the release's asset links, then fetch them from wherever they are hosted",
      ],
    },
  },

  repo: {
    clone: {
      reason:
        "Cloning is not supported - glab-axi talks to the GitLab API and never touches your working tree",
      help: [
        "Run `glab-axi project view` to get the project's clone url, then `git clone` it yourself",
      ],
    },
    view: {
      reason:
        "`repo` writes the project's git contents - the project entity itself is addressed by `project`",
      help: ["Run `glab-axi project view` to view the project"],
    },
    list: {
      reason:
        "`repo` writes the project's git contents - the project entity itself is addressed by `project`",
      help: ["Run `glab-axi project list` to list projects"],
    },
    edit: {
      reason:
        "`repo edit` is not implemented - GitLab can update a project's settings, but this verb is not built yet",
      help: [
        'Run `glab-axi api PUT "projects/{project}" --raw-field description="..."` to update project settings',
      ],
    },
  },

  project: {
    edit: {
      reason:
        "`project edit` is not implemented - GitLab can update a project's settings, but this verb is not built yet",
      help: [
        'Run `glab-axi api PUT "projects/{project}" --raw-field description="..."` to update project settings',
      ],
    },
    clone: {
      reason:
        "Cloning is not supported - glab-axi talks to the GitLab API and never touches your working tree",
      help: [
        "Run `glab-axi project view` to get the project's clone url, then `git clone` it yourself",
      ],
    },
  },

  search: {
    code: {
      reason:
        "`search code` is not implemented - GitLab searches code through its blobs scope, but this type is not built yet",
      help: [
        'Run `glab-axi api "projects/{project}/search?scope=blobs&search=<query>"` to search this project\'s code',
        'Run `glab-axi api "search?scope=blobs&search=<query>"` to search code instance-wide',
      ],
    },
    commits: {
      reason:
        "`search commits` is not implemented - GitLab searches commits through its commits scope, but this type is not built yet",
      help: [
        'Run `glab-axi api "projects/{project}/search?scope=commits&search=<query>"` to search this project\'s commits',
      ],
    },
  },
};

/**
 * Reject an unknown subcommand: with a specific reason and redirect when the
 * verb is a known gap, else with the generic unknown-subcommand error.
 *
 * Always throws (exit 2). A usage error must not exit 0 - an agent that checks
 * the exit code would read a mistyped verb as success.
 *
 * Pass the domain's HELP text to have the generic error inline the valid
 * subcommands, or a ready-made fallback to replace the generic error outright
 * (`search` names its list "types", not subcommands).
 */
export function refuseSubcommand(
  domain: string,
  sub: string,
  helpOrFallback?: string | { message: string; help: string[] },
): never {
  const refusal = REFUSALS[domain]?.[sub];
  if (refusal) {
    throw new AxiError(refusal.reason, "VALIDATION_ERROR", refusal.help);
  }
  const isHelp = typeof helpOrFallback === "string";
  const fallback = isHelp ? undefined : helpOrFallback;
  throw new AxiError(
    fallback?.message ?? `Unknown ${domain} subcommand: ${sub}`,
    "VALIDATION_ERROR",
    fallback?.help ?? genericHelp(domain, isHelp ? helpOrFallback : undefined),
  );
}

/**
 * Inline the valid subcommands rather than pointing at `--help`.
 *
 * A pointer to `--help` costs the agent a round trip to learn what it could
 * have been told here (AXI clause 9), so the set is spelled out whenever the
 * caller hands over the help text to read it from.
 */
function genericHelp(domain: string, help?: string): string[] {
  const subs = help === undefined ? [] : [...parseHelpFlags(help).subs].sort();
  if (subs.length === 0) {
    return [`Run \`glab-axi ${domain} --help\` to see available subcommands`];
  }
  return [`Valid \`glab-axi ${domain}\` subcommands: ${subs.join(", ")}`];
}

/** The refusal table, for tests that assert every suggestion is runnable. */
export const refusalTable = REFUSALS;
