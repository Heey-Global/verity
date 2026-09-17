# Public release stabilization

Public stable release requires evidence from the installed product, in addition
to component tests. Work through these gates in order; a passing unit suite does
not close an installation or deployed-runtime gate.

## 1. Contain secret output

- Mask both base64 transport values and decoded file credentials in trusted CLI
  stdout and stderr.
- Exercise the production supervisor client, live worker authorization, broker
  file materialization, output redaction, and file cleanup together.
- Prove the regression test fails without the repair. Include Unicode contents.
- Ship the repaired toolkit and verify the affected sandbox actually uses it.
  A local source repair alone does not repair an existing deployment.

## 2. Resolve the deployed trusted CLI refusal

PR #388 adds diagnostics; it does not establish the cause of the deployed refusal.
Obtain the sanitized refusal from an affected invocation with that diagnostic
available, plus the backend, capability flag and worker lifecycle state. Never
dump the persisted request: it can contain credentials and prompts.

| Refusal | Investigation |
| --- | --- |
| `trusted CLI is unavailable for this turn` | Persisted turn permission, identity and working directory |
| `trusted CLI turn capability is no longer active` | Worker ownership, recovery and cancellation |
| `invalid trusted CLI request` | Payload validation and protocol compatibility |
| `runner worker is not installed` | Installed supervisor execution handler |

Exit criterion: a supported live ACP turn executes an authorized CLI with env and
file secrets, returns masked output, and rejects execution after cancellation.
Reproduce any discovered defect in a regression test before repairing it.

## 3. Accept a fresh managed installation

The current `deploy/bin/verity-clean-install-smoke` exercises legacy Compose and
stops at sealed onboarding. Preserve its useful coverage, but do not count it as
managed first-use acceptance.

Reuse the isolated daemon checks and local registry/digest fixture from
`deploy/bin/verity-self-update-live-smoke`. The production managed installer
requires an official digest; do not weaken that validation to accommodate a
local test tag. Run the candidate image's actual bundled installer against empty
state instead of reconstructing its initialization manually.

Required assertions:

1. Sealed first-run state is correct; initialization and device authorization work.
2. Managed Server, Gateway and control Runner become ready.
3. The control project exists before its Runner identity is registered; the
   actual Server UID can create and remove a project runtime directory.
4. An authenticated session produces a deterministic provider response with
   Unicode intact, and a secret-backed CLI operation succeeds without leaking
   credentials into returned output.
5. Restart, unlock and reuse succeed. A repair install preserves identity and data.
6. Removing managed volume initialization or breaking project/identity startup
   ordering makes this acceptance test fail.

The CI `server-image` job runs `deploy/bin/verity-managed-install-smoke` on its
isolated daemon. After first use and restart, the smoke removes the Gateway and
stops the Server, reruns the bundled installer in its default repair mode, and
checks the original deployment identity, device authorization, settings, transcript
and a new turn. Private installer logs and identity snapshots stay inside that
disposable host. This is repair coverage, not a destructive `--reinstall` test.
Before and after repair, an installed-broker fixture uses synthetic credentials
and the production privilege drop to check overlapping file reads and cleanup
after success and child termination. The fixture seeds isolated turn metadata;
it does not replace end-to-end worker capability/revocation acceptance.

This needs Docker and Compose, disposable privileged DinD, the pinned gVisor
runtime, a local registry, candidate images and adequate serialized resource
capacity. The current development sandbox has no Docker CLI. Validation must run
in a suitable isolated environment; host installation is not an acceptable
substitute. Use synthetic credentials and deterministic provider fixtures.

## 4. Verify update and mobile continuity

Reuse the existing live update/rollback matrix after managed first-use passes.
After updating, verify session reuse and a secret-backed operation against the
exact released server/toolkit/sandbox combination. Cover every advertised host
architecture.

On a real mobile build, verify pairing, onboarding, first session, cold unlock,
reconnect and continued session use. Existing mocked component tests and native
compilation do not establish this full journey.

## Release decision

Record the artifact versions, environment, test results and remaining blockers
for each gate. Keep unrelated feature work and broad refactors out of these
repairs. Do not declare public stable readiness while a gate is unverified.
