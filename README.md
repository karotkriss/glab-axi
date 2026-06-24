# glab-axi

An [AXI](https://axi.md)-compliant wrapper around the GitLab [`glab`](https://gitlab.com/gitlab-org/cli) CLI, built for autonomous agents.

`glab-axi` gives an agent a token-efficient, ergonomic interface to GitLab.
It emits [TOON](https://toonformat.dev) instead of JSON (~40% fewer tokens), defaults to minimal schemas, pre-computes the counts and statuses an agent needs next, makes mutations idempotent, and surfaces contextual next-step suggestions.
It is the GitLab counterpart to [`gh-axi`](https://github.com/kunchenguid/gh-axi).

It works with **gitlab.com and self-hosted instances** - the target host is resolved from the git remote, an `-R host/group/project` flag, or the `GITLAB_HOST` environment variable, and it reuses `glab`'s own authentication.

## Why

Agents driving GitLab through raw `glab` or an MCP server pay for verbose JSON and burn extra turns re-querying for counts and statuses.
AXI tools answer the agent's likely next question inline and shrink the payload, which measurably improves success rate, cost, and turn count.
See the [AXI principles](https://axi.md) for the full rationale.

## Install

```sh
npm install -g glab-axi
```

Requires Node.js >= 20 and the `glab` CLI installed and authenticated:

```sh
glab auth login --hostname gitlab.com
# or, for a self-hosted instance:
glab auth login --hostname gitlab.example.com
```

## Usage

Running with no arguments prints a live dashboard of the current project (open issues and merge requests), not a help manual:

```sh
glab-axi
```

Commands follow a `glab-axi <command> <subcommand> [flags]` shape:

```sh
glab-axi issue list --state opened --label bug
glab-axi issue view 42 --comments
glab-axi mr list --source-branch feature-x
glab-axi mr view 17 --full
glab-axi mr create --source-branch feat --title "Add feature" --body-file mr.md
glab-axi mr merge 17 --method squash --remove-source-branch
glab-axi ci status --mr 17
glab-axi ci log 67890 --full
glab-axi release create v1.2.0 --notes-file CHANGELOG.md
glab-axi api projects/{project}/pipelines
```

### Targeting a project and host

Inside a checkout, the project and host are auto-detected from the `origin` remote.
Otherwise, target explicitly:

```sh
glab-axi mr list -R group/subgroup/project              # host from GITLAB_HOST or glab default
glab-axi mr list -R gitlab.example.com/group/project    # host prefix for self-hosted
GITLAB_HOST=gitlab.example.com glab-axi mr list -R group/project
```

## Commands

- `issue` - list / view / create / edit / close / reopen / comment
- `mr` - list / view / create / update / merge / approve / comment (merge requests, by IID)
- `ci` - list / view / status / jobs / log / retry (pipelines and jobs)
- `project` - view / list
- `label` - list / create / delete
- `release` - list / view / create / delete
- `search` - issues / mrs / projects
- `api` - raw GitLab REST API pass-through (`{project}` placeholder supported)
- `setup hooks` - install ambient session context for agents

Every subcommand supports `--help`.

## Ambient context for agents

`glab-axi setup hooks` installs a `SessionStart` hook so agents (Claude Code, Codex, OpenCode) receive the project dashboard automatically at the start of each session.
The hook is idempotent and self-repairing.

There is also an installable Agent Skill that loads on demand:

```sh
npx skills add karotkriss/glab-axi --skill glab-axi
```

You only need one of the two - the hook gives live ambient state, the skill is lower overhead and broader in agent support.

## Output format

Output is [TOON](https://toonformat.dev) on stdout.
Errors are also structured on stdout (never raw `glab` output), with an actionable suggestion.
Progress and diagnostics go to stderr.
Exit codes: `0` success (including idempotent no-ops), `1` error, `2` usage error.

## License

MIT - see [LICENSE](./LICENSE).
