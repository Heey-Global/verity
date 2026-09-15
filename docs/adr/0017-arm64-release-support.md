# ADR 0017 — arm64 Release Support

**Status:** Proposed · **Date:** 2026-09-14

## Context

Verity publishes `linux/amd64` only. That is deliberate and carried through
consistently rather than forgotten:

- `packages/server/src/main.ts:196` returns `null` from
  `hostReleaseArchitecture()` for every non-x64 host, so `/server/updates`
  reports `unsupported` instead of chasing a channel tag that does not exist.
  The comment there states the reasoning: `unreachable` would be a
  transient-sounding error for a permanent condition.
- ADR 0008 records the same thing — `channel-stable-amd64` is the one published
  channel, and any other host reports `unsupported` naming its architecture.
- Both installers refuse a non-amd64 host in preflight
  (`deploy/bin/verity-install:249`, `docs/website/site/install.sh:93`), and
  `docs/website/site/install.test.mjs:65` guards that refusal.

So an arm64 host is turned away at install time. Nothing is broken today; the
architecture is simply absent.

What no ADR records is a decision about arm64 itself. The amd64-only scope is a
consequence of the release workflow being single-platform, together with one
stated reason in `.github/workflows/verity-sandbox.yml:19` — _"the fleet runs on
amd64"_. That is a statement about the Heey development fleet, not about the
hosts on which Verity is self-hosted, and it has quietly been carrying more
weight than it can.

The product argues the other way. Verity is a self-hosted control plane: the
people who run it run their own machine, and on that population arm64 is not a
niche — Hetzner CAX, AWS Graviton, Oracle Ampere, and Apple Silicon for local
evaluation. Today that population's first contact with Verity is
`amd64/x86_64 is required (found aarch64)`, at the top of the funnel, from
someone who had already decided to try it.

Adoption is currently early: the published Server image shows only single-digit
pulls for each semver-tagged image, while repository CI also pulls release
artifacts. GHCR download counters cannot distinguish CI from external use, so
they are a directional signal rather than an installation count. This is still
a comparatively inexpensive moment to add a second architecture because the
compatibility surface is young.

### What is already arm64-ready

The groundwork is substantially done, which is what makes this proposal
tractable:

- `deploy/Dockerfile:144` branches on `TARGETARCH` and carries pinned SHA256
  sums for the Docker CLI, Buildx, and Compose in both architectures.
- `scripts/build-script-sandbox-prebuilts.sh` already produces
  `linux-arm64/verity-script-sandbox` and includes it in `sha256sums.txt`.
- `packages/server/src/runner-boundary-attestation.ts:774` already resolves the
  boundary hashes per architecture and reads the arm64 entry from that file. The
  security boundary needs no change.
- `features/verity-sandbox-toolkit/install.sh:153` resolves arm64 download
  targets for `gh`, `doppler`, and `gitleaks`;
  `features/verity-sandbox-toolkit/prebuilt/Dockerfile:17` builds both targets.
- `scripts/update-toolkit-ledger.mjs:20` keeps both architectures in the ledger.
- `packages/server/src/self-update/release-channel-publish.ts:61` already accepts
  `amd64` and `arm64` on the publish side.
- The bundled PostgreSQL pin in `deploy/docker-compose.yml:506` is a multi-arch
  index and resolves per platform. Verified against the registry, not assumed.
- The relevant container-publishing jobs run on GitHub-hosted `ubuntu-24.04`;
  there are no self-hosted runners. (The reference to "a self-hosted runner slot" in
  `.github/workflows/verity-server.yml:7` is stale.)

What is missing is an arm64 target alongside the existing
`platforms: linux/amd64` constraints in the publish jobs, plus the two findings
below.

### Finding 1 — `oci-ref.ts` is the one platform-blind resolver

`packages/server/src/oci-ref.ts:278` selects from an image index by hand:

```ts
manifest.manifests.find(
  (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64',
) ?? manifest.manifests[0];
```

This is harmless while nothing publishes a multi-arch index. It stops being
harmless the moment one is published: an arm64 host would resolve the amd64
manifest, with no error and no log line — the config blob simply would not
describe the image that runs. The `?? manifests[0]` fallback is the second half
of the problem: a published index also contains a Buildx attestation manifest
with `platform: unknown/unknown`, so an index without an amd64 entry can fall
back to something that is not an image at all.
`packages/server/src/oci-ref.test.ts:932` currently asserts that fallback as
intended behaviour.

This is the only code-level correctness fix arm64 requires, and it must land
before any multi-arch index is published rather than alongside it.

### Finding 2 — the channel carries the index digest, and that is correct

`VERITY_RELEASE_SERVER_IMAGE` is `steps.build.outputs.digest`, which is the
index digest, not the platform manifest digest. Verified against the published
`v0.2.1`: `sha256:74d29462…` is an `image.index.v1+json` holding the
`linux/amd64` manifest and one `unknown/unknown` attestation manifest.
`release-channel-publish.ts:75` validates the reference syntactically only and
cannot distinguish the two kinds of digest.

That is nonetheless the right artifact, because every consumer pairs it with an
explicit platform rather than relying on the digest to carry one:
`docker-in-place-cutover.ts:367` and `:466`,
`managed-control-plane-runner.ts:248` and `:384`, and
`managed-server-owner.ts:653` all pass `platform: linux/${architecture}`, with
the architecture validated in `deployment-spec.ts:353`. An index digest plus a
platform-pinned pull is the sound pattern, and both per-architecture channels
can carry the same index digest.

The gap this leaves is that the `architecture` field is then the channel's only
statement about the platform, and nothing checks it against the image. A release
that publishes `channel-stable-arm64` against an index without an arm64 entry
produces a document that is valid, signed, and verifiable. The failure surfaces
at update time, on a user's host, as a `manifest unknown` from
`docker pull --platform linux/arm64`.

## Decision

**D1 — Publish `linux/amd64` and `linux/arm64` for every image a self-hosted
deployment runs:** Server, sandbox, sandbox toolkit, project relay, and the two
preview components that run on the same host. Partial coverage is worse than
none: a Server that starts and an agent sandbox that cannot is a harder failure
to diagnose than a refused install.

**D2 — Make `oci-ref.ts` resolve by host architecture before publishing any
multi-arch index.** The amd64 constant becomes the host's architecture, and the
`?? manifests[0]` fallback must not be able to select an entry that carries no
usable platform. `oci-ref.test.ts:932` is rewritten in the same change — as
written it protects the behaviour this ADR removes.

**D3 — Keep the index digest in the channel; publish one channel per
architecture; make the release job prove the claim.** Before `oras push`, the
release job must inspect the published index and assert that it contains the
architecture the document names. The registry-aware check belongs in the
workflow (or a dedicated script invoked by it), while
`release-channel-publish.ts` remains responsible for validating the document it
emits. This separates remote artifact verification from metadata rendering and
keeps registry credentials out of the Server image.

**D4 — Build arm64 natively on `ubuntu-24.04-arm`, not under QEMU.** The channel
document is produced by running the built image
(`docker run "$image" release-channel-metadata`), so the arm64 document has to
be produced on an arm64 host. Emulating the artifact that describes a platform
is the wrong shape, independent of build duration.

**D5 — Widen the architecture guards last, and bind them with a test.** While
`main.ts:197`, `verity-install:249`, and `install.sh:93` still refuse arm64, a
half-finished arm64 path is invisible to users rather than broken for them. The
test that closes this must derive the supported architectures from the platforms
the release workflow actually publishes, so the four sites cannot drift apart
again. `scripts/release-workflow.test.ts` already reads `release.yml` and
`deploy/Dockerfile` and is the right home for it.

**D6 — gVisor and Brokered Secret jobs stay amd64-only until native validation exists.**
`VERITY_GVISOR_REQUIRED` defaults to `0` and is required only for Brokered
Secret jobs (`deploy/README.md:715`), so arm64 can ship without a validated
`runsc`. Validating the gVisor boundary on arm64 is real work and the boundary
is a core product claim; shipping it unvalidated to make a matrix symmetrical
would be the wrong trade. This creates a functional difference between
architectures, which D7 makes explicit rather than silent.

This temporary restriction was lifted on 2026-09-14. The dedicated secret-job
workflow now runs the pinned `runsc` confinement smoke and the live fake-secret
round trip on native amd64 and arm64 GitHub runners before the installer admits
`VERITY_GVISOR_REQUIRED=1` on either architecture.

**D7 — Document the difference where an operator chooses a host.**
`deploy/README.md` must state which architectures exist and which features an
arm64 host does not get. An undocumented capability difference between
architectures is exactly the silent divergence this repository's testing
guidance exists to prevent.

### Sequencing

Each stage is independently mergeable and leaves the tree shippable.

1. **`oci-ref.ts` becomes platform-aware** (D2). Small. Blocks everything else.
2. **Sandbox, toolkit, and project relay go multi-arch** (D1). The largest
   stage. The arm64 download paths in the toolkit's `install.sh` exist but have
   never executed; smoke tests run per architecture. The stated reason in
   `verity-sandbox.yml:19` is revised to distinguish published user images from
   the amd64-only Heey fleet.
3. **Server image goes multi-arch** (D1). The Dockerfile needs no change;
   native per-architecture jobs publish immutable temporary references, and a
   dependent job merges their digests into one manifest list before assigning
   the release tags. This avoids separate jobs racing to overwrite the same
   tags and produces the shared index digest required by D3.
   `publish-preview-images` follows from `publish-server`.
4. **Second release channel** (D3, D4). `VERITY_RELEASE_ARCHITECTURE` becomes a
   matrix value only after the shared index has been assembled and verified;
   the release-evidence filenames take an architecture suffix, since two
   architectures would otherwise collide on one GitHub release; `cosign
   sign-blob` and `oras push` run per architecture; `release-image-audit.yml`
   audits both channels.
5. **Guards widen and are bound by a test** (D5), plus the amd64 digests pinned
   in `deploy/gvisor/versions.env` and `deploy/bin/verity-self-update-live-smoke`.

## Non-goals

- Architectures beyond amd64 and arm64 for gVisor / `runsc` and Brokered Secret jobs.
- Migrating the Heey development fleet to arm64. This ADR is about what Verity
  publishes, not about where Heey runs it.
- The website image. It is not part of a self-hosted deployment.
- The mobile app, which is a client and unaffected.
- Any architecture beyond `amd64` and `arm64`. `ReleaseArchitecture` already
  bounds the set and this ADR does not widen it.

## Open questions

1. **arm64 runner availability for the organisation.** GitHub-hosted arm64
   runners are free for public repositories and this repository is public, but
   availability should be confirmed with a throwaway job before stage 2 is
   planned against it.
2. **Release duration and cost.** `publish-server` is the most expensive job and
   the matrix doubles it. Relevant if releases run several times a day.

## Consequences

- The release surface doubles: two channels, two sets of attestations, and an
  audit that must check both. `release-image-audit.yml` exists precisely because
  a release without its images stays silently broken; that failure mode now has
  twice the surface.
- arm64 hosts initially gained self-update without Brokered Secret jobs. The D6
  follow-up closes that capability gap with native security-boundary validation.
- The guard test from D5 makes the architecture set a single derived fact rather
  than four independently maintained ones, which is a net reduction in drift
  surface even though it adds a test.
- Stage 1 is worth landing on its own merits. `oci-ref.ts:278` is latent today
  and would become a silent misresolution the moment anything upstream publishes
  a multi-arch index — including a change made for an unrelated reason.

## References

- ADR 0003 — runner image and deployable packaging
- ADR 0008 — Verity Server self-update (the `channel-stable-<arch>` design and
  the `unsupported` contract this ADR widens)
- `packages/server/src/main.ts:196` — `hostReleaseArchitecture()`
- `packages/server/src/oci-ref.ts:274` — index resolution
- `packages/server/src/self-update/release-channel-publish.ts:61` — publish-side
  architecture set
- `deploy/README.md:715` — `VERITY_GVISOR_REQUIRED`
