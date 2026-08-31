# Open-source readiness

This checklist is a publication gate for the first Verity source snapshot.

## Completed for the local candidate

- The snapshot contains no Git objects, refs, tags, branches, or source commit metadata beyond
  the explicit provenance SHA.
- Every source file was checked against its manifest SHA-256 before import.
- The archive contains regular files only and no symlinks or unsafe paths.
- Gitleaks reports no detected secrets in the candidate source.
- Dependencies resolve from the public npm registry; no private package registry is required.
- Apache License 2.0 and generated third-party notices are included.
- GitHub Actions use GitHub-hosted runners and pin third-party actions to commit SHAs.
- The paid Uplink service implementation, billing, entitlements, and hosted operations remain
  outside the repository. The open client, connector, edge, and protocols remain public.
- Formatting, lint, TypeScript build, the complete test suite, third-party-notice validation,
  workflow contract tests, and a final staged-diff secret scan pass locally.
- The official Expo project, App Store Connect application, iOS distribution certificate,
  provisioning profile, APNs key, and App Store Connect submission key are configured for
  `build.verity.app`.
- The protected `EXPO_TOKEN` is stored in GitHub Actions; the public official Expo project ID is
  committed in `apps/mobile/app.config.ts`, and forks may override it with `EXPO_PROJECT_ID`.
- The monitored `security@verity.build` vulnerability-reporting alias and
  `hello@verity.build` conduct/trademark alias terminate at the same mailbox and have been tested
  externally.
- GitHub private vulnerability reporting is enabled for `Heey-Global/verity`.

## Required before publication

- Submit and close a clearly marked test vulnerability report from an external GitHub account.
- Complete the required source review after the review runner supports file-based chunking for
  snapshots larger than its current 1 MiB request limit.
- Confirm all release workflows publish only to the public Verity repository and packages.
- Resolve the current npm audit report when compatible Expo 57 updates are available. All 16
  advisories are in the Expo/Metro/Xcode build toolchain: the four high-severity findings are
  denial-of-service parsers reached through `metro` → `image-size`; the twelve moderate findings
  are Expo configuration or Xcode/UUID chains. They are not Server runtime dependencies, but
  untrusted mobile build assets remain a build-worker risk. npm's proposed automatic fixes are
  incompatible major downgrades (including Expo 57 to 46) and must not be applied.

## Official mobile OAuth configuration

- The Google OAuth iOS client for `build.verity.app` is configured in Testing mode. Every account
  that connects Drive must be added as a test user; Testing-mode refresh tokens typically expire
  after seven days and require reconnecting. The official public client ID is committed as
  reproducible configuration and stored as `GOOGLE_AUTH_ID` in the EAS `production` environment.
  A GitHub repository variable may override it for a fork. The native config registers the
  matching reversed-client-id URL scheme. This is not a source-publication gate; forks supply
  their own OAuth client.

The local candidate uses Verity consistently in product names, package names, paths, environment
variables, container identities, application identifiers, and public endpoints.
