# OpenCode configuration hardening

Managed OpenCode ACP turns pin `OPENCODE_DISABLE_PROJECT_CONFIG=1` and
`OPENCODE_PURE=1`. The broker supplies a fresh, broker-owned HOME and XDG
configuration tree containing only Verity's gateway provider. Mutable global
configuration and `$HOME/.opencode` from the former home are not imported.
Project configuration, agents, custom tools and external plugins cannot replace
managed policy. The current working directory's `AGENTS.md` remains a text
instruction; knowledge-isolated turns omit project guidance.

The shared security guarantees, compatibility restrictions, native-helper
requirements, verification and container recreation procedure are documented in
[Managed agent security standard](agent-security-standard.md). Provider keys
remain server-side, and secret operations still require matching server-side
authorization. OpenCode 2 remains a separate migration.
