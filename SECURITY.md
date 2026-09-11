# Verity security policy

Verity runs coding agents against source repositories and gives those agents
controlled access to host and third-party capabilities. Treat every repository
and every external document an agent reads as untrusted input.

## Reporting a vulnerability

Report suspected vulnerabilities through this repository's GitHub **Security →
Report a vulnerability** flow. If that flow is unavailable, email
`security@verity.build`. Do not open a public issue for a suspected
vulnerability.

A report should include the affected version or commit, deployment topology,
impact, and the smallest safe reproduction available.

We will acknowledge a complete report, investigate it, and coordinate a fix and
disclosure. Do not access data or infrastructure that you do not own or have
explicit permission to test.

## Supported versions

Until Verity publishes a long-term-support policy, only the latest released
version receives security fixes. Security fixes may require upgrading the
Server, Runner, Sandbox image, mobile app, or more than one of them together.
Release notes identify required coordinated upgrades.

## Security model

- A project Sandbox is the primary boundary around repository-controlled code.
- The self-hosted Server is a trusted control-plane component.
- The control-plane Runner is intentionally host-root-equivalent when it holds
  the Docker socket. Project Sandboxes must never receive that socket.
- Reusable credentials should stay outside project Sandboxes. Brokered secret
  operations provide bounded, approval-visible access where a backend supports
  the attested tool channel.
- Images and artifacts are selected by digest in production paths. The release
  workflow currently signs the Server image; signature coverage for every other
  published image remains an open release-readiness gate.
- The secret store is encrypted at rest and starts sealed after a cold restart.

The detailed architecture and decisions live in
[the security ADRs](docs/adr/0002-credential-and-isolation-architecture.md) and
[the brokered-secrets threat model](docs/BROKERED_SECRETS_THREAT_MODEL.md).

## Verifying a release

Two published artifacts carry a signature you can check yourself: the Server
image, and the stable release channel document a deployment's Updater reads
before it pulls. Both are keyless Sigstore signatures made from the release
workflow's GitHub OIDC identity, so there is no public key to distribute or
rotate. What verification establishes is which workflow, in which repository, at
which ref produced the artifact — nothing else is accepted as a Verity release
(ADR 0008 D4).

You need [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
for both checks, plus [oras](https://oras.land/docs/installation) and `jq` for
the channel document.

### The Server image

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/Heey-Global/verity/.github/workflows/release.yml@refs/heads/main \
  ghcr.io/heey-global/verity/verity-server:v17.3.7
```

Substitute the release you are checking. Pass `@sha256:…` instead of a tag when
you intend to run exactly the image you verified: a tag can be repointed, a
digest cannot.

### The stable release channel document

The document names the image digest a release consists of, and is rendered by
the very image it describes. Verifying it by hand runs the same check the
Server runs before it accepts an update offer:

```bash
oras pull ghcr.io/heey-global/verity/verity-server:channel-stable-amd64 -o channel
jq -r .payload channel/channel.json | base64 -d > payload.json
jq -r .signature.bundle channel/channel.json | base64 -d > bundle.json

cosign verify-blob \
  --bundle bundle.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/Heey-Global/verity/.github/workflows/release.yml@refs/heads/main \
  --certificate-github-workflow-repository Heey-Global/verity \
  --certificate-github-workflow-ref refs/heads/main \
  --certificate-github-workflow-sha "$(jq -r .revision payload.json)" \
  payload.json
```

The payload is carried as opaque base64 because the signature covers exact
bytes: re-serializing the JSON anywhere along the way invalidates it.

The last flag is the check worth understanding. Fulcio issues the certificate
for the commit the signing run executed, and the document repeats that commit in
`revision`. Comparing the two is what stops a document from advertising a
revision other than the one it was built and signed from — the Server pins the
repository, its immutable numeric id, the ref, and that commit
(`packages/server/src/self-update/release-channel-verify.ts`).

Then confirm that `serverImage` in `payload.json` is the digest you verified
above, and that `version` is the release you expected.

### Server image provenance

Each Server release also carries a GitHub-signed SLSA provenance attestation for
the exact image digest. Copy `serverImage` from the verified channel payload and
verify the registry attestation against this repository:

```bash
gh attestation verify \
  "oci://$(jq -r .serverImage payload.json)" \
  --repo Heey-Global/verity
```

The matching `verity-server-vX.Y.Z.intoto.jsonl` GitHub release asset is the
signed in-toto envelope exported from that OCI attestation. Its subject digest
must equal the `serverImage` digest in `payload.json`.

### What is not signed yet

Signature and provenance coverage stops at those Server artifacts. The Sandbox, project-relay,
preview, and toolkit images are published unsigned today; the website image
carries builder-generated provenance and an SBOM but no cosign signature. That
gap is the open release-readiness gate the security model above names.

## Known limitations

- Verity does not yet classify or block prompt injection in external content.
  Automated prompt paths provenance-label known external content, serialize it
  as JSON after trusted instructions, and preserve those labels when multiple
  external sources are composed. JSON escaping prevents content from forging the
  surrounding prompt structure. This structural separation reduces ambiguity;
  it does not make model instructions derived from untrusted content safe.
  Execution isolation and permission boundaries still limit impact.
- There is not yet a supported automated backup and restore facility. Do not
  treat a deployment as production-ready until you have independently backed
  up PostgreSQL and validated restoration. A tested project-level recovery
  procedure is a release-readiness requirement.
- Losing the master password can make encrypted credentials unrecoverable.
  Verity has no password recovery backdoor.
- The control-plane Runner's Docker access is a deliberately trusted
  administrative capability, not a sandbox boundary.
- Brokered secrets are approval-gated only on explicitly supported backend and
  transport paths. A recognized protocol label alone does not imply support.
- Self-hosted deployments are responsible for TLS termination, host hardening,
  firewall policy, database availability, and physical access to the host.

These limitations are security boundaries and operational facts, not a promise
that the list is exhaustive. Deployment-specific review remains necessary.

## Hosted services and privacy

The Apache-2.0 self-hosted core can run without Verity Uplink. Uplink, hosted
remote access, sharing, official push infrastructure, and future managed
operations are separate services with their own terms and privacy disclosures.
With no hosted-service configuration, the Server must not silently enroll a
self-hosted installation in those services.
