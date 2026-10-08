# Forge broker test mode

Issue #1198 is a staged migration. The existing HTTP secret broker now also has a
repository-bound HTTPS streaming entry point on the existing project broker
socket. It shares destination-address checks and credential-output filtering
with the JSON connector. The JSON tool's Doppler/approval contract is unchanged;
forge requests use the existing project/container capability and GitHub
installation-token resolver.

The legacy token endpoint no longer issues credentials. Sandbox helpers require
proxy configuration and never fall back to token redemption. Live compatibility
acceptance remains incomplete; removal alone does not establish global token
freedom across every deployment backend.

## Staging rollout

The brokered transport is enabled by default for GitHub project sandboxes. There
is no project opt-in setting or Docker Compose environment switch. The internal
`proxy-test` mode identifies this migration stage; it is not a user toggle.

1. Deploy server and digest-pinned project-relay images built from this change,
   together with the updated agent seed/toolkit. An older relay rejects CONNECT.
2. Recreate project sandboxes through the normal
   project lifecycle. Updating the server alone does not rewrite existing
   sandbox environments or relay generations. Finish active sessions first.
3. Verify GitHub sandboxes have `VERITY_FORGE_MODE=proxy-test`,
   `VERITY_FORGE_PROXY_URL`, and the read-only public CA at
   `/run/verity/forge-proxy/ca.crt`. Git uses the proxy with certificate
   verification; gh receives only a `verity-broker-` capability placeholder.
4. Test clone/fetch/push and the supported issue/PR workflows on staging before
   rolling out the images to production. A proxy error must remain visible.

Non-GitHub projects and trusted host-side operations retain their existing paths.
To roll back a staging failure, deploy the previous images and recreate affected
sandbox generations. This restores the previous security boundary as well;
there is no configuration switch back to token redemption.

The trusted server persists its private CA at
`<secretMaterializationRoot>/forge-proxy` (directory 0700, files 0600). Only the
public CA is copied to `secrets/git/forge_proxy_ca.<projectId>.crt` and mounted in
sandboxes. Keep the server identity across restarts; missing half an identity,
invalid keys, expired CAs, or unsafe permissions fail closed. Leaf certificates
are renewed on server restart and are valid for 90 days. Restart before expiry.
Never mount the private identity directory in a sandbox.

## Initial compatibility boundary

The adapter accepts only `github.com:443` and `api.github.com:443`. It checks the
raw request target, the server-bound repository, and permitted action before
forwarding. GraphQL mutation entity IDs are resolved server-side against GitHub
and checked for both entity type and repository membership. Scoped node reads
for PR merge text receive the same check. No upstream redirect is followed or
passed to the client, and compressed responses are rejected rather than bypass
credential-output checks.

The GitHub sandbox policy permits Git read/write, issue read/write, and PR
read/write, plus repository-bound Release and Actions metadata reads. Release
and artifact downloads through redirects, workflow dispatch, and Release writes
remain unsupported. Policy denials return HTTP 403; upstream transport failures
return HTTP 502. The adapter also supports narrower action sets for future policy
integration. The GitHub Issues REST API contains PRs too, so those routes
conservatively require the corresponding PR authority as well. This stage does
not add an action-policy settings UI.

Supported starting workflows:

- Git HTTPS clone, fetch, and push using Smart HTTP, including binary packfiles
  larger than the JSON broker envelope.
- Basic gh issue/PR view and list using repository-scoped GraphQL queries.
- Basic issue/PR creation, editing, closing, reopening, and comments through the
  admitted mutations or repository REST routes.
- Direct PR merge; the merge-text node read is repository-verified. Narrow schema
  field-name probes for PullRequest, StatusCheckRollupContextConnection, and
  WorkflowRun support gh compatibility; other introspection is rejected.
- `gh api` for the admitted repository metadata, branches/commits/compare,
  issue/comment, and pull-request routes and admitted GraphQL envelopes.

Cross-repository forks, arbitrary GraphQL search, actor/label/project assignment
mutations, releases, Actions APIs, merge queues/auto-merge, and unrecognized
operations are not admitted. Adding them requires explicit provider rules and
compatibility tests. The helper produces an error when its proxy/CA/capability
configuration is missing; Git's interactive credential fallback is disabled.

Control-plane host-side Git operations remain trusted server operations and are
not redirected by this setting. Docker-backed sessions run in the shared project container and use its
mode and public CA. Docker token redemption has been removed.

## Verification and final migration

The automated TLS tests run real Git and gh clients against controlled upstream
fixtures. Git tests use `git http-backend` and a 2 MiB random binary object. They
verify token injection at the upstream hop, output/configuration isolation, and
repository/generation/action rejection. Relay tests separately verify the
project-socket tunnel, streaming beyond the HTTP tool limits, and default-off
CONNECT handling. Both shipped helper distributions are tested.

These tests do not replace staging evaluation against GitHub's live API and all
supported deployment backends. Treat unknown-call rejections as compatibility
findings, never as grounds to switch a failing test-mode client to a real token.
Credential filtering detects the broker's known raw/encoded credential forms;
as with the existing HTTP JSON broker, a colluding upstream can transform a
credential in ways no general output filter can recognize. The provider host
and TLS identity are therefore part of the trust boundary.

Complete live evaluation and verify token absence across all deployment backends
before closing #1198. Token issuance and helper fallbacks have been removed.

GitLab and Forgejo are future adapters, not implemented here. The common proxy
uses provider-owned host sets, request-stream classification, authorization, and
credential resolution. A new adapter must define trusted instance addresses,
authentication and API/action rules; its CLI and self-hosted destinations need
separate tests. The relay target admission and certificate SANs must be extended
alongside that adapter.

## Extended workflow compatibility

See [Forge broker compatibility](forge-broker-compatibility.md) for Checks,
Actions writes, Release transfers, repository file operations and scoped GHCR
image reads. The compatibility matrix separates local test coverage from the
remaining deployment acceptance.

## Token issuance removal

Sandbox GitHub clients now require the forge proxy configuration and return only
capability placeholders. The legacy token endpoint no longer mints credentials;
its relay and internal-listener routes are removed. There is no token fallback.
Deploy the server, relay and toolkit together and recreate existing project
containers to replace old helpers and environment settings. GitHub access fails
closed when proxy configuration is missing. Full live compatibility acceptance,
including private GHCR and real ORAS, remains required.
