# Releases

Verity has three products and four delivery paths: Server, website, native
mobile, and mobile OTA. Changes accumulate in an open approval pull request;
merging that pull request approves a specific release candidate. Ordinary source
merges do not approve a release.

| Product | Approval | Delivered artifact |
| --- | --- | --- |
| Server | Release Please PR | Verified Server and supporting images, signed update channels |
| Website | Release Please PR | Versioned, smoke-tested website image |
| Mobile native | Release Please PR | A new `X.Y.0` runtime and TestFlight binary |
| Mobile OTA | Rolling promotion PR per runtime | A specific EAS update group for the installed runtime |

## Release ownership

Backend, native mobile, and website retain separate Release Please configurations
and version manifests. Their generated files are disjoint, so one product's
version change does not create a conflict in another product's release PR.

Release membership comes from changed paths; the Conventional Commit squash title
controls the version bump and changelog. `feat` produces a minor release and
`fix`/`perf` a patch; `!` marks a breaking change. Use release-neutral types such
as `test`, `docs`, `ci`, and `chore` when no product behavior changes. CI validates
the PR title for every author, including automation. No intent file is required.

The Server package is rooted at `.` and excludes `.github`, historical `.release`
metadata, `apps/mobile`, `packages/mobile`, and `docs`. Mobile and website keep
their own configurations and path ownership. A mixed PR can affect several
products. Co-located tests and root documentation must use the appropriate
release-neutral title; Release Please exclusions are directory prefixes, not
file globs.

The shared root lockfile remains a Server build input. A `fix(deps)` changing it
can therefore produce a Server patch even when the dependency is mobile-only.
This conservative policy avoids suppressing dependency-only Server security
fixes; it does not claim dependency-level release isolation.

Squash-only merging preserves one authoritative title per product change.
Migration from the former `.release/backend` package keeps the same manifest
version, `server` release branch, `v` tags, root changelog and version file.
Historical release boundaries remain readable; migration never bootstraps a new
history or publishes a release by itself.

## Changes that require operator action

Some changes cannot be made safe by the Server alone: a Sandbox boundary binary
rolls on its own lifecycle (ADR 0006 D9), so a change spanning both sides may
need project containers recreated, and in a particular order. A runbook is not
the delivery vehicle for that — it is reachable only by an operator who has
already hit the failure it describes.

Such a change ships as a breaking one: a `!` on the squash title and a
`BREAKING CHANGE:` footer in its body naming the action and the ordering. Release
Please renders that footer in `CHANGELOG.md`, which is the release notes, so the
requirement arrives with the version that needs it rather than after it. The `!`
is about the operator's deployment, not about a source API — a release nobody can
install correctly without a step they were never told about is the breakage.

The test is what the step preserves, not that a step exists. If the release makes
something that worked before stop working until the operator acts, that is the
breakage and the `!` announces it. If the step only unlocks a NEW capability —
nothing that ran yesterday changes, and an operator who does not want the
capability does nothing — it is a `feat:`, and the step belongs in that feature's
release note and runbook. Both shapes need documenting; only the first needs a
version number that makes people read it.

Two consecutive OpenCode changes both shipped as `!`, and only one of them should
have; that pair is why this paragraph exists. They are about different turns, so
keep the classes apart when reading them. Admitting OpenCode to the brokered secret tools (#527) changed
**project-Sandbox turns**: a container provisioned before it had been running
those turns tool-less, and afterwards the boundary refuses them until it is
recreated, so the operator acts to keep what they already had. Running OpenCode's
**control-plane turns** on the dedicated Runner (#532) never touched that class —
control-plane turns were refused by the Server itself, before and independently of
#527, so nothing regressed, Claude and Codex were untouched, and an operator with
no OpenCode control-plane session had nothing to do. That one should have been a
`feat:`; the entry stands in the 1.0.0 notes as cut, since neither history nor a
published changelog is rewritten for it. Past 1.0.0 the same mistake costs a major
version, so it is cheaper to make the distinction here than in review.

Write the footer as an instruction, not a description: what to do, in which
order, and what fails if that order is reversed. The runbook then carries the
recovery for whoever finds out the hard way, and is linked from it.

## Planning and publication are separate

The release lifecycle makes a decision before invoking Release Please:

1. An ordinary eligible source push updates the product's release PR in
   **planning-only** mode. It cannot create a GitHub release.
2. A merged release PR is processed in **release-only** mode. It cannot create a
   second release PR while the first version is still being published.
3. A draft or unresolved publication blocks further planning for that product.
   Recover that release instead of creating another version to hide the failure.
4. Planning requires a known, published release boundary matching the product's
   version manifest and Git history. Missing history is an error, not permission
   to gather every historical commit into a new changelog.
5. A completed Server publication dispatches one planning run of its own. The
   push that published a version could not also plan the next one, and nothing
   else reconciles that: source commits merged before the release would sit on
   main without a release PR until an unrelated later push happened to plan
   one — silently, with no failed run to notice. That run can only plan. It
   refuses every recovery input and stops unless the lifecycle reaches planning
   mode, so it opens a release PR when one is due and does nothing when it is
   not. The Mobile train is deliberately excluded: its OTA-versus-native
   decision is derived from the push diff, which a dispatched run does not have.

Pending merged release PRs are read from the paginated pull-request REST API,
not GitHub's search index. A merged PR can be absent from search while its
manifest is already on main. Both lifecycle reconciliation and delayed-tag
validation use the same lookup, retaining the pending label, release branch,
bot author, ancestor commit, and manifest-version checks. If publication was
stranded by a missing search result, merge the lookup fix and let the next
eligible push reconcile the original release commit. If workflow files changed
since that commit, the delayed-tag gate prints the exact validated tag and SHA
that an authorized checkout must push before retrying the latest release run.
Do not move the version to newer source or remove the pending label to bypass
the gate.

The first release of a product needs an explicit bootstrap decision rather than
an implicit fallback from an unknown boundary. A delayed trigger must not
replace a newer plan with an older source snapshot.

Server changes are collected from its configured root package. Website
changes are collected from `docs/website`; its `concept.md` and `landing-copy.md`
are excluded. Shared deployment or test scripts are not automatically new
website product changes.

## Candidate identity and retry

Source identity and public availability are different facts. Git references
bind a candidate to its source commit; a GitHub draft release is not evidence
that customers can install it. Image digests, signed evidence, EAS update IDs,
and Apple build validation establish what was built and checked.

Retries must retain the candidate's source. Native recovery must not force-move
a tag to current `main`. A source fix requires a new candidate/release decision.
A failed comparison, an unexpected owner, a missing record, or a conflicting
artifact identity stops the workflow rather than guessing.

Remote writes are not atomic across GitHub, registries, Apple, and EAS. Recovery
therefore checks completed effects and performs the remaining ones. In
particular, an EAS channel change may succeed before GitHub release recording;
retry verifies the approved group and channel before finishing the record.

## Server delivery

The Server release includes the toolkit, sandbox, relay, Server, and required
preview images. Existing installation, self-update/rollback, architecture,
provenance, signing, and digest checks remain part of release acceptance.

Generate and upload signed channel evidence before updating the mutable stable
channel. Promote only after the required images and evidence are complete, then
finalize the public GitHub release. A partial promotion remains recoverable and
must not be reported as a completed publication.

Keep signing jobs in `.github/workflows/release.yml`: installed Servers trust
that workflow's Fulcio certificate identity. Moving it requires a separate trust
migration, not just a workflow rename.

## Website delivery

A website release publishes `verity-website:vX.Y.Z` after its smoke test. Deployment
pins that version; there is no `latest` tag. The ordinary source workflow also
produces `sha-<commit>` images, but those are not release approvals.

The explicit website recovery inputs on `release-dispatch.yml` resume the
recorded release source. Do not replace the bytes of a published version to fix
a product defect: release a new version. Artifact/tag conflicts must stop
recovery instead of silently moving an existing version.

## Mobile: OTA by default

A published native `mobile-vX.Y.0` establishes runtime `X.Y.0`. Compatible changes
accumulate as OTA patches of that runtime. Feature count and number of merges do
not require a native build.

All release paths use the same native compatibility assessment. For dependency
or configuration changes, compare iOS native fingerprints from independently
installed source trees with the same tool and environment, matching the current
TestFlight delivery target. Pure JavaScript
dependency changes alone must not force a new binary. Marketing version and the
explicit runtime string are excluded from that comparison; native modules,
plugins, native assets, and custom native preparation still matter. Failure to
establish compatibility blocks OTA.

Once `main` needs a different native runtime, its changes accumulate in the
native release PR. Do not publish that source to the old runtime. Supporting
parallel OTA fixes for an older runtime would need an explicit maintenance
branch; the mainline workflow does not cherry-pick a subset automatically.
Native releases become public only after the TestFlight build passes Apple
processing. Compatible source merges then resume OTA delivery for the new line.

## Rolling OTA approval

There is one open OTA promotion PR per TestFlight runtime, not one PR per source
merge. The PR contains the cumulative changelog since the latest **published**
mobile release and points at the newest successfully prepared candidate.

The planned patch version stays the same while source changes accumulate.
Candidate references and EAS branches include the source identity, so updating
the PR never overwrites a previously built candidate. Reserve the candidate
before upload; retries reuse the recorded update group rather than publishing
different bytes to the same candidate branch.

A promotion manifest binds the runtime, source commit, planned version, EAS
branch, exact update group, and release notes. The staging workflow updates the
rolling PR only after preparing the candidate, then dispatches verification for
its new head. Before dispatch, staging dismisses approvals of older heads and
stops if dismissal fails. Promotion independently rejects any remaining stale
approval. Configure required checks on the protected branch as well.

Merging freezes the manifest used by promotion. Promotion validates that source,
runtime, candidate reference, and EAS group agree, changes the TestFlight
channel, reads it back, and records the same cumulative notes on the GitHub
release. A later merge to `main` cannot change the already-approved candidate.

## Scheduling, permissions, and migration

`release-dispatch.yml` owns independent Server, native mobile, and website
lifecycle locks. OTA promotion shares the native mobile publication lock so
runtime transitions and OTA activation cannot race. OTA preparation can run
separately because promotion revalidates compatibility and identity.

Each lifecycle queue uses `queue: max` and does not cancel active publication.
Arrival order is not commit order, so source and release-boundary checks remain
necessary. Keep manual maintenance/rollback actions explicit.

Release Please and OTA use the repository `GITHUB_TOKEN`. Bot-created PR updates
do not recursively trigger normal PR workflows, so generated PRs explicitly
dispatch CI against their current branch head. Do not weaken CI or add a personal
token to work around that behavior.

Before deploying changed release automation, let old publication jobs finish:
running jobs retain the workflow code and locks from their original commit.
Review existing generated release PRs against the last published release;
close a stale historical replay instead of merging it. The new lifecycle must
not manufacture a release boundary from a misleading PR description.

Old OTA candidates already have versioned tags and branches. Preserve those
references; never repoint them for the rolling scheme. Supersede an old
workflow-owned approval only after the replacement is prepared, or complete its
existing promotion first. Validate the migration against open PRs before merge.

For recovery, dispatch `release-dispatch.yml` with the existing native tag,
backend maintenance inputs, or website version/ref. OTA promotion can be retried
through its own workflow. Always inspect the recorded source and artifact
identity; a successful retry should complete the original operation, not create
a new one under the same name.
