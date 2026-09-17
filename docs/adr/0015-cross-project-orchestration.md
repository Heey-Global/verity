# ADR 0015: Cross-project orchestration retired

- Status: retired
- Date: 2026-09-17

The unused workflow engine has been removed, including its UI, API, tools,
background processing, database tables, and audit compatibility handling.

Verity Control continues to create project sessions through
`verity_session_handoff` with `target.newSession`, send briefings to existing
sessions, and inspect their progress. These capabilities do not depend on the
retired workflow engine.
