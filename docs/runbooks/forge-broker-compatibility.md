# Forge broker compatibility

The forge transport extends the HTTP secret broker. GitHub credentials and GHCR
registry bearers remain on the server. Sandboxes use project/container-bound
capabilities. The legacy token endpoint no longer issues credentials.

## Workflow matrix

| Consumer | Broker operations | Local verification |
| --- | --- | --- |
| Git HTTPS | clone, fetch, push, binary packfiles | Real Git Smart HTTP integration |
| gh issue / gh pr | default and JSON view, list, create, comment, PR close/merge | Real CLI TLS integration |
| CI checks | commit checks, suites, statuses, annotations | Repository policy tests |
| Actions | runs, jobs, workflows, logs, artifacts, dispatch, rerun, cancel | Policy tests and real CLI list/dispatch |
| Releases | metadata, create/edit/delete, asset download/upload | Policy tests, real CLI view, binary transfer integration |
| Promotion / Mobile OTA | contents, Git refs/objects, signed commit mutation, reviews/dismissals, labels | Repository policy and script tests |
| Image audit | Node fetch tag catalogue and Release pagination | Explicit proxy/CA setup and audit tests |
| ORAS | mapped GHCR manifests, blobs, referrers, tags | Registry adapter/TLS and wrapper tests |
| Snapshot import | mapped GHCR manifests/blobs | Python proxy/CA setup |

This matrix describes supported workflow families and local coverage. It does
not certify a live deployment or authorize arbitrary GitHub administration.
Real ORAS and private-package acceptance require the client to be installed,
package mappings and a compatible upstream credential grant.

## Permissions and scope

The adapter separates Git, Issue, PR, Checks, Actions, Release and package actions.
GitHub App grants remain the upstream authority; broker authorization cannot
create a missing GitHub permission. Registry publication remains in hosted CI.

GraphQL discovery is bounded. Project and actor relationships expose only
supported metadata. Related Issues can cross repository boundaries, so the
broker checks their returned repository before emitting any response bytes.
Aliases cannot bypass these relationship checks. Label mutation IDs are resolved
against GitHub before the mutation is forwarded.

Policy denials return HTTP 403, invalid capabilities HTTP 401, and transport,
redirect or credential-filter failures HTTP 502. A 502 does not by itself prove
a GitHub outage.

## Binary transfers

Release uploads stream to uploads.github.com without the JSON request buffer.
Upload/download streams are capped at 2 GiB and the existing transport deadline.
GraphQL responses are buffered up to 16 MiB for related-entity checks.

Only authorized asset, log, artifact and registry blob reads follow redirects.
The broker limits redirects to five hops, requires HTTPS/default ports, rejects
userinfo and private-network DNS addresses, and admits only supported GitHub
asset/Actions storage destinations. Every redirected request drops Authorization.
Signed redirect URLs never reach clients. Storage-host changes fail closed.

## GHCR package mapping

Package names are explicitly granted; organization ownership alone is insufficient.
An administrator maintains `forge-proxy/packages.json` under the server's private
identity root:

```json
{
  "project-id": ["organization/repository/server", "organization/toolkit"]
}
```

The mapping must be a regular file owned by the server user, mode 0600. Symlinks
and unsafe package names are rejected. Missing mappings grant no package access.
Restart the server after editing mappings. This is an authorization mapping,
not a feature activation switch.

The adapter requests only pull scope and returns local capabilities in place of
client-facing registry tokens. The existing server-side GitHub App registry mint
provides the source credential. Private-package compatibility and grants must be
verified on deployment; failures never enable a sandbox-token fallback.

The ORAS wrapper provides a temporary registry configuration containing only a
capability and removes it after execution. Install ORAS separately; the wrapper
does not bundle the client. The Node audit explicitly enables proxy handling and
CA trust. Python snapshot imports configure the same proxy and CA in broker mode.

Docker daemon pulls originate from the daemon, not the sandbox CLI environment.
They retain the existing server-side provisioning registry-auth path. The forge
wrapper does not claim to mediate daemon traffic. Hosted CI authentication is
unchanged.

## Deployment acceptance

Deploy updated server, relay and toolkit images. Existing broker CAs remain valid;
new leaf certificates include uploads and GHCR. Recreate project containers for
updated client helpers.

For live acceptance, verify disposable Git/PR operations, default
and JSON Issue/PR output, checks and paginated Actions reads, a dedicated workflow
dispatch/rerun/cancel, temporary Release asset upload/download and cleanup, and
mapped public/private image reads through the audit and real ORAS client.

Do not promote production or retag production images as a smoke test. Record live
acceptance separately from local fixtures. Legacy token removal is a separate
step after acceptance.

## Git fetch and public dependency repositories

The broker forwards gzip-compressed `git-upload-pack` requests as binary streams,
without decompressing them. Compression remains rejected for API requests and
Git writes.

Git reads outside the project's bound repository use anonymous upstream access.
This supports public dependency repositories such as pre-commit hooks. The broker
never mints or forwards project credentials for those reads; GitHub rejects private
repositories. Foreign writes and foreign API access remain rejected. Redirects
are not followed for Git requests. Project/container capability and `git-read`
authorization are still required.

## Merge diagnostics permissions

Diagnostic requests use separate repository-scoped tokens and caches: `statuses: read`
for commit statuses, `administration: read` for classic branch protection, and
`contents: read` for repository rulesets and effective branch rules. Ordinary project
tokens and App credential validation keep their existing permission requirements.
Missing diagnostic grants deny only the affected diagnostic request; there is no
fallback to broader credentials. If GitHub denies issuance, verify the App and
installation grants from a trusted administrative context before requesting approval.
All routes remain bound to the project repository. Protection/ruleset mutations
remain denied. Installation grants and deployed behavior require live verification.
