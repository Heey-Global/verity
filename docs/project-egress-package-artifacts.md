# Experimental package artifact broker

Status: implementation increment, not protected-install acceptance. Native
manager installation, frozen lockfile reuse and receiver-side isolation still
require proof on the supported protected runtime. Other package ecosystems and
custom registries remain unavailable through this adapter. This document does
not authorize installation or activation on an existing host.

The existing `/internal/package-install` endpoint decides dependency release-delay
setup; it is not an artifact transport permission. Its delayed decisions are now
rechecked against the original project capability and listener generation.

## Read-only registry paths

`package-artifact-routes.ts` registers `/internal/package-artifacts/*` behind the
project Unix listener and relay. Every operation requires the socket's project
and generation, its live capability, and its generation cancellation signal.
Capability checks have a one-second lookup deadline; revocation polling aborts
rather than waiting indefinitely on a stalled lookup. No caller header supplies
a provider URL or a project identity.

| Path | Provider operation |
| --- | --- |
| `GET`/automatic `HEAD` `npm/<package>` | Bounded JSON metadata from `registry.npmjs.org` |
| `GET`/automatic `HEAD` `npm/<package>/-/<filename>.tgz` | Existing npm lockfile path; re-resolve metadata and verify strong content integrity |
| `GET`/automatic `HEAD` `pypi/simple/<name>/` | PEP 691 JSON metadata from `pypi.org` |
| `GET`/automatic `HEAD` `file/<ecosystem>/<package-selector>/<algorithm>/<digest>/<filename>` | Re-resolve provider metadata and download only its matching artifact |
| `POST` `npm/-/npm/v1/security/advisories/bulk` | Schema-validated public npm advisory lookup; no registry writes |

Artifact references encode public package coordinates and strong content hashes,
not authority or an arbitrary URL. Downloads re-fetch fixed-origin metadata and
verify exact filename and SHA256/SHA512 before returning bytes. The fixed
`verity-package-broker` alias is provisioned to the current relay so stored URLs
do not depend on a particular generation's container name or a process-local
ticket. Authorization is independently checked again for the current connection.

Metadata is limited to 2 MiB, artifacts to 32 MiB and simultaneous broker
responses to two, including buffered downloads until the client finishes. A third
request receives HTTP 429. Revocation aborts slow client transfers; loopback TCP
fixtures cover backpressure and cancellation, not protected-runtime isolation. Oversized packages and npm releases with only SHA1 integrity
are unavailable. Redirects stay within the selected fixed provider/path class;
private DNS answers, caller credentials, arbitrary methods, range requests and
arbitrary URL forwarding are rejected. npm audit retains its fixed read operation
with 64 KiB compressed and expanded request bounds; publishing is not supported.

## Toolkit selection

Protected provisioning projects `VERITY_PACKAGE_ARTIFACT_URL`; unprotected
provisioning leaves existing package-manager configuration unchanged. The toolkit
selects the broker for npm/pnpm/Bun-compatible registry operations, Yarn registry
reads, and pip/uv index reads. It retains existing release-age settings and does
not disable lifecycle scripts or npm advisory checks. npm-compatible credentials
are scoped to the broker path in a private temporary user configuration, removed
when the wrapper exits. Repository configuration is not rewritten. Extra/custom
registries do not gain an external network exception.

These configuration paths require actual native-client acceptance; unit tests of
environment variables do not establish that every manager/version honors them.
In particular, prove authenticated metadata and artifact downloads, native audit,
package age rejection, repeated/frozen installs after broker restart and container
replacement, and scripts attempting an unauthorized destination. Test Cargo, Go,
Maven/Gradle, NuGet, RubyGems/Bundler and Composer only after their own constrained
adapters exist; the current npm/PyPI implementation does not cover them.

## Evidence boundary

Scoped tests cover wrong project/generation, retired or wedged authority,
metadata/redirect bounds, foreign provider URLs, strong digest rejection,
stable selector reuse across broker reconstruction, advisory input limits and
read-only relay admission. Deliberately removing artifact digest verification
makes the corrupted-download guard fail. These are unit/integration controls;
the final gVisor, boot and deadline workflows and independent receiver evidence
remain separate gates. Protected previews are also unavailable until their own
attested ingress adapter is implemented.

`package-artifact-native.test.ts` additionally runs installed npm and pip against
loopback HTTP fixtures with synthetic provider responses. npm install preserves
audit and the three-day release floor; frozen `npm ci` re-fetches the archive
after broker reconstruction with a fresh cache and an unchanged lockfile.
The npm test also installs from an unchanged lockfile containing ordinary
`registry.npmjs.org` tarball URLs generated before broker activation. pip
downloads a synthetic wheel and reuses its selector after broker reconstruction.
These tests do not exercise the project relay, Docker, kernel enforcement or
container replacement and do not establish support for other package managers.

Relevant native configuration references: [Bun npmrc support](https://bun.sh/docs/pm/npmrc)
and [Yarn registry configuration](https://yarnpkg.com/configuration/yarnrc).
