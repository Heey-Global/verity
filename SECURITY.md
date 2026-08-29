# Verity security policy

Verity runs coding agents against source repositories and gives those agents
controlled access to host and third-party capabilities. Treat every repository
and every external document an agent reads as untrusted input.

## Reporting a vulnerability

The repository is not yet public and its durable public security intake channel
has not been activated. **Do not publish this repository until GitHub private
vulnerability reporting is enabled and a report from an external account has
been tested end to end.** Existing authorized collaborators should use the
project's current private maintainer channel. Do not open a public issue for a
suspected vulnerability.

Once activated, the public reporting path will be this repository's GitHub
**Security → Report a vulnerability** flow. A report should include the affected
version or commit, deployment topology, impact, and the smallest safe
reproduction available.

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

## Known limitations

- Verity does not yet classify or block prompt injection in external content.
  Execution isolation limits impact, but it does not make model instructions
  derived from untrusted content safe.
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
