---
name: glab-axi-release
description: "Cut a glab-axi release: move the CHANGELOG Unreleased section to a new version, bump package.json, tag, create the GitHub release (which publishes to npm), and verify the publish landed. Use when releasing glab-axi, publishing a new glab-axi version to npm, or preparing a glab-axi release."
user-invocable: true
author: Christopher McKay
---

# glab-axi-release

Cut a glab-axi release end to end. Publishing to npm is automated: creating a
GitHub release fires `.github/workflows/release.yml`, which builds, runs the
test suite, and then runs `npm publish`. The release notes come from the
CHANGELOG section for the version - that section is the single source of truth
for the notes.

## One-time setup (maintainer)

The publish job authenticates with **npm Trusted Publishing (OIDC)**. There is
no npm token: the registry mints a short-lived credential from the workflow's
GitHub Actions identity. Do not create an `NPM_TOKEN` secret - it is not read,
and a long-lived token is the thing this setup exists to avoid.

Register the trusted publisher once, on npmjs.com:

1. Sign in to npmjs.com as a user with publish rights on `glab-axi`.
2. Go to Packages -> `glab-axi` -> Settings -> **Trusted publishing**, and pick
   **GitHub Actions** under "Select your publisher".
3. Fill in the fields to match this repo exactly:
   - **Organization or user**: `karotkriss` (no leading `@`)
   - **Repository**: `glab-axi`
   - **Workflow filename**: `release.yml` (filename only, not a path, and it
     must keep the `.yml` extension)
   - **Allowed actions**: at least one must be selected; `npm publish` is what
     this workflow runs
   - **Environment name**: `npm-publish` (npm treats this field as optional,
     but the publish job declares `environment: npm-publish`, so filling it in
     keeps the registration as narrow as the workflow actually is)
4. Save. Publishing works from that point on; nothing needs to change in the
   repo.

The match is exact and unforgiving. If the workflow file is ever renamed, or
the job's `environment:` changes, update this registration or every publish
fails. A leading `@` on the org name is a common typo that silently breaks the
match.

## Test the pipeline without publishing (dry run)

The workflow's `workflow_dispatch` trigger has a `dry_run` input that defaults
to **true**:

```sh
gh workflow run release.yml -f dry_run=true
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

A dry run does the full checkout, install, build, and test, verifies the
resolved Node and npm satisfy the trusted-publishing floors, then runs
`npm publish --dry-run` to pack and validate the tarball. **Nothing is
uploaded.**

**A dry run does not verify auth.** `npm publish --dry-run` never contacts the
registry for credentials, so it passes identically whether the trusted
publisher is registered correctly, misconfigured, or absent. Nothing short of a
real publish exercises the OIDC handshake. Read a green dry run as "the code
builds, tests pass, and the tarball is well-formed" and nothing more.

(This is a deliberate correction. The pre-OIDC dry run claimed `npm whoami`
proved "the token and the publish pipeline are wired correctly". It did not:
`whoami` needs no OTP, so it went green while the real v0.2.0 publish failed
with `EOTP` - false confidence on the exact failure the check existed to catch.)

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
   ' CHANGELOG.md | gh release create "v$VERSION" --title "glab-axi: v$VERSION" --notes-file -
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
   to fix and re-release. If it failed at the "Verify toolchain" step, the
   runner resolved a Node or npm below the trusted-publishing floor - fix the
   pin in the workflow. If it got past those and failed at the publish step,
   the cause is almost always the trusted-publisher registration not matching
   this repo, workflow filename, or environment (see one-time setup above). A
   dry run cannot diagnose that; publishing is the only thing that exercises it.

   A failed publish does not consume the version - npm only reserves `X.Y.Z`
   once a publish actually lands, so a re-run after fixing the registration can
   reuse the same tag and release.

## Notes

- A real `npm publish` happens **only** on `release: published`, never on push
  or tag alone - pushing the tag in step 4 does not publish; creating the
  release does. The manual `workflow_dispatch` trigger cannot publish for real:
  its dry-run path only packs the tarball, and with `dry_run` disabled it is
  just a build/test smoke run.
- Provenance is signed automatically - trusted publishing generates it by
  default from GitHub Actions, so the workflow passes no `--provenance` flag.
  It still relies on `id-token: write` (already set) and on the `repository`
  field in `package.json` matching the GitHub repo.
- The workflow pins Node 24 because trusted publishing needs npm >= 11.5.1 and
  Node >= 22.14.0, and no Node 22 release bundles an npm that new. This is the
  CI publisher's floor only; it is unrelated to the `engines` range the package
  supports for its own users.
- npm rejects republishing an already-published version, so never reuse `X.Y.Z`.
