# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

`glab-axi` is an AXI-compliant CLI that wraps the GitLab `glab` CLI for autonomous agents. It mirrors `gh-axi`'s architecture: token-efficient TOON output, minimal default schemas, contextual `help[]` suggestions, idempotent mutations, and structured errors on stdout. TypeScript/ESM, Node >= 20.

## Build / test / validate

- `npm run build` - `tsc` to `dist/`.
- `npm test` - vitest (unit tests mock `src/gl.ts`; no network).
- `npm run lint` - eslint. `npm run format:check` - prettier.
- `npm run skill:build` - regenerate `skills/glab-axi/SKILL.md` from the CLI's description + top-level help. `npm run skill:check` - fail if it has drifted (wired into CI; commit the regenerated file).
- `npm run dev -- <args>` - run the CLI from source via tsx.

## Architecture

- `src/gl.ts` - the only place that shells out. Targets GitLab through `glab api <path>` (REST passthrough), never per-subcommand flags. `glApi` (parsed JSON), `glRaw` (raw text, e.g. job traces), `glApiResult` (no-throw, for idempotent delete). Host is targeted via the `GITLAB_HOST` env var; the project is addressed by its URL-encoded path inside the REST path (`projects/<encoded>/...`). One non-`glab` exception lives here: `runJq` pipes JSON through the system `jq` binary, backing `api --jq` (a missing binary returns `stderr === "ENOENT"`). A large `-f`/`-F` value (e.g. `repo create-file --content-file` on a big file) can blow the OS argv limit; `run()` maps the resulting spawn-time `E2BIG` to a `VALIDATION_ERROR` (`argumentTooLargeError()` in `src/errors.ts`) the same way it maps `ENOENT`, rather than surfacing an opaque `UNKNOWN`.
- `api --jq <expr>` / `--raw` (alias `--json`) are opt-in escape hatches that operate on the RAW response (not the noise-stripped TOON view): `--jq` runs `jq -r`, `--raw` prints the JSON verbatim. Bare `api <path>` still emits stripped TOON. The `--jq`/`--json` plumbing is shared in `src/machine.ts` (`takeMachineFlags`, `applyJq`, `renderMachine`) and reused by `mr list`/`mr view` - both emit the raw GitLab response and bypass their schema flags (`--full`/`--comments`/etc.) when `--json`/`--jq` is set.
- **Never pass `-R` to `glab api`** - it rejects `-R`, and this previously broke `api` and `ci log` under `-R` targeting. The host goes through the env, the project through the path.
- `src/context.ts` - `resolveRepo`: priority `--repo` flag > git remote origin. `GITLAB_HOST` only OVERRIDES the host; by itself it does not select a project. `-R` accepts `[host/]group/project`; a first segment containing a dot is treated as the host. Nested group paths are supported.
- `src/commands/*.ts` - one file per domain (issue, mr, ci, project, repo, label, variable, secret, release, search, api, home, setup). `mr.ts` is the reference template.
- `variable` and `secret` are two views onto GitLab's single CI/CD Variables API (`projects/:id/variables`). `variable` = plain (unmasked) variables (list/get/set/delete, values shown); `secret` = masked+protected variables (list/set/delete, `list` never renders the value). The `list` commands partition by the `masked` flag so the two surfaces never overlap. `secret.ts` reuses the shared core exported by `variable.ts` (`variablesPath`, `upsertVariable`, `deleteVariable`, `resolveValue`) - intentional cross-command reuse. `set` is an upsert (GET-first: PUT if the key exists at that env scope, else POST). Keys are addressed per environment scope via `?filter[environment_scope]=<scope>` (default `*`), and the value comes from `--value` or piped stdin (`src/stdin.ts`).
- `mr view`/`mr checks`/`mr diff` accept a full MR URL in place of the IID; the URL's own host/project target the request (precedence: `-R` flag > URL > git remote), tagged `source: "flag"` so it flows through to help suggestions like an explicit `-R`.
- `mr checks` reuses `ci.ts`'s exported `resolveMrPipeline`/`fetchJobs`/`renderSummary` rather than reimplementing verdict bucketing - intentional cross-command reuse.
- `mr diff` uses the MR `/changes` endpoint (single call; its `overflow` flag marks a server-truncated diff on huge MRs), not the paginated `/diffs`. Default is a bounded per-file summary (path, status, `+`/`-` counts derived by counting hunk lines); `--full` reconstructs the `diff --git`/`---`/`+++` headers GitLab omits, since each `changes[].diff` is only the hunk body (starts at `@@`).
- `mr view --reviews` folds `/approvals` + `/discussions` into a review summary: it derives the `approved` bool when GitLab CE omits it (`given >= approvals_required`), and counts only *resolvable* threads (plain comments are excluded from the resolved/unresolved totals).
- `mr merge --auto` (gh-axi `pr merge --auto` parity) sets `merge_when_pipeline_succeeds=true`; GitLab merges immediately when there is no pipeline / it already passed (state `merged`, rendered as `merged`) else defers (state stays `opened`, rendered as `auto_merge: enabled`). It refuses to combine with `--rebase` (auto-merge can't rebase) and skips the eager rebase-poll path.
- `ci watch <pipeline-id>` polls until the pipeline is terminal, then prints the same verdict aggregate as `ci status`. Terminal detection lists the ACTIVE statuses and treats everything else as terminal, so an unknown GitLab status can't spin the loop forever; polling is bounded by poll count (`timeout / interval`), not wall-clock.
- `ci watch`'s exit code follows the pipeline's own status, not the job verdict (a canceled pipeline with passing jobs still exits non-zero): success -> 0, anything else -> `process.exitCode = 1`, since throwing an `AxiError` would replace the verdict output on stdout. The delay goes through `src/sleep.ts` so tests can mock it away instead of waiting real seconds.
- `release create` mirrors gh-axi's flags onto the GitLab Releases API, which lacks direct equivalents for some (see `release --help` notes + `src/commands/release.ts` for the authoritative mapping): `--target` aliases `--ref` -> `ref`; `--prerelease` -> a far-future `released_at` (GitLab renders it "upcoming"); `--asset <url>[#name]` -> `assets[links][]` (links to hosted URLs, not file uploads; emit name-then-url per asset so Rails groups the pairs). `--draft`/`--generate-notes` have no GitLab concept and refuse with a `VALIDATION_ERROR` (exit 2) rather than silently no-op - a decided product call, not a stub.
- `project create [namespace/]name` is the one project subcommand that does NOT `requireProject` - it creates a new project via `POST /projects`, using `ctx` only for host targeting. An org-owned create resolves the leading namespace to `namespace_id` via `GET /namespaces/<path>` (the create API takes the integer id, never a path). Idempotency is GET-first (not catch-the-conflict like label/release): GitLab's "has already been taken" is an object-valued 400 whose message the `glab` unmarshal quirk masks to a generic string (see `src/errors.ts`), so the message-regex approach can't detect it - a GET on the target path can. `--clone`/`--template` are gh concepts with no clean `glab api` path and refuse with `VALIDATION_ERROR` guidance; visibility defaults to `private`.
- `project` vs `repo`: `project` addresses the GitLab project entity (`/projects/:id`), `repo` writes its git contents (`/projects/:id/repository/*` - `create-file`, `create-branch`). The split mirrors GitLab's own API namespaces and keeps the two-level `<domain> <subcommand>` shape; new repository-write surfaces (commits, tags) belong in `repo.ts`. `repo`'s `--branch`/`--ref` default to the project's default branch via one `GET /projects/:id` (`resolveDefaultBranch`), which errors actionably on an empty repository - the one case a branch must be named.
- `project delete` takes its target as a required positional (numeric id or `[host/]group/project`) and deliberately does NOT fall back to the resolved `ctx` project, so it cannot delete the project the agent happens to be standing in. It is the only destructive-confirmation command: `--yes`/`-y` is required and it never prompts (AXI forbids interactive prompts), so the pattern to copy for any future destructive command lives in `src/commands/project.ts`.
- IID-addressed: issues and merge requests use their project-scoped IID (the number in the URL), not the global id.
- `glab` field flags are inverted from `gh`: `-F`/`--field` = typed, `-f`/`--raw-field` = raw string. In `GlApiOptions`, `fields` -> `-F` (ids/booleans), `rawFields` -> `-f` (user text: titles, bodies, labels).

## Conventions

- ESM NodeNext: all local imports use the `.js` extension.
- Validation errors `throw new AxiError(...)` (the harness renders them); router unknown-subcommand returns `renderError(...)`.
- Numeric flags go through `parseLimit()` (raw `parseInt` yields `NaN` -> `per_page=NaN`).
- Mutations are idempotent: GET current state first; if already in the target state, return a no-op (exit 0). Delete-on-404 is a no-op.
- Structured errors must never leak the wrapped CLI's name - `scrubTool()` in `src/errors.ts` strips it; "GitLab" (the product) is fine.

## Releasing

- Every change adds an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format). That section is the single source of truth for a version's GitHub release notes.
- Publishing is automated: `.github/workflows/release.yml` builds, runs the test suite, then runs `npm publish --provenance` on `release: [published]` only (not on push/tag). The publish job declares `environment: npm-publish`, so auth is `NPM_TOKEN` as an ENVIRONMENT secret on an Actions environment named exactly `npm-publish` (maintainer creates both once) - a job without a matching `environment:` resolves `secrets.NPM_TOKEN` to empty and fails.
- The same workflow has a `workflow_dispatch` trigger with a `dry_run` input (default true) that verifies the environment secret and publish path without uploading (`npm whoami` + `npm publish --dry-run`). Dispatch can never publish for real; only the `release` event reaches `npm publish --provenance`.
- The end-to-end cut-a-release procedure (CHANGELOG move, version bump file list, tag, `gh release create` with notes extracted from the CHANGELOG section, verify via `npm view glab-axi version`) lives in the `glab-axi-release` skill (`skills/glab-axi-release/SKILL.md`) - follow it rather than reinventing the steps.

## Targeting a self-hosted instance

The tool is fully generic. Point it at any self-hosted GitLab with `GITLAB_HOST=<host>` (or `-R <host>/group/project`, or a git remote on that host). Do not hardcode any host anywhere.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
