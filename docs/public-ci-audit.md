# Public CI boundary audit

This audit establishes the CI boundary for the public Verity core. Every GitHub
Actions job runs on a fresh GitHub-hosted Ubuntu runner. The repository does not
route trusted or untrusted work to a persistent project runner.

## Decision rules

- A workflow triggered by `pull_request` runs on a fresh GitHub-hosted runner,
  has read-only repository permissions, receives no project secret, and does
  not publish an artifact or cache writable by a trusted run.
- Release, App Store/TestFlight, Expo, canary, cache-maintenance, and website
  workflows are public automation. Credentials remain protected GitHub or EAS
  configuration and are never present in fork pull requests.
- Every concrete GitHub Actions job pins `runs-on: ubuntu-24.04`; reusable
  workflow calls inherit the runner choice from the called public workflow.
- Reusable actions are public when they contain no identity, secret, or private
  infrastructure assumption. Their callers still own the runner trust decision.

## Path decisions

| Path | Decision | Reason |
| --- | --- | --- |
| `.github/actions/postgres/action.yml` | Public | Generic Docker-based ephemeral PostgreSQL action; no secrets or publisher identity. |
| `.github/workflows/secret-job-worker.yml` | Public | Fork-safe `pull_request` smoke on a fresh GitHub-hosted runner with read-only contents permission and an isolated DinD daemon. |
| `.github/workflows/release-image-audit.yml` | Public | Read-only, GitHub-hosted inspection of already-public release metadata and images. |
| All other `.github/workflows/*.yml` | Public | Core CI and official release automation on fresh GitHub-hosted runners; write permissions and secrets are limited to trusted non-PR triggers. |
| `apps/mobile/.eas/workflows/deploy-testflight.yml` | Public | Reviewable definition of the official iOS build and submission process; credentials remain in EAS. |
| `apps/mobile/.eas/workflows/recover-testflight.yml` | Public | Reviewable TestFlight recovery process; credentials remain in EAS. |

The paid Uplink service implementation is outside this repository. Public
workflows cover only the self-hosted Verity core, its open Uplink client and
transport, the mobile application, and their official release artifacts.
