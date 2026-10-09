# Security review

Reviewed revision: `e04389c5694f314b178e27de43be7d61ae78b66f`.

Scope: project isolation, sandbox toolkit, secret brokerage, Uplink and remote-control transport, and public previews. Four reviewers inspected source and selected tests. This is a source review, not a production penetration test or a security certification. No production credentials were retrieved and no live isolation escape was attempted. The findings below describe the reviewed revision; the subsequent fixes are described in the remediation section.

## Remediation

All three findings have implementation changes in this working tree:

- Repository volume sources are now logical aliases mapped to names derived from project ID and alias. Supplying an existing Docker volume name cannot select that resource.
- Devcontainer builds consume a private project snapshot. Directory descriptors, no-follow opens and opened-file identity checks prevent filesystem replacements from redirecting the copy outside the project. The CLI receives an explicit validated config path, a private home/Docker config and no ambient server environment. Build policy versioning invalidates images cached under the old policy.
- Stream tickets bind to a paired device. Revocation, logout/forget and registry clearing invalidate pending tickets and close that device's existing event streams. Other devices remain connected.

Compatibility and rollout:

- Previously configured named volumes are retained, but new containers use project-scoped volumes. Existing data is not automatically migrated. Recreate disposable caches as needed; migrate persistent development data deliberately through a trusted administrative process.
- Repository-relative Dockerfiles and contexts, including `..` within the repository, remain supported. Compose builds, arbitrary build options, cache imports, host environment substitutions and project-declared Features are rejected. The server-injected Node and Verity toolkit Features remain enabled; additional tools can be installed in the Dockerfile. Project-declared Features are rejected because the CLI processes their dependency metadata and host cache paths outside the primary config validation.
- Snapshot inputs are limited to 2 GiB and 200,000 entries, with small copy buffers and cooperative event-loop yielding. The copy includes all repository entries, including `.git` and dependencies. Relative symlinks must resolve within the snapshot; absolute, escaping and dangling links are rejected. Linux `/proc` is required.
- These are source changes, not a deployment. Existing running containers are not retroactively remounted; applying the new volume policy requires container recreation after deployment. Existing old volume data is not deleted by this change.

Regression coverage includes forbidden shared-volume names, project-separated aliases, build rejection before cache/execution, normal repository build contexts, snapshot isolation, secret-free builder environment, and actual WebSocket revocation. Volume tests failed against the old mount behavior; disabling snapshot validation or stream closure also caused the respective new guards to fail.

Remediation verification: 914 tests passed across the complete provisioner, build-boundary, server, auth and pairing-route suites; the additional gateway suite passed all 31 tests after its auth test double was updated. The root TypeScript build passed, as did ESLint and Prettier for the changed files. No live Docker/hosted-service deployment was exercised.

The full root suite ran before publication: 8,763 tests passed, 25 were skipped and three failed. The gateway test-double failure was fixed and its entire suite rerun successfully. Two failures in unchanged code reproduced separately: the self-update large-catalogue test exceeded 20 seconds, and the reference-document directory-symlink test failed because this runtime follows directory links despite `O_NOFOLLOW`. The new build snapshot additionally compares opened-file identities and explicitly rejects a symlinked project root; its regression was observed failing before that correction and passes afterward. The unrelated existing failures are disclosed rather than hidden or expanded into this change.

## Findings

### 1. Critical: repository configuration can mount shared Docker volumes

`packages/server/src/provisioner.ts:1155` accepts an arbitrary syntactically valid Docker volume name from devcontainer `mounts`. The target is restricted to `/work`, but the source is not restricted to project-owned storage. The mount passes through `provisioner.ts:5317`, `partitionProjectMounts` at `provisioner.ts:2092`, and Docker `HostConfig.Binds` at `packages/server/src/docker.ts:1141`.

A repository configuration can request `source=verity-data,target=/work/stolen,type=volume`. The reference deployment names and mounts that shared volume at `deploy/docker-compose.yml:170` and `:316`. Using UID 1000 matches the reference server account that owns `/srv/verity` (`deploy/Dockerfile:389`), allowing access under ordinary Unix permissions. This exposes shared project/control-plane files to the container, potentially writable; gVisor cannot protect files intentionally mounted into its filesystem. Root alone would not bypass all permissions because capabilities are dropped. Supervisor attestation does not validate mount sources; its failure disables the supervisor and adds a warning rather than aborting provisioning (`provisioner.ts:4870`).

Prerequisites: control of the devcontainer configuration, a provision/rebuild that applies it, and knowledge of the volume name. This is not an unauthenticated internet attack.

Validation: evaluated the actual mount parser in isolation. It returned `verity-data:/work/stolen` and also accepted an unrelated project's named volume. No real volume was mounted. The reference deployment uses the raw Docker socket; the resource-aware policy gateway is explicitly not implemented (`deploy/docker-compose.yml:301`, `:712`).

Remediation: translate logical repository volume requests into server-generated project-owned names. Reject direct references to arbitrary existing Docker volumes. Blocking only the shared data volume would leave cross-project volume access possible.

### 2. High: repository builds can consume server files outside the project

`packages/server/src/provisioner.ts:872` detects build inputs outside the devcontainer directory, including arbitrary `build.options`, but the result only disables image cache reuse (`:5872`). The build still executes through the server-side devcontainer CLI (`:439`) with the server environment and filesystem access.

A devcontainer can select a build context such as `/srv/verity`, then use its Dockerfile to copy server-readable files from other projects or secret-related state into the resulting image. Build options provide additional file-input mechanisms. The normal repository context `..` is legitimate; the defect is the absence of an enforced project boundary.

Prerequisites: an attacker-controlled devcontainer is built by the server and the selected files are readable by the server account. Impact includes disclosure through the resulting image and build output.

Validation: traced configuration acceptance, cache decision and build invocation. No live Docker build or secret read was performed.

Remediation: execute builds with a filesystem view containing only the authorized repository and narrowly supplied build credentials. Validate resolved context, Dockerfile, local features, compose inputs and additional options against that boundary. A check limited to the primary context string is insufficient.

### 3. High: device revocation does not revoke existing session event streams

Stream tickets retain only session ID and expiry (`packages/server/src/server.ts:3037`); they do not retain the issuing device identity. The WebSocket route checks the ticket once, then subscribes to session events without further authorization checks (`:10210`, `:10243`). Device deletion invokes token revocation (`packages/server/src/pairing-routes.ts:172`), which removes token lookup entries but does not invalidate tickets or close associated sockets (`packages/server/src/auth.ts:220`).

A previously authorized device can therefore retain access to future events from an already open session stream after revocation. An unconsumed ticket also remains usable during its 30-second validity window. The demonstrated source path is the local paired-device event API; remote transport may impose additional admission termination, which was not established end to end.

Validation: source-level trace of ticket creation, consumption, subscription and device revocation. No end-to-end revocation reproduction was completed. This finding does not establish continued access to authenticated command endpoints.

Remediation: bind tickets and active streams to a revocable device/principal identity, invalidate outstanding tickets on revocation, and close that identity's active sockets. Add regression coverage for revocation both before ticket consumption and after stream establishment.

## Other reviewed boundaries

- Secret broker: no additional confirmed exploit in the inspected grant, HTTP, JWT and gateway-token paths. DNS validation is tied to the actual HTTPS socket; grants and gateway tokens are rechecked. Optional secret workers use a digest-bound gVisor image with no network and restricted privileges. This does not compensate for control-plane filesystem exposure through findings 1–2.
- Trusted CLI: an approved command intentionally receives plaintext secrets and can disclose them. Redaction is not protection against intentional exfiltration (`packages/secret-contracts/src/tool.ts:518`). Static HTTP grants authorize alias plus host rather than individual methods/paths (`packages/session/src/brokered-grants.ts:127`). These are existing authorization semantics, not new defects.
- Sandbox toolkit: inspected namespace/Landlock implementation, broker script pinning, relay allowlists and generation-specific socket mounts. Large broker/supervisor scripts were not exhaustively audited. No live kernel/gVisor escape testing was performed.
- Preview: inspected PIN budgets, expiry, connector authentication, bounded streams, fixed target origin, header filtering and static file confinement. Selected tests passed; no additional confirmed preview-specific exploit was found. Network/volume eligibility checks are present when creating a share.
- Uplink/remote control: inspected TLS requirements, client pinning, stream sequencing, resource bounds and authority-loss cleanup. The hosted admission, brokerage and managed service implementation is outside this repository, so its replay prevention, revocation and production configuration cannot be certified here.

## Verification and limitations

- Preview: 91 tests passed across `index.test.ts`, `static-server.test.ts`, and `pin-budget.test.ts`.
- Secret broker: 111 tests passed across `restricted-http-json-connector`, `brokered-jwt`, and `mcp-gateway-tokens` suites.
- Uplink/remote-control reviewer reported 125 passing connector/control tests.
- Tests used one worker per invocation and default Node heap settings. Passing tests do not negate findings in uncovered paths.
- The original review did not run a full monorepo suite, dependency/CVE audit, production configuration audit, live Docker build, or live hosted Uplink test. Remediation likewise does not establish production or hosted-service security.

Validate the hardened deployment and hosted-service behavior in their own environments before treating this source review as operational assurance.
