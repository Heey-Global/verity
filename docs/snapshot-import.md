# Private OCI snapshot import

This repository accepts sanitized file content only. It never fetches source Git
references or copies Git objects, branches, tags, authors, or timestamps.

## Contract draft (v1)

The immutable OCI manifest must use `application/vnd.oci.image.manifest.v1+json`,
one config blob of `application/vnd.heey.verity.snapshot.config.v1+json`, and one
gzip-compressed tar layer of `application/vnd.heey.verity.snapshot.layer.v1.tar+gzip`.
The canonical JSON config uses schema
`https://github.com/Heey-Global/verity/snapshot/v1`, identifies the source commit
only as a 40-character `source_sha`, declares `notice_required`, and lists every
regular file with its safe relative path, byte size, SHA-256, and mode (`0644` or
`0755`). It must declare `license` as `Apache-2.0`; `notice_sha256` is the NOTICE
digest when required and `null` otherwise. Canonical JSON is UTF-8, sorted by
key, compact, and newline-terminated.

The draft media types and schema must be reconciled with the private exporter
before the first import. `snapshot-policy.json` intentionally permits no package
coordinate or import destination until its reviewed allowlists are updated.

## First import

1. In the private GHCR package settings, grant this repository's GitHub Actions
   read access. Do not create a PAT or grant access to the private source repository.
2. Start the **Import sanitized snapshot** workflow with the lowercase package
   coordinate and immutable `sha256:…` OCI digest. A tag is rejected.
3. Run `verify` first and inspect its log. Update the destination policy only from
   the jointly reviewed export allowlist.
4. After workflow verification, a maintainer pulls and applies the same immutable
   digest locally on a `snapshot/<digest-prefix>` branch, reviews the full diff,
   runs tests and a secret scan, and creates a signed commit before pushing. The
   workflow deliberately has read-only contents permission and cannot write `main`.
5. The maintainer opens the review-ready PR. Commits made with `GITHUB_TOKEN` do not
   reliably trigger downstream workflow runs. If automated PR creation becomes
   necessary, use a separately approved, Verity-only GitHub App token; none is
   configured by this implementation.
6. Review the complete diff and provenance, then revoke the package's Actions
   access after the controlled transfer window.

The importer validates the requested and returned OCI digests, descriptor media
types and sizes, canonical config, exact archive membership, every file digest,
path safety, regular-file-only content, NOTICE consistency, and the repository's
default-deny ownership policy before applying any change.
