# Session egress namespace experiment

This is a disposable local experiment, not a production network policy.
It builds on the authorization contract merged in PR #1980. Run only on an
isolated test machine/container. It uses loopback TCP/UDP receivers and synthetic
DNS packets; it never contacts a provider, registry or public endpoint.

## Run locally

Requirements: Linux, Python 3, util-linux `unshare`; npm is optional for the
local package-script control. No installation or image pull is performed.

```sh
TMPDIR=/work timeout 90 python3 scripts/egress-experiment/probe.py --output /work/egress-result.json
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/egress-experiment -p 'test_*.py' -v
TMPDIR=/work npx --no-install vitest run --maxWorkers=1 scripts/egress-experiment.test.ts
```

The command creates exactly two concurrent session fixtures per phase. The
baseline runs in the parent network namespace; the isolated phase uses separate
user, network, PID and mount namespaces, with a fresh `/proc`. Both sessions
retain the same numeric user ID and share the fixture directory. Each child
inherits a distinct broker channel. The external-to-child controller associates
that channel with a session and generation; request labels cannot change it.
The prototype broker forwards only to one fixed synthetic TCP destination.

The receiving thread runs outside both child namespaces and records unique
payload markers independently of the client response. Tests cover IPv4/IPv6
TCP, UDP and synthetic DNS queries, shell children, an offline npm script, and
a minimal local MCP stdio tool child. This is not a complete MCP server or a
real package installation. Baseline positive controls and final receiver
controls distinguish denial from broken test infrastructure. UDP success is
not claimed as QUIC coverage.

The broker exercises deny-all, A-only, forged B labels, explicit B positive
control, generation rotation, policy reset, unavailability and thread shutdown.
Revocation closes the upstream TCP stream; the receiver must observe EOF within
the predeclared two-second experiment threshold. This is a fixture measurement,
not a product SLA. A thread stop or policy reset is not a real host supervisor
crash/restart.

## How to interpret results

Exit 0 means the experiment completed, **not** that isolation passed. Inspect
all `cases`, positive controls and `protectedEgressReady` (always false for this
limited fixture). Exit 2 means the namespace preflight was unavailable. Other
errors or missing output are failed/incomplete runs, never successful denial.

The two deliberately injected descriptor cases are expected to reveal limits:

- B inherits an already connected socket from before entering its namespace.
- A controlled fixture transfers a connected socket through a shared filesystem
  Unix socket using `SCM_RIGHTS` after B has entered its namespace.

Both cases ask whether network namespaces alone revoke those capabilities.
They **do not** prove B can steal an arbitrary real session's descriptors without
such exposure. The transfer sender is controlled by the test. The common file
marker demonstrates why writable shared identity state is not authoritative.
The `/proc` attempt targets only the controller's own namespace handle; denial
of that single attempt is not proof against every process-access technique.

The controller remains in the same outer container and user trust domain. It is
not claimed to be protected from arbitrary malicious session code. Its channel
policy is a functional prototype, not a complete external authorization boundary.
No proxy environment variable is treated as a security control.

## Observed local result

On merged baseline `eba0bae98` the unprivileged combined namespace preflight
succeeded, preserving UID 1000. The baseline fixtures shared the parent's network
namespace and saw loopback plus eth0; isolated fixtures had distinct network
namespaces with only loopback. These observations do not attest the host's
runtime implementation or version.

The completed run records 53 cases:

| Result                                                       | Count | Interpretation                                                                                     |
| ------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| Expected observation                                         | 45    | Baseline connectivity, denied direct paths, broker identity/lifecycle checks and receiver controls |
| Boundary violation in intentionally exposed capability cases | 2     | Inherited and transferred network descriptors still transmit                                       |
| Shared-state observation                                     | 1     | Shared fixture file remains readable                                                               |
| Single blocked process-access attempt                        | 1     | Parent namespace handle unavailable through the isolated `/proc`                                   |
| Not run                                                      | 4     | QUIC, separate-container comparison, attested gVisor/runc matrix, real supervisor restart          |

All direct isolated TCP/UDP/DNS probes produced no marker at the receiving
endpoint; UDP clients could still report successful sends, illustrating why
client return codes are insufficient. Both injected descriptor cases delivered
their markers despite network namespace isolation. The broker's receiver-observed
stream shutdown met the two-second test threshold. These are local capability
observations, not proof that all external routing or DNS paths are blocked.

Five Python harness tests pass through one Vitest integration test. Removing the
broker identity permission check caused identity/revocation tests to fail;
dropping received data from the observer caused its positive control to fail.
Both mutations were restored. The focused TypeScript wrapper check, ESLint,
Bash syntax check and Python syntax compilation are the applicable static checks.
The broad `scripts/tsconfig.json` check also encounters errors outside this
change (including toolkit JavaScript and store-dependent server types); no
full scripts typecheck success is claimed.

## Reproduce on an isolated runtime host

The current environment has no Docker CLI, `runsc`, `runc` or standard Docker
socket. The host runtime matrix and a comparison using separate containers
therefore remain unexecuted. A suitable test host must supply a registered
runtime and an **existing** image containing Python, unshare and optionally npm.
Run the checked-in launcher separately for each installed runtime:

```sh
bash scripts/egress-experiment/run-container.sh <runtime-name> <existing-image> <new-output-directory>
```

The launcher records image identity, registered runtimes, the fixture launch
profile and results, enforces a 90-second timeout, and removes only its own
container. It neither pulls images nor mounts the Docker socket. Its outer
container has no network, drops capabilities, uses no-new-privileges and has
explicit CPU/memory/PID limits. This permits testing nested namespace capability
and local cross-namespace delivery without permitting public egress. A denial
by the outer runtime/seccomp profile is an unavailable test, not secure session
isolation.

This reduced launch profile is **not automatically production-equivalent**.
Before treating its result as a deployment decision, compare it with the actual
launcher configuration in `packages/server/src/docker.ts` and the runtime
registration/version on the test host. Do not relax production capabilities or
security profiles to make a fixture pass. A full separate-container comparison,
real external bridge/receiver tests and full supervisor lifecycle tests require
additional host fixtures; they are not silently supplied by this launcher.

## Decision and possible simplification

Network namespaces are locally feasible, but session-level permission still
requires descriptor sanitization, protected IPC/process/mount boundaries and a
supervisor outside the adversary's trust domain. Do not enable protected session
egress on the strength of this experiment.

Project-level egress is a distinct, potentially simpler product scope: all
sessions and background processes of a project share the allowed network
destinations. It removes the need to separate network grants between sessions
inside that project, including the injected intra-project descriptor cases.
It does not remove cross-project isolation, control-plane/private-destination
restrictions, DNS/IPv6/UDP coverage, revocation, or server-side connector work.
Account, secret and action permissions remain independent. Selecting this scope
requires an explicit product decision; this experiment does not change it.

If project-level scope is selected, the next bounded proof should place the
receiver outside the project boundary and compare an allowed project A with a
denied project B. Prove the external fence on the actual supported runtime before
building approval UI or changing live networking. Session isolation remains a
separate requirement only if session-specific network permissions are retained.
