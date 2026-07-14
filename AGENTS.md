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

- `src/gl.ts` - the only place that shells out. Targets GitLab through `glab api <path>` (REST passthrough), never per-subcommand flags. `glApi` (parsed JSON), `glRaw` (raw text, e.g. job traces), `glApiResult` (no-throw, for idempotent delete). Host is targeted via the `GITLAB_HOST` env var; the project is addressed by its URL-encoded path inside the REST path (`projects/<encoded>/...`).
- **Never pass `-R` to `glab api`** - it rejects `-R`, and this previously broke `api` and `ci log` under `-R` targeting. The host goes through the env, the project through the path.
- `src/context.ts` - `resolveRepo`: priority `--repo` flag > git remote origin. `GITLAB_HOST` only OVERRIDES the host; by itself it does not select a project. `-R` accepts `[host/]group/project`; a first segment containing a dot is treated as the host. Nested group paths are supported.
- `src/commands/*.ts` - one file per domain (issue, mr, ci, project, label, release, search, api, home, setup). `mr.ts` is the reference template.
- `mr view`/`mr checks` accept a full MR URL in place of the IID; the URL's own host/project target the request (precedence: `-R` flag > URL > git remote), tagged `source: "flag"` so it flows through to help suggestions like an explicit `-R`.
- `mr checks` reuses `ci.ts`'s exported `resolveMrPipeline`/`fetchJobs`/`renderSummary` rather than reimplementing verdict bucketing - intentional cross-command reuse.
- `ci watch <pipeline-id>` polls until the pipeline is terminal, then prints the same verdict aggregate as `ci status`. Terminal detection lists the ACTIVE statuses and treats everything else as terminal, so an unknown GitLab status can't spin the loop forever; polling is bounded by poll count (`timeout / interval`), not wall-clock.
- `ci watch`'s exit code follows the pipeline's own status, not the job verdict (a canceled pipeline with passing jobs still exits non-zero): success -> 0, anything else -> `process.exitCode = 1`, since throwing an `AxiError` would replace the verdict output on stdout. The delay goes through `src/sleep.ts` so tests can mock it away instead of waiting real seconds.
- IID-addressed: issues and merge requests use their project-scoped IID (the number in the URL), not the global id.
- `glab` field flags are inverted from `gh`: `-F`/`--field` = typed, `-f`/`--raw-field` = raw string. In `GlApiOptions`, `fields` -> `-F` (ids/booleans), `rawFields` -> `-f` (user text: titles, bodies, labels).

## Conventions

- ESM NodeNext: all local imports use the `.js` extension.
- Validation errors `throw new AxiError(...)` (the harness renders them); router unknown-subcommand returns `renderError(...)`.
- Numeric flags go through `parseLimit()` (raw `parseInt` yields `NaN` -> `per_page=NaN`).
- Mutations are idempotent: GET current state first; if already in the target state, return a no-op (exit 0). Delete-on-404 is a no-op.
- Structured errors must never leak the wrapped CLI's name - `scrubTool()` in `src/errors.ts` strips it; "GitLab" (the product) is fine.

## Targeting a self-hosted instance

The tool is fully generic. Point it at any self-hosted GitLab with `GITLAB_HOST=<host>` (or `-R <host>/group/project`, or a git remote on that host). Do not hardcode any host anywhere.
