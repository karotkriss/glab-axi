# glab-axi

An [AXI](https://agentskills.io)-compliant CLI that wraps the GitLab [`glab`](https://gitlab.com/gitlab-org/cli) CLI for autonomous agents.
It is the GitLab twin of [`gh-axi`](https://github.com/kunchenguid/gh-axi): token-efficient [TOON](https://toonformat.dev/) output, minimal default schemas, contextual next-step suggestions, idempotent mutations, and structured errors on stdout - everything an agent needs to operate GitLab from the shell without burning tokens or guessing.

## Why

Agents drive CLIs by reading stdout. Raw `glab`/REST output is verbose JSON full of fields an agent will never use, mutations error on already-satisfied state, and failures leak stack traces. `glab-axi` fixes all of that:

- **TOON, not JSON** - ~40% fewer tokens, still readable.
- **Minimal schemas** - lists default to 3-5 fields; ask for more with `--fields a,b,c`.
- **Pre-computed aggregates** - pipeline views report `checks: N passed, M failed, K running` and an at-a-glance verdict, so an agent never has to count jobs.
- **Idempotent mutations** - closing a closed issue or merging a merged MR is a no-op with exit 0.
- **Definitive empty states** and **contextual `help[]` suggestions** on every list and mutation.
- **Structured errors on stdout** - actionable, and they never leak the underlying tool's name.

## Requirements

- Node.js >= 20
- The GitLab [`glab`](https://gitlab.com/gitlab-org/cli) CLI, installed and authenticated (`glab auth login`). `glab-axi` shells out to it.

## Install

```sh
npm install -g glab-axi
```

Or run it without installing:

```sh
npx -y glab-axi issue list
```

## Usage

Run with no arguments for a dashboard of the current project (open issues, open merge requests, suggested next commands):

```sh
glab-axi
```

Drill in command-first:

```sh
glab-axi issue list --state opened
glab-axi issue view 12 --comments
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
| `issue`   | list / view / create / edit / close / reopen / comment |
| `mr`      | list / view / create / update / merge / approve / checks / diff / comment (by IID; `view`, `checks`, and `diff` also take a full MR URL) |
| `ci`      | list / view / status / jobs / watch / log / retry (pipelines; `watch` blocks until a pipeline finishes and exits non-zero if it did not succeed) |
| `project` | view / list |
| `label`   | list / create / delete |
| `variable`| list / get / set / delete (plain, unmasked CI/CD variables) |
| `secret`  | list / set / delete (masked & protected CI/CD variables; `list` never reveals values) |
| `release` | list / view / create / delete |
| `search`  | issues / mrs / projects |
| `api`     | raw GitLab REST passthrough with a `{project}` placeholder |
| `setup`   | install agent SessionStart hooks |

Issues and merge requests are addressed by their project-scoped **IID** (the number in the URL).

### Targeting a project

`glab-axi` is fully generic - it works against gitlab.com or any self-hosted GitLab. The target project is resolved in priority order:

1. `-R [host/]group/project` placed **after** the command (e.g. `glab-axi mr list -R gitlab.example.com/group/project`). A first path segment containing a dot is treated as the host. Nested group paths are supported.
2. The `origin` git remote of the current repository.

`GITLAB_HOST` **overrides only the host** of an already-resolved project; on its own it does not select a project (there is no namespace to infer from a bare hostname).

`mr view`, `mr checks`, and `mr diff` also accept a full merge request URL in place of the IID (e.g. `glab-axi mr view https://gitlab.example.com/group/project/-/merge_requests/42`); the URL's own host/project target the request, unless an explicit `-R` flag overrides it.

`mr view --reviews` adds approval state (who approved, approvals given/required) and discussion-thread resolution counts. `mr diff` prints a bounded per-file summary (path, status, `+`/`-` line counts) by default; `--full` emits the complete reconstructed unified diff. `mr merge --auto` sets GitLab's merge-when-pipeline-succeeds: it merges immediately if there is no pipeline (or it already passed), otherwise it defers and reports the scheduled state instead of a merge commit SHA; it cannot combine with `--rebase`. `mr list` and `mr view` accept the same `--jq`/`--json` escape hatches as `api` (see below).

```sh
# explicit host + project
glab-axi issue list -R gitlab.example.com/group/subgroup/project

# project from the git remote, host overridden by env
GITLAB_HOST=gitlab.example.com glab-axi mr list
```

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

## Ambient context for agents (two ways - pick one or both)

These are complementary; you only need one.

### 1. Session hook (recommended)

```sh
glab-axi setup hooks
```

Installs an idempotent `SessionStart` hook for Claude Code, Codex, and OpenCode. At the start of each session your agent sees a compact dashboard of the current project's open issues and merge requests, so it can act immediately - no invocation needed. Re-running repairs the hook's path after a reinstall.

### 2. Installable skill

```sh
npx skills add karotkriss/glab-axi --skill glab-axi
```

A static [Agent Skill](https://agentskills.io) that loads on demand when the agent recognizes a GitLab task. No per-session token cost; works in any agent that supports the skill format. The skill is generated from the CLI's own help (`npm run skill:build`), and CI fails if it drifts.

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

Architecture notes live in [`AGENTS.md`](./AGENTS.md). The short version: every shell-out goes through `src/gl.ts`, which targets GitLab via `glab api` (REST passthrough) - the host through `GITLAB_HOST`, the project through its URL-encoded path. `src/commands/mr.ts` is the reference template for the per-domain command files.

## License

[MIT](./LICENSE) (c) Christopher McKay
