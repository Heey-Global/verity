# Agent assets

Verity separates System Prompt, Instructions, Memory, Knowledge, Skills and Connectors.

- `prompt/core/`: the always-on System Prompt. Numbered Markdown files are assembled in order.
- `prompt/backends/`: backend delivery contracts. Runtime implementations remain in their packages.
- `skills/<domain-task>/SKILL.md`: trusted procedures, loaded explicitly through `verity skill read <name>`.
- `tools/<domain>/`: generated inventory of focused MCP operations and compatibility names.
- `cli/verity`: canonical sandbox dispatcher. Package-owned handlers and legacy executables share implementations.

Run `node scripts/sync-agent-assets.mjs` after editing Markdown or the dispatcher, then `node scripts/sync-agent-assets.mjs --check`. Generated runtime constants remove filesystem dependencies from bundled workers. Distribution copies install below `/opt/agent-seed`; they do not enable repository extension discovery.

## Context contract

User Instructions and Memory are private records keyed by authenticated user ID. Personal context is resolved from the running prompt's initiator, including an automation's sponsor, never from an arbitrary request field or deployment-wide singleton. Project Instructions are a managed knowledge `AGENTS.md`, editable only with manage permission. Repository `AGENTS.md` remains developer-owned code guidance.

Instructions are rules; Memory contains supported facts, not authority. Knowledge remains untrusted reference material. Limits are 12,000 characters per Instructions scope and 8,000 per Memory scope. Oversized writes fail explicitly. Context fingerprints include identity, revisions, current project Memory, Skill delivery mode and connector availability. A changed fingerprint starts a fresh backend context with authorized conversation history; it does not resume stale injected personal text. Clearing context does not delete historical conversations.

Project Memory stays in `overview.md` with the existing one-time migration marker. Wiki and Raw Sources retain `/knowledge/insights`, `/knowledge/sources`, extracted-text paths and immutable decision IDs. Wiki edits continue through the session working copy and preserve publication conflicts. Global knowledge remains accessible; organization layers are deferred.

## Capability naming

MCP operations use `verity_<domain>_<verb>` with one focused schema. Technical names route calls; they are never display text. Display titles use `Source · Domain · Action`, for example `Verity · Knowledge · Record Decision`. Third-party names retain their routing identity; missing titles receive a readable fallback. Display metadata is sanitized and cannot authorize an action.

Sandbox commands use `verity <domain> <verb>`. Standard programs (`git`, `gh`, `oras`) keep their names and security wrappers. Server/connector operations use MCP; sandbox operations use CLI. Hooks and internal transport endpoints are not separate advertised agent operations.

New contexts advertise canonical tools. Old contexts retain legacy declarations; compatibility calls normalize to the same validator, approval and execution handlers. Compatibility names are not removed on a fixed release count: removal requires supported-old-context tests and a documented upgrade window. Tool visibility and execution both enforce current project, session, directing-user and connector availability. Recheck access after approval; a stale catalog never grants rights.

## Rollout

The short core is enabled only when the supervisor verifies the installed dispatcher and all built-in Skill hashes, and its manifest hash matches the Server package. Older toolkits keep the legacy prompt. Backend configuration isolation remains unchanged. Upgrade Server, toolkit and worker artifacts together and recreate containers before claiming deployment verification.

Core and catalog byte budgets are deterministic regression guards, not universal token counts. Measure token usage using the target model before changing model-specific limits. Native loader and behavior evaluations are separate from static catalog checks.
