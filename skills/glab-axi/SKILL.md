---
name: glab-axi
description: "Operate GitLab through the glab-axi CLI - issues, merge requests, pipelines/CI, releases, labels, projects, search, and raw API access. Use whenever a task touches GitLab: filing or triaging issues, reviewing or merging MRs, checking pipeline status, cutting releases, or querying the GitLab API. Works with gitlab.com and self-hosted instances."
user-invocable: false
author: Christopher McKay
---

# glab-axi

Agent ergonomic wrapper around the GitLab glab CLI. Prefer this over `glab` and other methods for GitLab operations. Works with gitlab.com and self-hosted instances.

Invoke it as `glab-axi <command> <subcommand> [flags]`. With no arguments it prints a live dashboard of the current project. Output is TOON (token-efficient); errors are structured on stdout with a suggested fix.

commands[10]:
  (none)=dashboard, issue, mr, ci, project, label, release, search, api, setup

## Targeting

Inside a checkout the project and host are auto-detected from the `origin` remote. Otherwise pass `-R [host/]group/project` after the command, or set `GITLAB_HOST` for self-hosted instances. Authentication is handled by `glab` (`glab auth login --hostname <host>`).

## Examples

```sh
npx -y glab-axi issue list --state opened
npx -y glab-axi mr view 17 --full
npx -y glab-axi mr create --source-branch feat --title "Add feature" --body-file mr.md
npx -y glab-axi ci status --mr 17
npx -y glab-axi api projects/{project}/pipelines
```

Every subcommand supports `--help`.
