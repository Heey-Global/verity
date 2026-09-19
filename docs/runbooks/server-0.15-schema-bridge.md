# Prepare the Server 0.15 schema bridge

Status: preparation only. Do not publish the bridge or replace the stable channel
until the delivery limitation below has an approved resolution.

## Why the update is blocked

Server 0.15.1 declares `0097_remove_cross_project_workflows` as its maximum readable
schema. Server 0.16.0 targets `0098_google_workspace_files`. The latter migration
adds a `kind` column to `session_slide_decks` and `recent_google_slide_decks`, both
with a non-null `slides` default. Its forward migration is additive, but that does
not retroactively extend the older image's compatibility promise.

The bridge keeps the 0.15 schema and application behavior, while declaring that
the reviewed 0098 generation remains readable. Do not remove the schema check or
advertise tolerance of arbitrary future migrations.

## Prepare immutable bridge inputs

Use an isolated maintenance branch based on `v0.15.1`, whose commit is
`90958b0f7c29e7bc8f3590e4ab9fa9ad697f80ff`. Do not start from 0.16.0: including
migration 0098 would prevent 0.15.1 from installing the bridge itself.

1. Set `version.txt` to `0.15.2` and the root entry in
   `.release-please-manifest.backend.json` to `0.15.2`. Record the resulting source
   commit after review. Preserve the migration set ending at 0097.
2. Build `deploy/Dockerfile` with `VERITY_SERVER_VERSION=0.15.2` and
   `VERITY_SCHEMA_FORWARD_MAX=0098_google_workspace_files`. The Dockerfile writes
   the latter to `/app/.verity-schema-forward-max`; an environment variable on a
   deployed container cannot replace this immutable promise.
3. Inspect the built image's exported `SERVER_COMPAT`. Require
   `serverVersion=0.15.2`, `schema.current=0097_remove_cross_project_workflows`,
   and `schema.max=0098_google_workspace_files`. Record the source SHA, build
   inputs, image digest, architecture, and compatibility metadata together.
4. Verify both supported architectures before treating the bridge as publishable.

The maintenance workflow inputs, when publication is eventually authorized, are
`backend-version=0.15.2`, `backend-ref=<reviewed bridge source SHA>`,
`backend-schema-forward-max=0098_google_workspace_files`,
`backend-republish=false`, and `backend-accept-no-rollback=false`. The workflow
requires an existing draft **release** targeting that exact full source SHA.
This is distinct from a pull request, which must be review-ready, never draft.
Do not create that release or dispatch publication as part of preparation.

## Verify both transitions

Use the existing live smoke harness only against its isolated disposable Docker
daemon. Never run it against a deployment's daemon.

- Test the exact released 0.15.1 image as predecessor and the stamped 0.15.2 bridge
  as candidate. Both images must pass the production compatibility decision;
  forward cutover, health, secret handoff, companion reconciliation, and restart
  must succeed.
- Test that same bridge digest as predecessor and the exact 0.16.0 candidate
  digest as successor. Exercise migration 0098 and a failed activation followed
  by rollback to the bridge. Confirm the bridge can restart and operate the
  database after 0098 has been applied, including existing slide-deck records.
- Demonstrate that the direct 0.15.1-to-0.16.0 transition fails the compatibility
  gate. Also demonstrate that omitting the bridge stamp prevents the second hop.
  These negative controls establish that the check protects the actual images.

Use the full smoke profile for the rollback proof. The bounded release profile
alone does not prove the older application operates the migrated database. The
mandatory image compatibility gate applies to every profile and cannot be
bypassed by the no-rollback override. The smoke image must receive the same
forward-stamp build input as the publisher.

## Stable channel limitation

The current channel document names one release, not a sequence of compatible
intermediate releases. `publish-server-channels` in `.github/workflows/release.yml`
always replaces `channel-stable-amd64` and `channel-stable-arm64`, including for a
maintenance release. There is no artifact-only maintenance switch.

The resolver in `packages/server/src/self-update/release-channel.ts` remembers the
last verified version even when that version is incompatible. A 0.15.1 process
that has already seen 0.16.0 rejects a subsequently published 0.15.2 channel as a
version regression. A fresh process could accept 0.15.2, but restarting clients
and temporarily replacing the global channel is not a durable delivery strategy.
Once stable points at 0.16.0 again, another 0.15.1 installation that missed the
bridge remains blocked.

Therefore, a verified bridge artifact is not yet a complete recovery for an
existing paired deployment. Before publishing, decide how that deployment will
receive a verified intermediate release without weakening channel anti-regression
or hiding the current stable release from other installations. Compatible release
routing would require additional implementation; it is not an existing option.

## Existing manual tooling and its boundary

For an installation that has **never paired a device**, the existing installer
supports an explicit update to an official digest-pinned image. Once a bridge has
been published and its digest verified, replace the placeholder below with that
exact architecture-appropriate reference:

```sh
sudo deploy/bin/verity-install --check --update --image '<verified official bridge digest reference>'
sudo deploy/bin/verity-install --update --image '<verified official bridge digest reference>'
```

The reference must have the form
`ghcr.io/heey-global/verity/verity-server@sha256:<64 hexadecimal characters>`.
Run the second command only after reviewing the check output and authorizing the
deployment change. See `deploy/bin/verity-install --help` and the installation
section of `deploy/README.md` for this existing interface.

This alternative does **not** apply to the paired deployment showing the update
error: the installer deliberately refuses `--update` after pairing. Running the
installer without update arguments repairs topology around the selected release;
it does not select the bridge. No supported paired-host manual version-selection
CLI was identified. Do not substitute `--reinstall`, edit sealed deployment state,
or invoke the internal Updater API to bypass the verified update decision.
