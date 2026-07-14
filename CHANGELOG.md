# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `variable` command - list / get / set / delete for plain, unmasked CI/CD variables (values shown).
- `secret` command - list / set / delete for masked & protected CI/CD variables; `list` never reveals values.
- `issue links` - list an issue's linked issues over the Issue Links API.
- `project create [namespace/]name` - create a project over the Projects API; org-owned creates resolve the namespace, and the create is idempotent (GET-first).
- `ci watch <pipeline-id>` - block until a pipeline reaches a terminal state, print the verdict aggregate, and exit non-zero unless the pipeline succeeded.
- `mr checks <iid|url>` - merge-request pipeline verdict summary (reuses the CI aggregation).
- `mr diff <iid|url>` - bounded per-file diff summary by default; full reconstructed unified diff with `--full`.
- `mr view --reviews` - approval state plus discussion-thread resolution counts.
- `mr merge --auto` - set GitLab's merge-when-pipeline-succeeds; merges immediately when there is no pipeline or it already passed, otherwise defers and reports the scheduled state. Refuses to combine with `--rebase`.
- `mr list` / `mr view` `--json` / `--jq` escape hatches over GitLab's raw response.
- `mr view` / `mr checks` / `mr diff` accept a full merge-request URL in place of the IID.
- `mr list` head/base aliases and `mr view` head SHA + web URL.
- `api --jq <expr>` and `api --raw` (alias `--json`) - extract a field or print the raw JSON, operating on the unmodified response.
- `release create` flag parity: `--target` (alias `--ref`), `--prerelease`, and `--asset <url>[#name]`.
- npm publish automation: a GitHub Actions workflow publishes glab-axi to npm with provenance whenever a GitHub release is published (`.github/workflows/release.yml`).
- This CHANGELOG, following the Keep a Changelog convention.
- A `glab-axi-release` agent skill documenting the release process end to end.

### Changed

- `release create --draft` / `--generate-notes` refuse with a validation error (exit 2) rather than silently no-op, since GitLab has no equivalent concept.
- `project create --clone` / `--template` refuse with validation guidance (GitHub-only concepts with no clean `glab api` path).

### Fixed

- `variable get` redacts masked values; `variable` / `secret` list truncation uses the raw page size.
- `mr diff --full` emits correct rename and new/deleted-file mode headers.
- `mr view --reviews` derives `approved` when GitLab CE omits it, and handles `approvals_required = 0`.
- `mr` / `api` `--json` error mapping combines stdout and stderr.
- `release create --asset` no longer consumes the tag positional.
- glab Go unmarshal errors map to `VALIDATION_ERROR`.

## [0.1.0] - 2026-06-25

First published release.

### Added

- Core AXI CLI wrapping GitLab through the `glab api` REST passthrough - token-efficient TOON output, minimal default schemas, contextual `help[]` suggestions, idempotent mutations, and structured errors on stdout.
- Dashboard (no arguments) summarizing the current project's open issues and merge requests.
- `issue` - list / view / create / edit / close / reopen / comment (IID-addressed).
- `mr` - list / view / create / update / merge / approve / comment (IID-addressed).
- `ci` - list / view / status / jobs / log / retry over pipelines, with pre-computed pass/fail/running verdict aggregates.
- `project` - view / list.
- `label` - list / create / delete.
- `release` - list / view / create / delete over the GitLab Releases API.
- `search` - issues / mrs / projects.
- `api` - raw GitLab REST passthrough with a `{project}` placeholder, emitting noise-stripped TOON.
- `setup hooks` - idempotent `SessionStart` hooks for Claude Code, Codex, and OpenCode.
- Installable Agent Skill generated from the CLI's own help, with a CI freshness check.
- Generic host/project targeting via `-R [host/]group/project`, the `origin` git remote, or `GITLAB_HOST` (host-only override).
