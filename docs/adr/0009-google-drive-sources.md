# ADR 0009 — Google Drive as a Source for Durable Reference Docs

**Status:** Proposed · **Date:** 2026-07-17

## Context

Operators keep reference material an agent needs while coding (specs, API docs,
architecture notes) in Google Drive, where those documents are edited and updated
over time. They want to pull selected Drive documents **into the project** so the
agent can read them, without leaving Git as the source of truth and without a full
two-way sync.

The design conversation settled the shape:

- Drive is **reference material**, not the work product. Git stays the source of
  truth for everything code + agent touch.
- Start with the **simplest** flow: connect one Google account, browse Drive, pick a
  file, import it. Re-importing an already-imported file **overwrites** it. Change
  auto-sync is explicitly **later**, not now.
- The import must land as a **durable, agent-readable file in the repo**, not an
  ephemeral per-turn attachment.

What exists in the codebase today (map from `packages/server`, `packages/store`,
`packages/events`, `apps/mobile`, `packages/mobile`):

- **No persistent "sources" store.** Attachments (`packages/events/src/events.ts`,
  `attachmentSchema`) are per-turn, content-addressed blobs in the DB
  (`AttachmentsTable`, `packages/store/src/schema.ts`), materialized into the working
  dir for one run (`packages/session/src/file-attachments.ts`) and then deleted. No
  project scope, no overwrite-by-name.
- **A durable-artifact pattern already exists:** the meeting-transcript feature writes
  a real markdown file into the session's git worktree
  (`docs/meetings/<date>-<slug>-<hash>.md`, `packages/server/src/server.ts`) and is
  **idempotent by filename**. This is the closest existing "persist an uploaded
  artifact as a durable project document in Git" flow.
- **A third-party connect pattern already exists:** the GitHub App manifest flow
  (browser redirect via unauthenticated `/github/app/manifest/*` routes, single-use
  prepare token, public origin passed as `base` from the app) with credentials stored
  `SecretCipher`-encrypted on `VeritySettingsTable`. Doppler follows the same
  encrypted-settings pattern.
- Frontend is **mobile only** (`apps/mobile`, Expo/React Native); API client is
  `packages/mobile/src/api.ts`.

## Decision

**Import Google Drive documents as durable files committed into the session's git
worktree, under `docs/reference/`. Connect Google via an OAuth 2.0 authorization-code
flow scoped to `drive.readonly`, mirroring the GitHub App connect pattern. Store the
Google refresh token `SecretCipher`-encrypted in Verity settings. Native Google
editor files are exported to a text-first format on import.**

### "Sign in with Google" is account connection, not app login

Verity keeps its own master-password / device-token auth (`packages/server/src/auth.ts`).
The Google flow is **connection/authorization** (like GitHub connect), not identity:
it starts with a Google sign-in + consent screen, but the artifact we keep is a Drive
**authorization** (refresh token for `drive.readonly`), not a user identity. This is
OAuth 2.0 authorization-code, **not** OpenID Connect login. We do not build a Google
identity provider and do not replace app auth.

### Ablageort: durable in Git, idempotent by name

Imported docs are written to `docs/reference/<name>.<ext>` in the worktree and
committed — versioned, greppable, in the agent's context. Re-import of the same Drive
file **overwrites the same path** (idempotency by the file's stable target name, like
the meeting-transcript flow), so a re-pull picks up the latest Drive content and the
git diff shows exactly what changed in the reference material.

### Native Google editor files → text-first export

Native Google formats have no direct bytes; we call `files.export` with a target MIME:

| Drive type    | Export to                     | Rationale                                  |
| ------------- | ----------------------------- | ------------------------------------------ |
| Google Doc    | Markdown (`text/markdown`)    | readable, clean git diff                   |
| Google Sheet  | CSV                           | text, git-friendly (first sheet only)      |
| Google Slides | PDF (or plain text)           | content vs. layout dependent               |
| Regular files | Raw download (`alt=media`)    | bytes as-is (PDF, docx, images)            |

Sheets multi-sheet is the one real trade-off (CSV = first sheet). Acceptable for
reference material; revisit with per-sheet CSV or `.xlsx` if it bites.

### OAuth scope: `drive.readonly` + own in-app browser

Building our own Drive file browser needs `drive.readonly` (a Google "restricted
scope"). For an internal/small deployment we keep the OAuth consent screen in
**Testing** mode (≤100 test users; refresh tokens expire ~7 days) or **Internal**
(Workspace org; no verification, no expiry), avoiding Google's public-app verification
/ security-assessment burden. The lighter Google Picker + `drive.file` alternative was
rejected because it forces Google's picker UI in a WebView instead of the native
browsing UX the operator wants.

### The connect flow is native-app OAuth (PKCE), not a server redirect

**Constraint:** the Verity server is **never publicly reachable** — it is reached only
over Tailscale (`http://dev-server:8082`, `apps/mobile/app.config.ts`). A GitHub-style
server-side redirect callback (which needs a browser-reachable public origin) does
**not** work here.

The OAuth **redirect** only needs to be reachable by the **user's browser**, and the
code→token **exchange** is an **outbound** call from the server to Google — outbound
works even when inbound is blocked. So we flip to the native-app pattern:

```
Mobile app starts OAuth in the system browser (PKCE, access_type=offline)
  → user signs in + consents at Google
  → Google redirects back into the APP via its custom scheme (NOT the server)
  → app forwards { code, codeVerifier } to the Verity server over Tailscale
  → server exchanges code→tokens with Google (OUTBOUND https)
  → server stores the refresh token SecretCipher-encrypted
```

The server stays fully private. The GitHub App manifest flow is **not** the template
here (it needs a reachable callback); the connect endpoints instead accept the code
from the app and do the exchange server-side. Server-side exchange (app forwards the
one-time code + PKCE verifier, not the refresh token) keeps long-lived Drive
credentials server-only.

### Credential model

- **Google OAuth client**: an **iOS** OAuth client (client type *iOS*, bound to bundle
  id `build.verity.app`) — **no client secret**; security comes from PKCE. The client
  id is not secret (it ships in the app), so it is a **plaintext** config value
  provided to the app (server-configurable). Only the operator can create the Google
  Cloud OAuth client — Verity cannot self-provision it. Android needs its own client +
  signing-cert SHA-1 later; MVP is iOS-first.
- **Initial consent status**: Testing mode, with an explicit test-user allowlist. This avoids
  blocking the first TestFlight validation on Google's restricted-scope verification, at the
  cost of seven-day refresh-token expiry and periodic reconnects. Public rollout still requires
  verification for `drive.readonly`.
- **Per-connection refresh token**: obtained by the server's code exchange, stored
  `SecretCipher`-encrypted on `VeritySettingsTable` (like the GitHub App private key /
  Doppler token).
- **Redirect**: the app's custom scheme (Google's reversed-client-id scheme for the iOS
  client). No server origin, no authorized redirect URI to a Verity URL.

## Scope

**In (Phase 1 / MVP):** connect one Google account; "Add from Google Drive" in the
compose "+" menu; in-app folder browser via `files.list`; server-side download/export;
write to `docs/reference/` and commit; overwrite-by-name on re-import.

**Out (later):** auto-sync / change watching, multiple Google accounts, per-project
Drive scoping refinements, Sheets multi-sheet fidelity.

## Consequences

- New durable model: a `sources` concept with project scope must be introduced
  (attachments are global-dedup and ephemeral today).
- New runtime dependency on Google's OAuth + Drive API, gated behind operator
  provisioning of the OAuth client.
- Testing-mode refresh-token expiry (~7 days) means periodic reconnect until the app
  is verified or set Internal — acceptable for MVP, surfaced in the connect UI.
- The server needs **outbound** HTTPS to Google's token + Drive endpoints; it does
  **not** need to be publicly reachable. If the sandbox blocks arbitrary egress, an
  allowlist for `oauth2.googleapis.com` / `www.googleapis.com` may be required.
- The app must be a custom dev-client / standalone build (it already is) for the custom
  URL scheme redirect; Expo Go would need the auth proxy instead.
