# Recreate project containers for OpenCode brokered tools

ADR 0014 Amendment 4 admitted `opencode-acp` to the brokered Verity tools. The
Server now mints a per-turn MCP gateway bearer for every OpenCode turn. A project
container provisioned before that release carries a supervisor whose
`ACP_WORKER_BACKENDS` predates the decision, and it refuses that bearer.

The refusal is correct — the old boundary fails closed — but it is not
recoverable at runtime: **every OpenCode turn** in such a project fails at
start-turn. Claude and Codex sessions in the same project are unaffected, as are
OpenCode sessions on a container created after the release.

Turns with no session to attribute to (`sessionId: null` — the ephemeral/meta-
query path) are **not** exempt. They mint no bearer, so they clear the bearer
gate, but the same stale backend list gates `trustedCliExecution`, which the
Server sends for every ACP turn regardless, and they are refused there instead.

## Plan it: deploy the Server, then recreate, in that order

This page exists for containers that were missed — but on this release *every*
project running OpenCode needs the refresh, so plan it with the deploy instead of
discovering it per project.

The tempting order is the wrong one. Recreating the containers FIRST, on the
toolkit release that admits OpenCode, would indeed leave a supervisor an old
Server is happy with: both supervisor gates fire on a field being PRESENT, and an
old Server sends neither `mcpGatewayToken` nor `trustedCliExecution` for OpenCode.
It breaks on the other side. The still-running Server attests each Sandbox against
the ledger in its OWN bundle (`published-hashes.json`, ADR 0006 D9), and a toolkit
published after that Server's release is not in it — nor does the old Server even
install it by default, since it pins the toolkit Feature to its own bundled
version. Force the newer toolkit in and the attestation fails, which disables the
Runner supervisor for the WHOLE container:

```
Runner supervisor is disabled for this Sandbox because the ADR 0006 boundary
attestation failed: …
```

That trades a failure confined to OpenCode for one that takes Claude and Codex
sessions in the same project down with it. So:

1. Deploy the Server that admits OpenCode. It ships the matching toolkit.
2. Recreate the project containers of every project running OpenCode sessions,
   by the procedure in "Recover" below.

Between the two steps, OpenCode turns in not-yet-recreated projects fail at
start-turn with the messages under "Recognize it"; Claude and Codex are
unaffected, and are the workaround for the duration. There is no flag to withhold
the bearer in the meantime — by decision, recorded in ADR 0014 Amendment 4 under
Consequences — so keeping that window short is the whole mitigation. It travels
with the release rather than only with this page: the change ships as a breaking
one, whose `BREAKING CHANGE:` footer Release Please renders into `CHANGELOG.md`
(see "Changes that require operator action" in `docs/releases.md`).

## Recognize it

The turn fails to start with a message containing one of:

```
invalid mcpGatewayToken — this Sandbox predates OpenCode's admission to the
brokered Verity tools (ADR 0014 Amendment 4) …

invalid trustedCliExecution — this Sandbox predates OpenCode's admission to the
brokered Verity tools (ADR 0014 Amendment 4) …
```

Which of the two you see depends only on which gate the old supervisor reached
first; the cause and the remedy are the same. That sentence is the Server's own
diagnosis
(`explainStaleGatewayRefusal`, `packages/session/src/runner-supervisor-client.ts`),
and it is specific, because those bare words are not specific at all. A CURRENT
supervisor answers `invalid mcpGatewayToken` for two further reasons of its own —
a bearer that is empty, and one over the 512-byte limit — and both are Server
composition defects rather than stale containers. The Server tells them apart
itself, on any backend, since it minted the bearer and knows what it sent:

```
invalid mcpGatewayToken — the Server sent a malformed MCP gateway bearer for
this turn (empty) … This is a Server composition defect …

invalid mcpGatewayToken — the Server sent a malformed MCP gateway bearer for
this turn (713 bytes, over the 512-byte limit) … This is a Server composition
defect …
```

Neither of those is this runbook's: do not recreate a container for a
`Server composition defect` message, since nothing about reprovisioning changes
it. Match on that phrase, not on the words before it.

A third message is not this runbook's either, and it is new with the same
release, so it is worth recognizing by sight:

```
the Server was composed without mcpGatewayTokens; a brokered-tool ACP turn
cannot start without the per-turn gateway bearer registry
```

That is a Server assembled without the bearer registry at all. Before this
release such a deployment started OpenCode turns tool-less and silent; it now
refuses them, which is the same fail-closed direction and equally unrelated to
container age. The fix is in the Server's composition — no container is wrong.

## Recover

**The project worktree survives this.** `/work` is not container storage — it is
the Server's own per-project clone, mounted read-write so sessions can commit
(`provisioner.ts`). With a data volume configured it is a named-volume mount with
a subpath; without one it is a host bind of the same clone path. Either way the
source is Server-owned storage outside the container, so recreating the container
replaces the container only: the clone, including uncommitted changes and session
worktrees, is remounted as it was. What is lost is process state — anything
running in the container at the time stops.

Before recreating, so that "process state only" is all you lose:

1. Stop or finish the project's running turns. A turn killed mid-write leaves the
   worktree as it stood, not as it would have been.
2. Commit or note any uncommitted work in the affected worktrees. This is not
   required for the mount to survive; it is what makes step 1's outcome legible
   afterwards.
3. Confirm the session you are diagnosing really shows a message from "Recognize
   it" above, and not the `Server composition defect` one.

Then recreate the project container through Verity:

```
POST /concierge/projects/<projectId>/recreate-container
```

Authenticated like every other Server API call — `Authorization: Bearer <token>`
— wherever the token gate is enabled. A `401` here is that gate, not this fault;
a `503` means the deployment has no container recreation wired at all.

That is the supported path, and the only one this runbook asks for. It replaces
the container from the current toolkit and re-attaches the same project mounts
(`recreateContainer`, `packages/server/src/provisioner.ts`). The replacement
attests normally: a container built from the toolkit this Server ships matches the
Server's own bundle, which ADR 0006 D9 accepts directly, so nothing has to be
published or regenerated for the recreated container to be admitted.

### Confirm it took

Recreating from a toolkit that is not actually current reproduces the identical
failure, and nothing in the message distinguishes "the recreation did not take"
from "the recreation did not help". Nothing the Server can ask separates them
either — the status handshake carries `protocolVersion` and `runnerInstanceId`,
and no boundary-binary version — so read the binary that decides:

```
docker exec <container> grep -c "ACP_WORKER_BACKENDS.*'opencode-acp'" /usr/local/bin/verity-runner-supervisor
```

Read the ADMISSION list, not the file. A stale supervisor mentions `opencode-acp`
in several places already — it has spawned OpenCode workers since ADR 0012
Amendment 4 — so a bare `grep -c opencode-acp` answers non-zero on exactly the
container this check exists to catch. `ACP_WORKER_BACKENDS` is the one list that
changed.

The pattern is line-anchored, like every `grep` pattern, and the declaration it
reads is one line today. Reformat that declaration — or add a fourth member, and
let Prettier wrap the set — and the command starts answering `0` for a container
that is perfectly current, which is this check's own failure direction inverted.
`runner-supervisor-feature.test.ts` runs the command out of this page against
both a current and a doctored supervisor, so that break surfaces in CI rather
than here; the command must be edited with the declaration, not after an
operator reports it.

`0` means the container is still running a supervisor from before this release:
the recreation did not take, and recreating again from the same toolkit will not
change it. Check which toolkit the provisioner installed before repeating the
step. `1` means the boundary admits OpenCode, and the next OpenCode turn is the
authoritative confirmation.

**Do not reach for a volume-removing teardown.** `docker compose down -v`,
`docker rm -v`, or removing the Verity data volume by hand destroys the storage
`/work` is served from — the clone, its uncommitted changes, and every session
worktree. The survival described above is survival of container replacement, not
of volume deletion. Nothing in this failure calls for touching the volume.

There is no in-place fix: the supervisor is a boundary binary shipped with
`verity-sandbox-toolkit` and attested by ADR 0006 D9, so it is replaced by
reprovisioning, not by updating the Server.

Until the container is recreated, run affected sessions on Claude or Codex.

## The control-plane Runner needs the same refresh, for a different reason

Everything above is about project containers. The dedicated control-plane Runner
— the one that serves sessions with no project of their own, and sessions whose
project IS the control plane — is a separate container with its own upgrade step,
added by ADR 0012 Amendment 6, which admits OpenCode to control-plane turns.

It is not a Sandbox the provisioner composes. It runs the **Server image**, and it
is created once with its mounts and environment fixed in its spec, so neither
piece arrives by recreating a project container:

- the image has to contain `/usr/local/bin/opencode-acp` (the broker refuses the
  name `opencode`), which is new to the Server image with this release;
- the container spec has to carry the `secrets/opencode` mount at
  `/run/verity/opencode-config`, `OPENCODE_CONFIG`, and `XDG_CONFIG_HOME`.

**Order: deploy the Server image first, then recreate the Runner.** A Runner
recreated from an older image starts normally and refuses every OpenCode turn at
the spawn broker, because the wrapper is not in it. A Runner never recreated runs
OpenCode without its configuration. Claude and Codex control-plane turns are
unaffected by either, and are the workaround for the duration.

How you recreate it depends on which of the two Runner definitions your
deployment uses — they are held equal by `scripts/verity-compose.test.ts`, but
they are operated differently:

- **Compose overlay** (`deploy/docker-compose.runner-supervisor.yml`, pre-managed
  deployments): `docker compose … up -d --force-recreate verity-runner`, after
  the Server image is pulled. Never `down -v` — the warning above applies here
  with more force, since this Runner's configuration mount is a subpath of the
  same `verity-data` volume.
- **Managed control-plane Runner** (`managed-control-plane-runner.ts`): the
  Server reconciles the container against `desiredSpec` itself, so a Server that
  has been updated recreates the Runner on its own. Nothing to do by hand.

### Recognize it

An OpenCode control-plane turn against a Runner from an older image fails at
start-turn with the spawn broker's own refusal naming `opencode-acp`, not with
any of the `mcpGatewayToken` messages above — the turn never gets far enough to
present a bearer. Against a current image with a stale spec, the turn starts and
OpenCode reports no provider, because `OPENCODE_CONFIG` names a file that is not
mounted. Check the spec rather than guessing:

```
docker inspect <runner-container> --format '{{json .Config.Env}}' | grep -c OPENCODE_CONFIG
```

`0` means the Runner predates the amendment and has to be recreated.

## Why the Server does not detect this first

The supervisor's status handshake carries `protocolVersion` and
`runnerInstanceId`, and neither names the admitted backends. Nothing this Server
can ask distinguishes a stale supervisor from a current one before the turn, so
the refusal is the first available signal.

Adding a backend list to that handshake was considered and rejected: a Server
would have to infer staleness from the field's ABSENCE, which is what the refusal
already reports, and it would mean changing a boundary binary that the affected
containers, by definition, do not have.

Bumping `protocolVersion` instead was also rejected, and for a sharper reason: it
is the wire dialect, and this change alters no frame. A supervisor refuses any
Server dialect below its minimum, so bumping it would make every older container
reject **all** its turns — Claude and Codex too — rather than only the OpenCode
ones actually affected. ADR 0014 Amendment 4 records both under Consequences.
