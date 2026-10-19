# OpenCode V2 migration

Verity installs `@opencode/cli@2.0.29` from its committed npm lockfile in both
project sandbox and Control Runner images. This replaces `opencode-ai@1.19.0`;
the old package is removed during CLI installation. Rebuild both images and
recreate their containers together with the Server update. A Server-only update
does not upgrade an existing container's agent binary.

## Configuration and security

The fixed `opencode-acp` wrapper still launches ACP protocol version 1 over stdio.
V2 starts a private child server and stops it after stdin closes. It inherits the
broker's environment, identity and native planning filesystem boundary; it does
not use a shared background service for ACP. Allow the private server to finish
shutting down before copying SQLite data.

`OPENCODE_PURE` is no longer a V2 security control. Verity disables project
configuration discovery, supplies a fresh broker-owned HOME/XDG configuration,
and denies external plugins through a V2 `integration.use` policy. Provider
policy allows only `verity`. V2's bundled OpenAI-compatible provider implements
inference through the existing gateway, with a non-secret placeholder; it does
not install an AI SDK provider at runtime. Repository `AGENTS.md` remains text
guidance. Knowledge-isolated turns omit repository instructions but retain the
same provider/plugin restrictions. Web search explicitly selects Exa.

V2 normally allows external directory access. Verity restores an explicit `ask`
rule, with the existing `/knowledge/**` read exception. This permission rule is
not a shell sandbox: native read-only project confinement remains mandatory for
planning, and server-side tool and secret authorization remain authoritative.
Bun/glibc reads `/proc/self/maps` to discover main-thread stack bounds.
Under Landlock, the native helper supplies only the requesting process's own
read-only mappings through a seccomp notification supervisor. It never grants
procfs directory access, peer environments, arbitrary files or writable file
descriptors. The filter follows child processes, including V2's private server;
unsupported notification/fd-transfer APIs fail closed before inference. This
requires Linux 5.14 or newer in addition to the existing Landlock requirements.
On gVisor, the existing private mount/PID namespace implementation provides its
own procfs instead. Docker's default seccomp/AppArmor profiles remain enabled.

Neither copied approvals nor local OpenCode configuration grant access to Verity
secrets. See [the shared security standard](agent-security-standard.md).

The provider JSON retains supported V1 field syntax, which V2 normalizes in
memory. This avoids rewriting persisted server-generated configuration merely
for schema style; native V2 policy/permission fields are supplied by the broker.

## Upgrade and rollback

1. Stop agent turns and their Runner containers; verify no OpenCode child server
   still has the data directory open.
2. Back up the complete OpenCode data/state/cache roots and the associated Verity
   session records together. Preserve ownership and SQLite companion files; do
   not copy a live database independently of its WAL.
3. Keep that backup separate and upgrade a copy first. Verify the same session
   ID loads, replays its conversation, selects the expected model and completes
   another turn after a process restart.
4. Upgrade production only after both architecture smokes and the copied-data
   checks pass. No deployment is performed by the migration PR.
5. To roll back, stop V2 and restore the pre-upgrade backup plus its matching
   Server/Runner image versions. Do not open V2-modified storage with V1. New V2
   turns are not part of the old backup; preserve them separately before restore.

The automated migration fixture creates a harmless V1 conversation, shuts down
its processes, copies all storage, and loads the same session ID in V2. It checks
replay, model selection, plan/build modes, cancellation and two process restarts;
content hashes prove that the original rollback copy remains untouched. This
covers the pinned fixture, not every historical database or a deployed instance.

## Verification

Run the actual pinned executable, not a fake ACP implementation:

```sh
node scripts/probes/opencode-config-isolation.mjs /usr/local/bin/opencode
node scripts/probes/opencode-v2-session.mjs /usr/local/bin/opencode
# Optional second argument: a pinned V1 executable, using disposable copied data.
node scripts/probes/opencode-v2-session.mjs /usr/local/bin/opencode /path/to/v1/opencode
```

The configuration probe uses harmless project/global provider, MCP, agent and
plugin canaries. Its plugin control executes when the policy is removed and is
blocked with managed policy enabled. The session probe sends requests only to a
local HTTP model fixture with a public placeholder. CI runs both probes and the
frozen V1 fixture inside AMD64 and ARM64 sandbox images. No real provider
credentials or upstream inference are required.

Upstream references: [V1 migration](https://dev.opencode.ai/v2/docs/migrate-v1/),
[ACP](https://dev.opencode.ai/v2/docs/cli/acp/),
[plugin policy](https://dev.opencode.ai/v2/docs/policies/).
