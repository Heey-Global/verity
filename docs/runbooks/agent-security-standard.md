# Managed agent security standard

Claude Code, Codex and OpenCode use the same Verity security boundaries. These
apply to supervised ACP turns on containers running the updated toolkit. They
protect startup policy from mutable repository and user configuration; they do
not make repository instructions trustworthy or isolate concurrent sessions that
share the same Unix identity.

## Security matrix

| Guarantee | Claude Code | Codex | OpenCode | Verification |
| --- | --- | --- | --- | --- |
| Managed global configuration | Broker-owned fresh HOME and configuration tree | Same; gateway-only `config.toml` | Same; fresh XDG config and gateway-only provider | `agent-security-boundary.test.ts`, native probes |
| Project settings cannot configure providers or MCP | Empty `settingSources`, strict MCP, empty plugins and agents; API-key helper disabled | Installer removes ACP's automatic project trust; project layers stay untrusted | Project config discovery disabled; pure mode enabled | ACP tests, `codex-acp-hardening.test.ts`, native probes |
| Text guidance remains available | Current cwd's regular `AGENTS.md` appended as text (up to 256 KiB) | Native `AGENTS.md` discovery | Explicit current cwd `AGENTS.md` instruction | Claude ACP test and OpenCode probe |
| Automatic project extensions disabled | No settings/plugins/custom agents from project discovery | Untrusted config/hooks/exec policies; native multi-agent and plugins disabled; automatic skills catalog disabled | No project agents, custom tools or plugins | Managed launch and adversarial ACP probes |
| Planning protects project files | Shared native helper | Shared native helper, plus native read-only posture | Shared native helper, plus verified plan posture | Shell/subprocess write refusal and writable negative control |
| Planning tools cannot bypass filesystem protection | Shared server-side gateway refusal | Same | Same | Server planning and MCP gateway tests |
| Provider credentials stay outside agent runtime | Local gateway placeholder | Same | Same | Gateway and supervisor environment tests |
| Secret approval, scope, revocation and resume | Shared per-turn gateway and grant broker | Same | Same | Secret authorization, brokered grants and revocation suites |
| Missing security boundary refuses the turn | Server checks supervisor capabilities; worker checks broker capabilities | Same | Same | Supervisor-client and broker tests |

The native helper confines the agent and its descendants with Landlock or a
private user/mount namespace. Planning exposes the project tree read-only and a
separate writable runtime home. It drops the optional Docker group and cannot
use an unconfined native-spawn fallback. Other project paths outside this
filesystem view are unavailable. Entering planning during an executing turn does
not retrofit that process: its local filesystem boundary takes effect from the
next message, as the planning tool reports. Gateway refusals take effect
immediately. Direct network effects are not a guarantee of
this filesystem policy; Verity gateway capabilities are denied separately.

The Server refuses external gateway tools both before approval and again before
execution while planning is active. Task bookkeeping and planning controls remain
available. A standing secret grant cannot override this refusal. All backends
retain the same exact grant bindings, per-turn bearer retirement, project and
session scopes, and revocation checks. Configuration files never authorize a
secret operation.

## Configuration and runtime data

The broker creates configuration directories owned by itself, without group or
other write permissions. The agent receives its own writable temporary files,
logs and caches. Claude project transcripts and Codex rollouts remain linked to
existing runtime storage. Codex SQLite state and writer locks have a dedicated
`codex-state` directory; OpenCode keeps its existing data/state/cache roots.
Neither transcripts nor writable runtime directories are imported as policy.
Git hooks, signing and URL rewrites come from an image-owned Git policy template;
the broker adds provisioned identity and a generated global ignore file. The old
user Git configuration is not imported.

Model selection and MCP configuration belong in Verity. Repository/user settings,
MCP definitions, hooks, plugins and custom agent definitions cannot configure a
managed turn. Codex text skills can still be read explicitly; Verity does not
advertise their automatic catalog. The ability to run an installed command or
read a text instruction does not grant credentials.

Use `AGENTS.md` for repository guidance. Claude and OpenCode import the current
working directory's file explicitly; ancestor instructions, `CLAUDE.md` fallback
and user-home customization are not automatically imported by these paths.
Knowledge-isolated turns continue to exclude project guidance. Caller-selected
ACP adapter arguments are refused for every backend.

Codex ACP currently marks session roots trusted when creating a thread. The
installer changes exactly that audited expression to untrusted before exposing
the executable. If the expression changes or appears more than once, installation
fails. The installer also rejects Codex ACP versions outside the audited version
2.2.2. Review and reverify this transformation when upgrading the pinned adapter;
do not disable the guard to accept an unknown version.

## Rollout and verification

Release the Server, toolkit, worker bundle, Codex ACP installation patch and both
native-helper prebuilts together. Recreate project containers and the control-plane
Runner from the new release. End existing turns first. The new Server refuses
supervisors without the managed-configuration capability; the worker independently
refuses brokers without it. Planning additionally requires filesystem isolation.
Older containers therefore need recreation before starting new managed turns.
Deployment is a separate operation.

Run the affected session, supervisor, transcript, script-isolation, gateway and
secret suites, then build and check formatting/lint for changed files. Build the
session package before running:

```sh
node scripts/probes/agent-config-isolation.mjs
node scripts/probes/opencode-config-isolation.mjs
```

The probes use the pinned installed CLIs, harmless local canaries and a loopback
placeholder endpoint. They initialize real sessions without requesting inference
or using credentials. The common probe copies the installed Codex adapter before
applying the production transformation; it never changes the installed package.
The tests include a writable negative control for shell writes. Verify new guards
against deliberately broken policy before relying on them.

The ARM64 helper is cross-compiled from the same source and pinned compiler as
AMD64; native execution requires an ARM64 test host. Full upstream inference,
container recreation and deployment must be verified in the target environment.
OpenCode 2 remains a separate migration.
