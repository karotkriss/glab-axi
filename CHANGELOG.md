# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Deliberate refusals now cover verbs, not just flags: an unbuilt or GitLab-incompatible subcommand explains why and redirects to the real command, instead of a generic "Unknown `<domain>` subcommand".
- `label edit <name>` - rename a label.
- `release edit <tag>` - update a release.
- `ci cancel <pipeline-id>` - cancel a running pipeline; a no-op if it already finished.
- `ci run` - trigger a pipeline on a ref.
- `mr unapprove <iid>` - withdraw approval from a merge request.

### Changed

- The README now leads with the agent skill install (`npx skills add karotkriss/glab-axi --skill glab-axi -g`) in a new Quick Start section, since that - not the npm CLI install - is how an agent actually gets glab-axi. The npm install, the zero-setup `npx -y glab-axi` form, and the `setup hooks` SessionStart hook are still documented, now under "Other ways to install".
- npm publishing now authenticates with npm Trusted Publishing (OIDC) instead of a long-lived `NPM_TOKEN` secret. The registry mints a short-lived credential from the release workflow's GitHub Actions identity, so no npm token is stored in the repo and none needs to be rotated. Maintainers register the trusted publisher once on npmjs.com against this repo, the `release.yml` filename, and the `npm-publish` environment; see the `glab-axi-release` skill.
- The release workflow pins Node 24 and asserts the resolved Node and npm against the trusted-publishing floors (Node >= 22.14.0, npm >= 11.5.1) before it reaches the publish step. No Node 22 release bundles an npm that new, so Node 24 is the lowest line that clears both without an extra upgrade step. This is the CI publisher's floor only and does not change the Node range the package supports for its users.
- The release workflow no longer passes `--provenance`; trusted publishing generates and signs provenance by default from GitHub Actions. Published packages keep their provenance attestation.

### Fixed

- The `workflow_dispatch` dry run no longer claims to verify npm auth. It asserted that `npm whoami` proved "the token and the publish pipeline are wired correctly", but `whoami` needs no one-time password, so it passed green while the v0.2.0 publish failed with `EOTP`. `npm publish --dry-run` never contacts the registry for credentials and cannot verify auth at all, so the dry run now reports only what it actually checks: install, build, test, and a packed and validated tarball.
- Added the CHANGELOG reference-link definitions that the release skill's step 1 requires, omitted during the 0.2.0 release prep.
- `-R [host/]group/project` no longer rejects a namespace containing a dot. It previously decided the host by looking for a dot in the first segment, so a two-segment value like `firstname.lastname/project` (the standard username shape on LDAP/SSO GitLab instances) had its namespace mistaken for a hostname and failed to resolve. Disambiguation is now by segment count and known hosts: a two-segment value is always `group/project`; only a 3+-segment value can lead with a host, and then only when it's a host `glab` is already configured for (`src/hosts.ts`) or, as a last resort, contains a dot.
- Every `-R`-flag suggestion in `help[]` output now emits a runnable command. `repoFlag()` previously returned `-R <target>` interpolated right after the binary name (e.g. `glab-axi -R host/group/project issue list`), which the CLI's own parser rejects since flags must come after the command. Suggestions now place `-R` at the end of the command.
- An unknown or refused subcommand exited 0; it now exits 2, so a mistyped verb no longer reads as success to a caller checking the exit code.
- `variable set` / `secret set` reported `updated` for a write that changed nothing. An unchanged value now skips the write and reports `already: true`.

## [0.2.0] - 2026-07-15

### Added

- `variable` command - list / get / set / delete for plain, unmasked CI/CD variables (values shown).
- `secret` command - list / set / delete for masked & protected CI/CD variables; `list` never reveals values.
- `issue links` - list an issue's linked issues over the Issue Links API.
- `project create [namespace/]name` - create a project over the Projects API; org-owned creates resolve the namespace, and the create is idempotent (GET-first).
- `project delete <id|[host/]group/project>` - delete a project over the Projects API. Names its target explicitly rather than falling back to the resolved project, requires `--yes`/`-y` (it never prompts), and is idempotent (an absent project is `already_absent`).
- `repo` command - `create-file` and `create-branch`, writing a project's git contents over the Repository Files and Branches APIs. Content comes from `--content`, `--content-file`, or piped stdin; `--branch`/`--ref` default to the project's default branch; both subcommands are idempotent (an existing file or branch is a no-op). `create-file` writes UTF-8 text only - binary content from `--content-file` or piped stdin is rejected with an actionable error instead of being silently corrupted.
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
- npm publish automation: a GitHub Actions workflow publishes glab-axi to npm with provenance whenever a GitHub release is published (`.github/workflows/release.yml`). It runs in the `npm-publish` Actions environment, reading `NPM_TOKEN` as an environment secret, and offers a manual `workflow_dispatch` dry run that validates the tarball and the secret without uploading.
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
- `project delete --yes -y` no longer leaves one alias unconsumed and misread as the project positional.
- An over-large `--content`/`--value` (`repo create-file`, `variable set`, `secret set`, and any other command passing user text through `glab api`) now surfaces an actionable error naming the OS argument-size limit instead of an opaque failure.

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

[Unreleased]: https://github.com/karotkriss/glab-axi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/karotkriss/glab-axi/releases/tag/v0.2.0
[0.1.0]: https://github.com/karotkriss/glab-axi/releases/tag/v0.1.0
