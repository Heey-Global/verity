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

## Required before publication

- Sync the protected `EXPO_TOKEN` from Doppler to GitHub Actions. The public official Expo
  project ID is committed in `apps/mobile/app.config.ts`; forks may override it with
  `EXPO_PROJECT_ID`.
- Create the App Store Connect application for `build.verity.app` and update EAS submission
  configuration with its application ID.
- Create the Google OAuth iOS client for `build.verity.app`.
- Enable and externally verify GitHub private vulnerability reporting.
- Confirm all release workflows publish only to the public Verity repository and packages.
- Resolve the current npm audit report when compatible Expo 57 updates are available. All 16
  advisories are in the Expo/Metro/Xcode build toolchain: the four high-severity findings are
  denial-of-service parsers reached through `metro` → `image-size`; the twelve moderate findings
  are Expo configuration or Xcode/UUID chains. They are not Server runtime dependencies, but
  untrusted mobile build assets remain a build-worker risk. npm's proposed automatic fixes are
  incompatible major downgrades (including Expo 57 to 46) and must not be applied.

The local candidate uses Verity consistently in product names, package names, paths, environment
variables, container identities, application identifiers, and public endpoints.
