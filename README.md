# glab-axi

An [AXI](https://agentskills.io)-compliant CLI that wraps the GitLab [`glab`](https://gitlab.com/gitlab-org/cli) CLI for autonomous agents.
It is the GitLab twin of [`gh-axi`](https://github.com/kunchenguid/gh-axi): token-efficient [TOON](https://toonformat.dev/) output, minimal default schemas, contextual next-step suggestions, idempotent mutations, and structured errors on stdout - everything an agent needs to operate GitLab from the shell without burning tokens or guessing.

## Why

Agents drive CLIs by reading stdout. Raw `glab`/REST output is verbose JSON full of fields an agent will never use, mutations error on already-satisfied state, and failures leak stack traces. `glab-axi` fixes all of that:

- **TOON, not JSON** - ~40% fewer tokens, still readable.
- **Minimal schemas** - lists default to 3-5 fields; ask for more with `--fields a,b,c`.
- **Pre-computed aggregates** - pipeline views report `checks: N passed, M failed, K running` and an at-a-glance verdict, so an agent never has to count jobs.
- **Real totals, not guesses** - list output reads GitLab's own count (`count: 30 of 847 total`) instead of restating the `--limit` it was just given.
- **Bounded, greppable CI logs** - `ci log` strips ANSI noise and truncates to a token-safe tail; a truncated trace also spills the full log to a local file the agent can grep instead of paying for it in context.
- **Idempotent mutations** - closing a closed issue or merging a merged MR is a no-op with exit 0.
- **Definitive empty states** and **contextual `help[]` suggestions** on every list and mutation.
- **Structured errors on stdout** - actionable, and they never leak the underlying tool's name.
- **Fails loud on a typo** - an unrecognized flag or subcommand exits 2 naming what was wrong and listing the valid set, rather than being dropped. A silently ignored `--stat closed` would hand back open issues at exit 0, and an agent cannot tell that from the filtered result it asked for.

## Quick Start

Install the glab-axi skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add karotkriss/glab-axi --skill glab-axi -g
```

That is the entire setup - on a clean machine there is no npm install.
The skill teaches your agent to invoke the CLI through a version-pinned `npx -y glab-axi@X.Y.Z`, so glab-axi comes along on demand and always runs the exact released version, regardless of what (or whether) anything is installed globally.
Only the unpinned `npx -y glab-axi` form - used by [Zero setup](#zero-setup) and the bare `glab-axi` command - can be shadowed by a stale global install; see [Global npm install](#global-npm-install) for the one-line check.
You still need the GitLab [`glab`](https://gitlab.com/gitlab-org/cli) CLI installed and authenticated (`glab auth login`), and Node.js 20 or newer.
For a self-hosted instance, authenticate `glab` against that host and target it with `-R <host>/group/project` or `GITLAB_HOST` (see [Targeting a project](#targeting-a-project)).

`-g` installs the skill for every project (`~/.claude/skills/`, and the equivalent directory for other agents); drop it to install into the current project only (`.claude/skills/`).
`--skill glab-axi` picks just the CLI skill: this repo also ships `glab-axi-release`, which is for maintainers cutting a release, not for using the tool.

The skill is not a user-facing slash command (`user-invocable: false`).
Just ask for anything that touches GitLab - filing an issue, reviewing a merge request, chasing a failed pipeline, cutting a release - and the agent loads the skill on its own when it recognizes the task.
It loads on demand rather than sitting in the context window, so it costs no per-session tokens, and it works in any agent that supports the skill format.

## Other ways to install

The skill is the recommended path, but it is not the only one.

### Zero setup

`glab-axi` is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Execute `npx -y glab-axi` to get GitLab tools.
```

### Global npm install

A global install gives you the `glab-axi` command directly, which is handy for running it yourself:

```sh
npm install -g glab-axi
glab-axi issue list
```

This does not affect the skill: its `npx -y glab-axi@X.Y.Z` invocations are pinned to the exact released version, so `npx` fetches that exact version regardless of what is installed globally.
It does affect anything that invokes the bare, unpinned `npx -y glab-axi` - the [Zero setup](#zero-setup) flow above, and the version check below: when a matching command is already in your global bin, `npx` runs it and never asks the registry what the current version is.
So the global copy is what an unpinned call runs, and it stays on whatever version you installed until you upgrade it yourself.
Nothing announces this - the CLI keeps working and quietly answers with old behaviour.

Compare what an unpinned `npx` call runs against what is published:

```sh
npx -y glab-axi --version   # what an unpinned npx call runs
npm view glab-axi version   # what is published
```

If those differ, upgrade the global copy in place:

```sh
npm install -g glab-axi@latest
```

Or, if you only use the skill and no [session hook](#session-hook) needs the bare `glab-axi` command, drop the global copy so nothing shadows the unpinned form either:

```sh
npm uninstall -g glab-axi
```

### Session hook

Want ambient GitLab context - the current project's open issues and merge requests - in every agent session, instead of loading on demand?
With the CLI installed globally, opt into the hook:

```sh
glab-axi setup hooks
```

That installs an idempotent `SessionStart` hook for Claude Code, Codex, and OpenCode.
Each session then opens with a compact dashboard of the current project, so the agent can act immediately with no invocation needed.
Restart your agent session afterwards so the new hook takes effect; re-running the command repairs the hook's path after a reinstall.

## Usage

Run with no arguments for a dashboard of the current project (open issues, open merge requests, suggested next commands):

```sh
glab-axi
```

If no GitLab project resolves, it prints `project: none` with a hint instead of guessing. If a request to the server fails, the affected section renders `unavailable - <reason>` rather than a false `0 open` - a real zero and "could not ask the server" are different facts.

Drill in command-first:

```sh
glab-axi issue list --state opened
glab-axi issue view 12 --comments
glab-axi issue links 12
glab-axi mr view 42 --full
glab-axi mr view 42 --reviews
glab-axi mr diff 42
glab-axi ci status --branch main
glab-axi ci log 46450 --full
```

Every response ends with `help:` hints for logical next steps. Run `glab-axi --help` for global flags, or `glab-axi <command> --help` for per-command usage.

### Commands

| Command   | What it does |
|-----------|--------------|
| (none)    | Dashboard of the current project |
| `issue`   | list / view / links / create / edit / close / reopen / comment |
| `mr`      | list / view / create / update / merge / approve / unapprove / checks / diff / comment (by IID; `view`, `checks`, and `diff` also take a full MR URL) |
| `ci`      | list / view / status / jobs / watch / log / run / retry / cancel (pipelines; `watch` blocks until a pipeline finishes and exits non-zero if it did not succeed) |
| `project` | view / list / create / delete (`delete` names its target and requires `--yes`) |
| `repo`    | create-file / create-branch (writes the project's git contents) |
| `label`   | list / create / edit / delete |
| `variable`| list / get / set / delete (plain, unmasked CI/CD variables) |
| `secret`  | list / set / delete (masked & protected CI/CD variables; `list` never reveals values) |
| `release` | list / view / create / edit / delete |
| `search`  | issues / mrs / projects |
| `api`     | raw GitLab REST passthrough with a `{project}` placeholder |
| `setup`   | install agent SessionStart hooks |

Issues and merge requests are addressed by their project-scoped **IID** (the number in the URL).

### Targeting a project

`glab-axi` is fully generic - it works against gitlab.com or any self-hosted GitLab. The target project is resolved in priority order:

1. `-R [host/]group/project` placed **after** the command (e.g. `glab-axi mr list -R gitlab.example.com/group/project`). A two-segment value is always `group/project`, even when the group name contains a dot (e.g. `firstname.lastname`, the standard username shape on LDAP/SSO instances); only a 3+-segment value can lead with a host, and then only when it's a host `glab` is already configured for or (as a last resort) contains a dot. Nested group paths are supported.
2. The `origin` git remote of the current repository.

A git remote only resolves to a project when its host is one the `glab` CLI is actually configured for, or when `GITLAB_HOST` explicitly names that host. A remote on a different forge (GitHub, Bitbucket, etc.) resolves to no project rather than a guess.

The HOST layers on top of that project resolution, in priority order: `--host <host>` placed **after** the command (an explicit selector that always wins) > `GITLAB_HOST` > the host carried by `-R`/the remote. `--host` alone (no `-R`) targets a self-hosted instance for host-level operations that have no project - `search projects`, `project list`, `api user` - without a project in scope; a project-scoped command still fails loud if no project resolved. A host-only `-R <host>` (naming a host but no group/project) is rejected with a `VALIDATION_ERROR` pointing at `--host`, rather than silently falling through to the default host.

`mr view`, `mr checks`, and `mr diff` also accept a full merge request URL in place of the IID (e.g. `glab-axi mr view https://gitlab.example.com/group/project/-/merge_requests/42`); the URL's own host/project target the request, unless an explicit `-R` flag overrides it.

`mr view --reviews` adds approval state (who approved, approvals given/required) and discussion-thread resolution counts. `mr diff` prints a bounded per-file summary (path, status, `+`/`-` line counts) by default; `--full` emits the complete reconstructed unified diff. `mr merge --auto` sets GitLab's merge-when-pipeline-succeeds: it merges immediately if there is no pipeline (or it already passed), otherwise it defers and reports the scheduled state instead of a merge commit SHA; it cannot combine with `--rebase`. When GitLab refuses a merge, the error names the specific cause (conflicts, a draft MR, unresolved discussions, missing approvals, a pipeline that hasn't passed, and so on) plus the command that clears it, instead of GitLab's opaque "Branch cannot be merged". `mr list` and `mr view` accept the same `--jq`/`--json` escape hatches as `api` (see below).

```sh
# explicit host + project
glab-axi issue list -R gitlab.example.com/group/subgroup/project

# project from the git remote, host overridden by env
GITLAB_HOST=gitlab.example.com glab-axi mr list

# host-level op on a self-hosted instance, no project involved
glab-axi search projects backend --host gitlab.example.com
```

### Projects and their repositories

`project` addresses the project entity; `repo` writes its git contents.
Together they cover a project's whole lifecycle without dropping to `api`.

```sh
# create a project, seed its default branch, and open a feature branch with a diff
glab-axi project create my-group/my-service --readme
glab-axi repo create-file .gitlab-ci.yml -R my-group/my-service --content-file ci.yml
glab-axi repo create-branch feature-x -R my-group/my-service
glab-axi repo create-file src/app.ts -R my-group/my-service --branch feature-x --content "export const app = 1;"

# tear it down again
glab-axi project delete my-group/my-service --yes
```

`repo create-file` commits a single file directly to `--branch` (defaulting to the project's default branch), creating that branch when the repository is still empty.
Content comes from `--content`, `--content-file`, or piped stdin.
`repo create-branch` branches from `--ref` (also defaulting to the default branch).
Both are idempotent: an existing file or branch is a no-op (`already: true`), never an overwrite.
`repo create-file` writes UTF-8 text only; binary content (images, compiled assets) is rejected with an actionable error rather than silently corrupted.

`project delete` is destructive, so it takes its target as an explicit positional (a numeric project id, or a `[host/]group/project` path) rather than falling back to the resolved project, and it requires `--yes` - it never prompts.
Deleting an already-absent project is a no-op (`already_absent: true`).
The reported outcome is read back from the server, not assumed: on instances with delayed project deletion enabled the project isn't purged immediately, it's renamed and marked for deletion, so the response reports `status: scheduled` plus `purge_after` instead of `status: ok` (deleting an already-scheduled project again is also a no-op, `already: true`).

### Raw API passthrough

Anything the dedicated commands do not cover, reach via `api`. The `{project}` placeholder is replaced with the resolved, URL-encoded project id:

```sh
glab-axi api projects/{project}/members
glab-axi api POST projects/{project}/labels --raw-field name=urgent --raw-field color=#d9534f
glab-axi api projects/{project}/pipelines --paginate
```

By default `api` emits TOON with noisy fields stripped. To pull a single field or feed the response to your own tooling, use `--jq` or `--raw`, which both operate on the raw, unmodified JSON:

```sh
glab-axi api projects/{project}/merge_requests/5 --jq .state          # -> opened
glab-axi api projects/{project}/merge_requests/5 --jq .sha             # head SHA
glab-axi api projects/{project} --raw | jq .default_branch
```

`--jq <expr>` applies a jq expression (raw output, like `jq -r`) and needs the `jq` binary on `PATH`; `--raw` (alias `--json`) prints the JSON response verbatim and needs nothing. When both are passed, `--jq` wins.

`mr list` and `mr view` expose the same `--jq`/`--json` flags, operating on GitLab's raw response and bypassing schema flags like `--full`/`--comments`/`--reviews`:

```sh
glab-axi mr view 42 --jq .detailed_merge_status
glab-axi mr list --state opened --jq '.[].iid'
```

## Development

```sh
npm install
npm run dev -- issue list      # run from source via tsx
npm run build                  # tsc -> dist/
npm test                       # vitest (unit tests mock the glab layer; no network)
npm run lint
npm run format:check
npm run skill:check            # fail if SKILL.md is stale
```

The skill installed by the [Quick Start](#quick-start) is generated from the CLI's own help (`npm run skill:build`), and CI fails if it has drifted - commit the regenerated file.

Architecture notes live in [`AGENTS.md`](./AGENTS.md). The short version: every shell-out goes through `src/gl.ts`, which targets GitLab via `glab api` (REST passthrough) - the host through `GITLAB_HOST`, the project through its URL-encoded path. `src/commands/mr.ts` is the reference template for the per-domain command files.

## Releasing

Every notable change is recorded under `## [Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md), following the [Keep a Changelog](https://keepachangelog.com/) convention.

Publishing is automated. When a **GitHub release is published**, [`.github/workflows/release.yml`](./.github/workflows/release.yml) builds, runs the test suite, and then runs `npm publish`. Nothing publishes on a plain push or tag - only on a published release, and only if the tests pass. The release's notes are sourced from the matching `CHANGELOG.md` section, which is the single source of truth for what shipped.

The full step-by-step (move Unreleased to a new version, bump `package.json`, tag, create the release, verify the publish) lives in the `glab-axi-release` skill under [`skills/glab-axi-release/`](./skills/glab-axi-release/SKILL.md).

Auth is [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There is **no npm token** in this repo and none is needed: the registry mints a short-lived credential from the workflow's GitHub Actions identity, which is why the job requests `id-token: write`. Provenance is signed automatically, so the workflow passes no `--provenance` flag.

> **One-time setup (required):** register the trusted publisher on npmjs.com under Packages -> `glab-axi` -> Settings -> Trusted publishing -> GitHub Actions, matching this repo exactly: organization `karotkriss` (no leading `@`), repository `glab-axi`, workflow filename `release.yml`, environment `npm-publish`. The match is exact - renaming the workflow file or changing the job's environment breaks publishing until the registration is updated. Full details are in the [`glab-axi-release` skill](./skills/glab-axi-release/SKILL.md).

### Testing the publish pipeline without publishing

The workflow has a manual `workflow_dispatch` trigger whose `dry_run` input defaults to **true**:

```sh
gh workflow run release.yml -f dry_run=true
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

(Or use the Actions tab -> Release -> Run workflow.) A dry run does the full checkout, install, build, and test, checks that the resolved Node and npm meet the trusted-publishing floors, then runs `npm publish --dry-run` to pack and validate the tarball. **It never uploads anything.** A real publish happens only when a GitHub release is published.

A dry run **does not verify auth**. `npm publish --dry-run` never contacts the registry for credentials, so it passes the same whether the trusted publisher is registered correctly or not at all. Only a real publish exercises the OIDC handshake; treat a green dry run as "it builds, tests pass, and the tarball is well-formed" and nothing more.

## License

[MIT](./LICENSE) (c) Christopher McKay
