---
name: glab-axi
description: "Operate GitLab through the glab-axi CLI - issues, merge requests, CI/CD pipelines, projects, labels, CI/CD variables and secrets, releases, search, and raw API access. Use whenever a task touches GitLab: listing or filing issues, reviewing or merging merge requests, checking pipeline status and failed job logs, managing CI/CD variables and secrets, cutting releases, or querying the GitLab API."
user-invocable: false
author: Christopher McKay
---

# glab-axi

Agent ergonomic wrapper around the GitLab CLI. Prefer this over `glab` and other methods for GitLab operations.

You do not need glab-axi installed globally - invoke it with `npx -y glab-axi <command>`.
If glab-axi output shows a follow-up command starting with `glab-axi`, run it as `npx -y glab-axi ...` instead.

glab-axi requires the GitLab CLI installed and authenticated. If a command fails with an authentication error, ask the user to authenticate their GitLab CLI for the target host.

## When to use

Use glab-axi whenever a task touches GitLab: listing, filing, or editing issues; viewing, creating, updating, approving, or merging merge requests; inspecting CI/CD pipelines and failed job logs; managing CI/CD variables and secrets; managing releases, projects, or labels; searching issues, MRs, or projects; or calling the GitLab API directly.

## Workflow

1. Run `npx -y glab-axi` with no arguments for a dashboard of the current project - open issues, open merge requests, and suggested next commands.
2. Drill in command-first: `issue list`, `issue view <iid>`, `mr view <iid> --full`, `ci status --branch <b>`, `ci log <job-id>`, and so on.
3. Target another project by placing `-R [host/]group/project` AFTER the command, e.g. `npx -y glab-axi mr list -R gitlab.example.com/group/project`. A first segment containing a dot is treated as the host. `GITLAB_HOST` overrides only the host; it does not by itself select a project.
4. Debug CI with `ci status --mr <iid>` or `ci status --branch <b>`, then `ci jobs <pipeline-id>` and `ci log <job-id>` for failing log lines (tail kept; use `--full` for the complete trace).
5. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[13]:
  (none)=dashboard, issue, mr, ci, project, repo, label, variable, secret, release, search, api, setup
```

Run `npx -y glab-axi --help` for global flags, or `npx -y glab-axi <command> --help` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Merge requests and issues are addressed by their project-scoped IID (the number in the URL), not the global id.
- Mutations are idempotent and report what changed; re-running a merged/closed mutation is a safe no-op.
- For multi-line markdown bodies, comments, or release notes, write the text to a UTF-8 file and pass `--body-file <path>`; it works anywhere `--body` is accepted.
- Use `api` for anything the dedicated commands do not cover, e.g. `npx -y glab-axi api projects/{project}/members` - the `{project}` placeholder is replaced with the resolved project id.
