---
name: glab-axi-release
description: "Cut a glab-axi release: move the CHANGELOG Unreleased section to a new version, bump package.json, tag, create the GitHub release (which publishes to npm), and verify the publish landed. Use when releasing glab-axi, publishing a new glab-axi version to npm, or preparing a glab-axi release."
user-invocable: true
author: Christopher McKay
---

# glab-axi-release

Cut a glab-axi release end to end. Publishing to npm is automated: creating a
GitHub release fires `.github/workflows/release.yml`, which builds, runs the
test suite, and then runs `npm publish --provenance`. The release notes come
from the CHANGELOG section for the version - that section is the single
source of truth for the notes.

## One-time setup (maintainer)

The publish job runs in a GitHub Actions **Environment named exactly
`npm-publish`** and reads `NPM_TOKEN` as an **environment secret** on it - not a
repository secret. Both pieces are required:

1. **Create the environment.** GitHub -> Settings -> Environments -> New
   environment, named `npm-publish`. The name must match the `environment:`
   value in `.github/workflows/release.yml` exactly; if it does not,
   `${{ secrets.NPM_TOKEN }}` resolves to an empty string and publishing fails.
2. **Add the secret to that environment.** On the `npm-publish` environment's
   page -> Environment secrets -> Add secret, named `NPM_TOKEN`, holding an npm
   automation token with publish rights.

Without both, every release run fails at the publish step. Do not commit the
token anywhere.

## Test the pipeline without publishing (dry run)

Verify the environment secret and the whole publish path before cutting the
first real release. The workflow's `workflow_dispatch` trigger has a `dry_run`
input that defaults to **true**:

```sh
gh workflow run release.yml -f dry_run=true
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

A dry run does the full checkout, install, build, and test, then runs
`npm whoami` (confirming the environment secret authenticates - it prints the
npm username, never the token) and `npm publish --dry-run` (packs and validates
the tarball). **Nothing is uploaded.** A green dry run means the environment,
the secret, and the publish pipeline are all wired correctly.

If it fails at `npm whoami`, the `npm-publish` environment or its `NPM_TOKEN`
secret is missing, misnamed, or the token is expired (see one-time setup).

## Cut a release

Pick the new version `X.Y.Z` by semver against what is under `## [Unreleased]`
in `CHANGELOG.md`. Run from a clean checkout of the default branch.

1. **Update the CHANGELOG.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   (today's date), add a fresh empty `## [Unreleased]` above it, and add the
   reference links at the bottom of the file (create the block if the file
   has none yet):

   ```
   [Unreleased]: https://github.com/karotkriss/glab-axi/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/karotkriss/glab-axi/releases/tag/vX.Y.Z
   ```

   (If a reference-link block already exists from an earlier release, keep
   its older `[...]` link lines.) Drop any empty Added/Changed/Fixed
   subheadings from the new section.

2. **Bump the version** in `package.json` (this also updates `package-lock.json`):

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

3. **Commit** the two version files and the changelog:

   ```sh
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "release: vX.Y.Z"
   ```

   This commit lands on the default branch through the repo's normal review flow.
   Tag only after it is on the branch you release from.

4. **Tag and push:**

   ```sh
   git tag vX.Y.Z
   git push origin HEAD
   git push origin vX.Y.Z
   ```

5. **Create the GitHub release** with notes extracted from the CHANGELOG section
   for this version. This publishes the release, which triggers the npm publish
   workflow:

   ```sh
   VERSION=X.Y.Z
   awk -v v="$VERSION" '
     $0 ~ "^## \\[" v "\\]" { grab = 1; next }
     grab && /^## \[/ { exit }
     grab && /^\[[^]]+\]:/ { exit }
     grab { print }
   ' CHANGELOG.md | gh release create "v$VERSION" --title "v$VERSION" --notes-file -
   ```

   The `awk` prints exactly the lines between `## [X.Y.Z]` and the next version
   heading (or the reference-link block), so the release body mirrors the
   CHANGELOG section verbatim.

6. **Verify the publish landed.** The workflow run should be green:

   ```sh
   gh run list --workflow=release.yml --limit 1
   ```

   And npm must show the new version (may take a minute to propagate):

   ```sh
   npm view glab-axi version   # -> X.Y.Z
   ```

   If the run failed at the build or test step, that's an unrelated code issue
   to fix and re-release, not an `NPM_TOKEN` problem. If it got past those and
   failed at the publish step, the usual cause is the `npm-publish` environment
   or its `NPM_TOKEN` environment secret being missing, misnamed, or expired
   (see one-time setup above); a dry run diagnoses that without burning a
   version.

## Notes

- A real `npm publish` happens **only** on `release: published`, never on push
  or tag alone - pushing the tag in step 4 does not publish; creating the
  release does. The manual `workflow_dispatch` trigger cannot publish for real:
  its dry-run path only packs the tarball, and with `dry_run` disabled it is
  just a build/test smoke run.
- `--provenance` needs the workflow's `id-token: write` permission (already set)
  and the `repository` field in `package.json` to match the GitHub repo.
- npm rejects republishing an already-published version, so never reuse `X.Y.Z`.
