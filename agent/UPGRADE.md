# Agent context upgrade

The database migration adds user-owned context and an optional backend-context fingerprint. It does not rewrite user identities, project knowledge, task IDs, repository guidance, or existing conversation events. Back up the database and project knowledge using the deployment's existing procedure before upgrading.

Deploy the Server and rebuilt toolkit/runner artifacts together, then recreate project containers through the normal sandbox update flow. The installed `skills-manifest.json` describes the dispatcher and every built-in Skill with their content hashes. The supervisor reports `builtInSkillsVersion: 1` only when the installed dispatcher and declared Skill files exist and match. Partial or stale installations report zero. The Server also compares the reported manifest hash with its own expected package; a different package keeps the legacy prompt and matching legacy tool catalog active. Core, catalog and manifest changes participate in the context fingerprint.

| Server  | Toolkit                    | Runtime behavior                                                                        |
| ------- | -------------------------- | --------------------------------------------------------------------------------------- |
| Updated | Updated and verified       | Short core plus explicit built-in Skill loader; focused canonical tools on new contexts |
| Updated | Older, incomplete or stale | Existing detailed prompt; compatibility tool handlers remain available                  |
| Older   | Updated                    | Existing Server behavior; legacy executables remain installed                           |

Existing backend contexts without a current scoped fingerprint are rebuilt on their next turn. Authorized conversation history provides the handoff. Edits or clearing of Instructions/Memory, a different directing user, or a changed connector catalog also rebuild the backend context. Historical conversations remain stored; clearing factual context does not delete historical messages.

Project Memory remains authoritative in `overview.md`. The revisioned settings editor reads and writes that file, and its migration marker prevents cleared legacy content from returning. Project Instructions use a separate managed knowledge-root `AGENTS.md`; repository `AGENTS.md` remains code guidance. User context is keyed by the authenticated identity, never a deployment-wide singleton.

Wiki and Raw Sources keep their existing physical mount paths, working-copy publication behavior and immutable identifiers. Existing Documents/Sources route values remain accepted; canonical Wiki/Raw Sources route values normalize through the compatibility parser. No Global knowledge relocation is included.

## Verification

Run asset synchronization checks, focused capability/inventory tests, scoped context storage and lifecycle tests, toolkit distribution guards, and the app's context/settings tests. Build all affected consumers of the event and API types. Native managed-configuration probes cover normal and planning startup without upstream model requests:

```sh
node scripts/probes/agent-config-isolation.mjs
node scripts/probes/opencode-config-isolation.mjs
```

A passing loader/configuration probe does not establish model compliance with Skill triggers. The core/catalog byte budgets are regression guards rather than model-specific token measurements. Deployment verification also requires checking the actual recreated container's supervisor status and exercising the selected backend there; local package tests do not prove that an existing deployment has received new artifacts.
