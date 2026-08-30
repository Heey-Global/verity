# Releases

Verity uses release-please to collect conventional commits into deliberately
merged release pull requests. Backend artifacts and native mobile builds have
separate release PRs; Mobile OTA patches continue to publish automatically.

## Release-PR checks without a PAT

release-please intentionally uses only the repository `GITHUB_TOKEN`. Pull
requests created with that token do not recursively trigger `pull_request`
workflows, so `.github/workflows/release.yml` explicitly dispatches `ci.yml` for
every release-PR branch returned by release-please. This requires `actions: write`
on the release workflow and a `workflow_dispatch` trigger on CI.

The dispatched run is visible in GitHub Actions and validates the exact release
branch, but it is not attached to the pull request as a `pull_request` status
check. This trade-off is intentional: Verity avoids a long-lived PAT and its
associated storage, permissions, and rotation lifecycle.

## Verity website

The product website is its own release train, `website-vX.Y.Z`, tracked in
`docs/website`. A release publishes one image, `verity-website:vX.Y.Z`, and that
tag is what the downstream deployment manifest pins. There is deliberately
no `latest`: the cluster should have exactly one way in, and it should be a pin
somebody moved on purpose.

It is separate from the backend train for two reasons. A backend release must
not move a version the cluster tracks, and release-please assigns commits to a
package by path — so a change can only produce a website release if it lands
under `docs/website`, which is why the Dockerfile and the nginx config sit there
rather than in `deploy/`. A Renovate bump of the nginx base image is typed `fix`
for that one file (`renovate.json`) so it produces a patch release; as a `chore`
it would publish a `sha-<commit>` image that no released version, and therefore
no pin, would ever reach.

The corollary is worth knowing before moving a file: the shared smoke lives in
`deploy/bin/verity-website-smoke`, outside the package, so fixing it releases the
backend rather than the website. That is the right way round — a stricter smoke
is not a new site — but it means the image a `website-vX.Y.Z` publishes can have
been smoked by a script that never appeared in its changelog.

The first release bootstraps: `docs/website` deliberately has no entry in
`.release-please-manifest.json`, so release-please proposes `initial-version`
(1.0.0) and writes the entry itself. Adding the entry by hand would make the
first release 1.0.1, and the `v1.0.0` that `docs/website/version.txt` names would
never be published — a pin to it could not resolve. The committed `version.txt`
does not change that: `apps/mobile` bootstrapped from exactly this shape — a
`version.txt` at 1.0.0, no manifest entry, `initial-version: 1.0.0` (`97f2fcd0b`)
— and its first release was `mobile-v1.0.0` (`f86ea5eca`), which added the
manifest entry.

Two edges of the train are worth knowing. `concept.md` and `landing-copy.md` are
excluded from the package and the root excludes all of `docs/website`, so a
commit touching only those two prose files releases nothing and appears in no
changelog — deliberate, since neither reaches an image. And the train's scope is
wider than the build's: a `fix:` to any other file under `docs/website` cuts a
release, which republishes a byte-identical image under a new version. Harmless,
but it is why a version bump alone does not imply the site changed.

Every main commit that touches those paths still publishes an untagged digest and
tags it `sha-<commit>` (`verity-website.yml`). Both publishes smoke the image
before anything tags it, through the same script.

Re-running the failed job of a publish that failed before it tagged is the
recovery path and works. Re-running the whole workflow is not: release-please
runs again, finds the release already made, and reports no release created, so
the publish job is skipped and the run goes green without an image. There is no
dispatch fallback for this train the way there is for mobile — if a release is
left with a `website-v` tag and no image, release a patch version.

Once the tag exists, a re-run is refused: the rebuild would land on a new digest,
and moving a released tag under the cluster is invisible to ArgoCD — the manifest
still names `vX.Y.Z`, so nothing rolls out and running pods keep the old digest
while newly-scheduled ones get the new. That case needs no recovery anyway; the
tag was only written after the smoke passed. If an already-published version has
to change, release a patch version, or — if the published image is genuinely
wrong — delete the tag in the registry first and then re-run.

## Mobile runtime lines

A published native release `mobile-vX.Y.0` opens exactly one OTA runtime line.
The runtime identifier is the explicit string `X.Y.0`, and every merged mobile
release PR always produces a new native TestFlight binary before its draft GitHub
release is published. Fingerprints are not used as release-line identifiers because
Expo intentionally excludes marketing versions from them.

The OTA workflow requires the version configured in `apps/mobile/app.config.ts`
to equal that latest published native release before allocating `X.Y.1`, `X.Y.2`,
and subsequent patches. When a newer native release is still a draft or its
TestFlight workflow failed, OTA publishing is skipped. This prevents an update
for the new runtime from being mislabeled or offered as a patch for the previous
native line.

If the GitHub workflow fails after release-please created the draft release, run
the `release` workflow manually with that existing `mobile-vX.Y.0` tag. Recovery
validates the draft and checked-out version, aligns the unpublished tag with the
fixed source being built, builds/uploads the native binary, and only then publishes
the GitHub release.
