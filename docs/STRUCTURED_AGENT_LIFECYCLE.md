# Structured agent lifecycle

Verity presents transport-specific agent activity through one canonical event
model. Backends translate only facts their runtime exposes into
`StructuredLifecycleSignal`; `StructuredLifecycleMapper` owns canonical event
construction, duplicate suppression, and monotonic task phases.

The ACP extension is carried in `_meta.verity.lifecycle`. It intentionally uses
ACP's reserved metadata channel instead of human-readable message or tool-call
titles. A signal is one object or an array of objects with these shapes:

```text
{ type: "compaction", id?: string }
{ type: "task", id: string, phase: "started" | "progress" | "ended", ... }
{ type: "skill", text: string }
```

## Producer coverage

| Runtime | Compaction | Tasks / subagents | Skills |
| --- | --- | --- | --- |
| Claude ACP 0.66.0 | Patched into ACP metadata | Patched from `task_*` SDK messages | Patched from synthetic user messages |
| Codex ACP 1.1.14 | Native `contextCompaction` metadata | Not exposed as a complete lifecycle | Not exposed |
| OpenCode 1.18.15 | Native `session.compacted` event | Native `task` / `agent` tool snapshots | Not exposed |
| Pi 0.84.1 | Mapper ready; no Verity Pi backend exists yet | Mapper ready; no Verity Pi backend exists yet | Mapper ready; no Verity Pi backend exists yet |

The Claude patch is tied to the pinned adapter source and fails the image build
when any owned seam moves. A dependency update must therefore either re-derive
the patch or remove it after upstream gains equivalent structured updates.

Provider quota meters are deliberately not part of this lifecycle protocol.
They are account-wide state and already use Verity's transport-independent
provider-limits service.
