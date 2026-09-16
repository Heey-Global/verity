# CI diagnostics

Run the canonical Server image smoke on a branch or commit without selecting all
expensive CI suites:

```sh
gh workflow run ci.yml --ref <branch-or-tag> -f check-suite=server-image
```

This replaces the standalone `verity-server.yml` workflow. The image job retains
its tooling, health, installer and lifecycle checks. Public snapshot/security
checks and a diagnostic aggregate still run. The aggregate is named
`server-image-diagnostics`, so it cannot satisfy the PR-required `ci-checks` verdict. Its separate concurrency group cannot cancel a full manual CI run. It does not publish an image. Do not
combine this input with release-train or release-pr scope. Ordinary pull requests
and main pushes continue to use the changed-area detector.

The default `check-suite=full` keeps the existing full manual CI behavior.

When full tests and contract tests are both selected, the contract job owns root
`scripts/**/*.test.ts` suites; the full test job excludes those suites only for
that run. When the contract job is not selected, the full test job includes them.
The separate Node gateway cutover test stays in the contract job, and the
memory-heavy embedded suite keeps its isolated invocation. Coverage is unchanged.
