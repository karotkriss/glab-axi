---
name: glab-axi-release
description: "Cut a glab-axi release: move the CHANGELOG Unreleased section to a new version, bump package.json, tag, create the GitHub release (which publishes to npm), and verify the publish landed. Use when releasing glab-axi, publishing a new glab-axi version to npm, or preparing a glab-axi release."
user-invocable: true
author: Christopher McKay
---

# glab-axi-release

Cut a glab-axi release end to end. Publishing to npm is automated: creating a
GitHub release fires `.github/workflows/release.yml`, which runs
`npm publish --provenance`. The release notes come from the CHANGELOG section
for the version - that section is the single source of truth for the notes.

## One-time setup (maintainer)

`npm publish` in the workflow authenticates with an `NPM_TOKEN` repository
secret. Add it once at GitHub -> Settings -> Secrets and variables -> Actions ->
New repository secret (`NPM_TOKEN`, an npm automation token with publish rights).
Without it every release run fails at the publish step. This is the only manual
setup; do not commit the token anywhere.

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

   If the run failed at the publish step, the usual cause is a missing or expired
   `NPM_TOKEN` secret (see one-time setup above).

## Notes

- The workflow triggers **only** on `release: published`, never on push or tag
  alone - pushing the tag in step 4 does not publish; creating the release does.
- `--provenance` needs the workflow's `id-token: write` permission (already set)
  and the `repository` field in `package.json` to match the GitHub repo.
- npm rejects republishing an already-published version, so never reuse `X.Y.Z`.
