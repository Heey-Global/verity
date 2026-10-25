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

### Commit-status access for existing installations

New web and mobile onboarding manifests request `statuses: read` (GitHub's
**Commit statuses: Read-only** repository permission). This grant is used only
by the separate diagnostic token; ordinary project tokens and credential
validation do not require it.

Updating Verity does not change an existing GitHub App or installation grant.
To enable commit-status diagnostics for an existing installation:

1. As an App owner or manager, open the GitHub App's **Permissions & events**
   settings, set **Repository permissions → Commit statuses** to **Read-only**,
   and save the change.
2. As the installation owner, review and approve the updated permissions in
   the installed App's settings. Keep the existing repository selection.
3. From a trusted administrative context, verify the installation's
   `permissions.statuses` is `read` (or `write`) using GitHub's installation API,
   then retry `gh api repos/OWNER/REPO/commits/REF/status` from the session.

A generic `forge broker request rejected` response does not prove which grant
is missing. Installation metadata is not exposed through the session's
repository-bound broker; inspect it using administrator credentials outside the
session. A successful check-run query does not verify commit-status access.

See GitHub's [updated permission approval guide](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app).

## Forgejo connections

Forgejo uses a separate adapter bound to the project's configured connection,
including its HTTPS port and reverse-proxy path prefix. Two connections to the
same authority retain separate capability bindings and credentials. The broker
rechecks the live project binding before injecting credentials. Unknown API
operations, foreign repositories, encoded traversal, and authentication or sudo
query overrides are rejected. Forgejo redirects are not followed.

The core adapter allows Git Smart HTTP, issue reads/writes, PR reads/writes and
merging, commit status reads and Actions run reads. It does not grant registry,
release publication or GitHub GraphQL access. Mobile connection screens and a
Forgejo agent CLI remain separate integrations.

Configured Forgejo instances may resolve to private addresses: adding such a
connection authorizes its fixed server-side endpoint. This exception does not
apply to GitHub or arbitrary client-supplied destinations. Custom upstream CAs
are independent of the sandbox-facing broker CA. Server-side Git operations
scope credentials and CA settings to the configured repository URL and disable
redirects. Sandbox Git receives only a broker capability placeholder.

Local integration tests run real Git clone, fetch and push through both provider
adapters, including a Forgejo prefix and non-default port. HTTPS fixtures check
both CA trust boundaries. These checks do not replace acceptance against a live
Forgejo deployment and its configured token scopes.

Migration `0161_forge_connection_identity` preserves existing clone paths and
legacy GitHub identities. A schema downgrade cannot restore owner/repository
uniqueness while identical coordinates exist on multiple connections; resolve
those duplicates before downgrading. The migration refuses the downgrade rather
than deleting projects or reservations.
