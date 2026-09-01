<!--
Title: Conventional Commit, e.g. `fix(server): reject stale tokens`.
The full expectations live in CONTRIBUTING.md; this template is the short form.
-->

## What changes

<!-- The user-visible effect and the problem it solves. -->

## Why here

<!-- If several code paths reach the same bug, say why the fix sits where it
     does rather than at each caller. -->

## Verification

<!-- Which commands you ran and what they proved. Name anything only CI can
     check, and anything you could not run. -->

- [ ] `npm run build`, `npm test`, `npm run lint` and `npm run format` pass
- [ ] Tests cover the changed behavior, and fail without the change
- [ ] Documentation updated if this moves a trust boundary, deployment
      requirement, migration or recovery path
- [ ] Screenshots for visual changes, a short recording for interaction changes

<!-- Nothing in this pull request contains credentials, customer data,
     production logs or private repository content. Suspected vulnerabilities
     go through the private flow in SECURITY.md, not a public pull request. -->
