# Contributing to Verity

Thank you for helping improve Verity. Keep changes focused, explain their user
impact, and preserve the isolation and credential boundaries described in
[SECURITY.md](SECURITY.md).

## Before opening a change

1. Search existing issues and pull requests for the same problem.
2. For a feature or architectural change, open a proposal before investing in a
   large implementation.
3. Never include credentials, customer data, production logs, or private
   repository content in an issue, fixture, commit, or pull request.
4. Report suspected vulnerabilities privately as described in
   [SECURITY.md](SECURITY.md).

## Development setup

Verity requires Node 24 and uses npm workspaces:

```sh
npm install
npm run build
npm test
npm run lint
npm run format
```

The default test suite uses an in-process PGlite database. Some integration and
release tests require Docker or infrastructure that is intentionally available
only in CI. Do not weaken a gate because it is unavailable on a development
machine.

## Pull requests

- Use English for code, documentation, identifiers, commit messages, and pull
  request metadata.
- Use a Conventional Commit title, such as `fix(server): reject stale tokens`
  or `feat(mobile): show update recovery state`.
- Add or update tests for behavior changes.
- Fix a shared problem at the layer all affected paths pass through.
- Keep one concern per pull request.
- Include before/after screenshots for visual changes and a short recording for
  motion or interaction changes.
- Update operational and security documentation when a change alters a trust
  boundary, deployment requirement, migration, or recovery path.

All automated checks must pass. Maintainers may request deeper review based on
the blast radius rather than the number of changed files.

## Licensing contributions

Unless stated otherwise in a file, contributions to this repository are
submitted under the repository's Apache License 2.0 without additional terms.
Do not contribute code you do not have the right to license this way.

Hosted Verity services are separate products. Contributing to this repository
does not grant access to their source code, infrastructure, trademarks, or
commercial services.
