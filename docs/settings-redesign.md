# Verity mobile Settings — redesign spec

Status: proposed · Target: `apps/mobile/app/settings.tsx` (+ small server follow-ups)

Scope: this is the **server**-level settings screen. Per-project configuration (dev servers,
monitors/schedules, Doppler binding) lives in the project screen — see the companion
[`project-screen-redesign.md`](./project-screen-redesign.md).

This spec defers to [`design-language.md`](./design-language.md) for the status pill, the
auto-save/interaction model, the wording glossary, and the credential-derivation pattern. It
restates none of those; it owns only what is server-specific.

This spec replaces the current server-level Settings screen. It is the product of a
multi-lens review (mobile-UX/HIG, information architecture, security/trust,
accessibility, engineering feasibility, onboarding/edge-states) and a synthesis pass,
all grounded against the real code. Decisions marked **[decided]** are locked; items
under "Server follow-ups" are explicitly out of scope for v1.

---

## 1. Why

The current screen is one flat `ScrollView` of ~11 equal-weight cards, all nested under
a single `Git identity & signing` section (`settings.tsx:433-698`). Concrete defects the
review confirmed:

- **False "Incomplete · 2/6" alarm.** The header counter sums identity(2) + 4 file-path
  fields and never consults `gitSshPrivateKeyConfigured` (`settings.tsx:121,327-329,746`).
  In the **default broker deployment** the private key lives in the DB (it *is* the
  signing key — `server.ts:465`, `git-signer.ts:104-117`), the four path fields are
  legitimately empty, so the screen always reads "incomplete" while signing works fine.
- **7 status vocabularies + 3 near-identical pill components** (`Incomplete · 2/6`,
  `0/4 set`, `Configured`, `Connected`, `Unlocked`, `Missing`, `Not set`).
- **SSH key settable two contradictory ways in one panel** — on-disk path *and* write-only
  paste — showing "Missing" and "Configured" at the same time.
- **Low-level plumbing** (known_hosts, allowed_signers, absolute `/data` paths) shown
  prominently though empty in the default deployment.
- **Everything gated behind one global Save**, with `Reprovision` in a separate block whose
  relationship to Save is unclear.

## 2. Principles

1. **One honest status model.** Green = works · Himbeere/raspberry = needs setup ·
   muted grey text = optional. Meaning never conveyed by colour alone.
2. **Auto-save, no Save button. [decided]** Every change persists on its own; the screen
   never batches edits behind a Save gate.
3. **Right altitude.** Broker-first reality up front; deployment file-path plumbing stays out of
   the mobile UI.
4. **Honest signing status.** Never claim more than the client can observe.
5. **Destructive stays explicit.** Saving a setting is silent; *applying* it to active
   containers (reprovision) is a deliberate, confirmed action.

---

## 3. Layout

Legend: `[▸]/[▾]` disclosure · `●` status pill · `‹grey›` muted detail.

### Header — actionable setup checklist

```
‹ Verity            Settings

┌───────────────────────────────────────┐
│  Setup                       2 to do ⌄ │   tap → expands to the named items,
│  ‹Tap to see what's left›              │   each row scrolls to its card
└───────────────────────────────────────┘
```

- **Not** a field counter. A tappable checklist of the **required-in-settings** items only,
  each deep-linking (scroll-to) its card.
- Required set: **secret store unlocked · GitHub repository access connected · verified commits
  ready**. Doppler and AI logins are **optional** → excluded from the count.
- Computed by **one pure, unit-tested helper** from the *same booleans* the per-card pills
  use, so header and pills can never disagree. **Not** derived from `onboarding.nextStep`
  (that signal is broker-blind and includes non-settings steps).
- On settings-fetch failure: `Couldn't load settings — Retry`, **never** `0 to do`.
- `accessibilityRole="header"`; count changes announced via a live region. `All set ✓`
  when nothing is outstanding.

### Group 1 · Connection  ‹device-local›

```
CONNECTION
┌───────────────────────────────────────┐
│  Server               http://dev-…8090 │
│  ▭ Change server address                │   → /onboarding/server-url?reconfigure=1
└───────────────────────────────────────┘
```

No pill. App/server version moves to the footer.

### Group 2 · GitHub

GitHub is one user-facing setup area with three distinct responsibilities. The UI keeps their
statuses separate without exposing the internal split as unrelated settings.

```
GITHUB
┌───────────────────────────────────────┐
│  GitHub connection                   │
│  Repository access       ✓ Connected │   clone / push / pull requests
│  ▭ Manage GitHub connection          │   → /github-connect
│  ──────────────────────────────────  │
│  Commit author             ✓ Ready   │
│  HT  Name shown on commits           │
│      GitHub-verified email           │   required because an organization
│                                      │   App cannot identify a person
│  ──────────────────────────────────  │
│  Verified commits          ✓ Ready   │
│  Signing key: ssh-ed25519 AAAA…      │
│  ▭ Copy key       ▭ Open GitHub ↗    │
└───────────────────────────────────────┘
```

- The GitHub authorization grants repository access; it does **not** reliably provide the personal name and
  verified email that should be written to commits. The commit author therefore remains editable.
- The commit author is independent of the signing-key source and applies to generated and imported
  keys alike.
- Host file paths and private-key paste controls are removed from the mobile UI. Legacy API fields
  remain supported for deployment compatibility and are managed through GitOps, not app settings.

#### GitHub onboarding: one progressively disclosed page

The onboarding step is titled **GitHub**, never "GitHub App". Before authorization it renders only
a short explanation and one primary **Connect to GitHub** action. App IDs, installation IDs, PEM
fields, and the old "Use existing App" path are not end-user choices.

After the browser round-trip, the same page replaces the connect card with:

1. `✓ GitHub connected`.
2. **Commit author** — prefilled name and GitHub-verified email when GitHub can derive a personal
   account; otherwise the two fields appear for one-time manual entry.
3. **Verified commits** — the already generated public signing key, **Copy key**, **Open GitHub**,
   and `I added the signing key to GitHub`.

The signing key is generated server-side; the private key never reaches the app. **Next** remains
hidden until the key was copied or the explicit confirmation was checked. The former separate
GitHub connection, commit author, and signing-key registration are one required onboarding step.

The onboarding counterpart is one page named **GitHub**:

1. Show one primary **Connect to GitHub** action. The App manifest, IDs, PEM, and
   "use existing App" path are implementation details and are not exposed.
2. After the browser returns, derive and display the commit author. If an organization connection
   cannot supply a person, ask for name and GitHub-verified email inline.
3. Generate the signing key server-side and show its public key on the same page with **Copy key**
   and **Open GitHub**.
4. Enable **Next** after the key was copied or you confirm **I added the signing key to GitHub**.

### Group 3 · Connected services  ‹stored on server, encrypted›

Named "Connected services", **not** "Access & secrets". Secret-store lock state is elevated
because it gates encrypted credentials throughout this group.

```
CONNECTED SERVICES
┌───────────────────────────────────────┐
│  Secret store               ✓ Unlocked │
│  ‹Secrets are available to project     │
│   containers.›                         │
└───────────────────────────────────────┘

┌───────────────────────────────────────┐
│  AI backends                           │
│  ‹Claude & Codex subscriptions›        │
│  Claude                    ✓ Connected │   per-backend row: own pill,
│  ▭ Re-login   ▭ Logout                 │   own Re-login/Logout, full
│  ────────────────────────────────────  │   device-code / failed / restart flow
│  Codex                     ✓ Connected │
│  ▭ Re-login   ▭ Logout                 │
└───────────────────────────────────────┘

┌───────────────────────────────────────┐
│  Doppler                     Optional  │   muted right-aligned detail, NOT a pill —
│  ‹Injects managed secrets into each    │   doesn't nag, doesn't count as a to-do
│   project sandbox.›                    │
│  ▭ Replace token                       │   write-only paste box opens on tap
└───────────────────────────────────────┘
```

- Claude + Codex share **one card** with a divider (were two near-identical panels), but
  each keeps its **own** state pill and Re-login/Logout — no shared summary pill.
- When the server manages **no** secret store: show an explanatory
  `This server doesn't manage a secret store` line rather than letting the credential cards
  silently vanish.
- Gated cards while sealed: visible but `accessibilityState={{disabled:true}}`, reason in
  `accessibilityHint`, inline `Unlock the secret store` hint.

### Group 4 · Maintenance

This group contains the Server self-update panel and reprovision-all. Sandbox update state is
reported, not configured: see **Sandbox update stuck** in
[`design-language.md`](./design-language.md#wording-glossary). There are no server-wide Sandbox
update-policy controls.

### Footer

```
✓ All changes saved · Last saved 22:06 · App 0.0.0 (5) · Server 1.19.7
```

---

## 4. Auto-save model  [decided]

No Save/Reset bar. Persistence is per-change:

| Control type | When it saves | Feedback |
| --- | --- | --- |
| Text (commit-author name and email) | on blur (field loses focus), debounced | per-field `saving… → saved ✓`; invalid values (e.g. half-typed email) are **not** persisted — only on valid |
| Secret paste (Doppler token) | on blur | per-field `saving… → saved ✓`; write-only, never echoed back |

- A subtle global line reflects aggregate state: `Saving…` / `✓ All changes saved`.
- Saves are partial `PATCH /settings` (already partial-friendly via `patchFromDraft` /
  `secretPatchFromDraft`) — send only the changed field.
- **Errors are per-field and inline.** A sealed-store `503` on a secret field →
  `Unlock the secret store first` under that field, value reverts. No floating error bar.
- No global "Reset" — re-editing a field is the undo. (A per-field revert affordance is
  optional polish, not v1.)

---

## 5. Status system

One pill component, driven by an intent — the **word is always rendered in `text`/`textMuted`
colour at ≥ 4.5:1** and carries a **leading glyph**; the tone only drives dot/border/background.

| Intent | Colour token | Glyph | Example labels |
| --- | --- | --- | --- |
| Ready / done | `tone.done` (green) `#3aa657` / `#28e6a4` | ✓ | `Signing ready`, `Connected`, `Unlocked` |
| Needs setup | `tone.danger` (**Himbeere**) `#d84f74` / `#ff5c8a` | ! | `Needs setup` |
| Optional / empty | muted `textMuted` detail text, **no pill** | – | `Optional`, `Not configured` |
| Transient / in progress | neutral, no tone | spinner | `Saving…`, `Checking`, `Reprovisioning 2/5` |

- **Amber (`tone.attention`) is retired from this screen. [decided]** It fails WCAG 1.4.3
  in light (`#e8a33d` ≈ 2.2:1) and in dark mode was set to the exact accent magenta
  (`#ff35da == accent`), making "act now" indistinguishable from decorative chrome.
- **Himbeere for "needs setup". [decided]** Distinct from the magenta accent, respects the
  "no orange" brand preference, one token for both themes. It also serves danger/destructive
  buttons (Logout, Reprovision) — acceptable because those are **buttons**, needs-setup is a
  **status pill**; context and the glyph+word redundancy disambiguate.
- Retires `Missing` / `Not set` / `0/4 set` / `Incomplete · N/6`.

---

## 6. Signing status logic  (the core correctness fix — client-only)

Replaces the path-count `2/6` pill. Derivable **today, with zero server change**, because it
uses `resolveSigningPrivateKey`'s own inputs:

```
green "Signing ready" · "Commits will be signed"
   when  gitSshPrivateKeyConfigured  ||  trimOrNull(gitSshPrivateKeyPath)
else
   himbeer "Needs setup" · "No signing method configured"
```

- The pill **never** says `broker`, `key file`, or `verified` — the client cannot observe
  those. It asserts only *that* commits will be signed, not the mechanism.
- Do **not** bind the pill to `GET /settings/signing-key.configured` — that ORs
  `publicKey !== null` and can paint a false green.
- Identity (name/email) is evaluated **separately** from signing.

---

## 7. Reprovision  (decoupled from save)

With auto-save there is no "dirty" state to gate on. Reprovision is offered based on
"settings changed since containers were last provisioned", as its **own non-sticky card** —
never occupying a former Save-button position.

State machine:

- **idle / up-to-date** — nothing to apply, card hidden or muted.
- **changes pending** — `Apply to N active containers?` (N via `listProjects().filter(active)`,
  fetched once, **never polled**) → `Reprovision now`, with a confirmation given it recreates
  each container.
- **running** — `Reprovisioning X/N…`.
- **done with partial failure** — list failed containers + `Retry failed` only.

Per design-language.md's single destructive-confirmation policy: every container recreation
(Reprovision here, and Update sandbox on the project) is confirmed, while a GitHub-token
refresh and dev-server start / stop / restart are **not** destructive and need no confirmation.

---

## 8. Accessibility  (fold-in, not optional)

- Explicit `accessibilityLabel` on every `TextInput`.
- `accessibilityRole`/`State` on pills, disclosures, actions, and the write-only Doppler row.
- Live-region announcements for save state, reprovision progress, and `Copied`.
- Per-group loading **skeletons** (no full-page spinner, no `0 to do` during load);
  distinguish `couldn't load` from `loaded-and-empty`.
- 44 pt minimum on every interactive row (today `disclosure` has no min height,
  `signingKeyButton` is 40 — `settings.tsx:1580`).
- Dynamic-type reflow: status rows wrap/stack; drop fixed status columns.

---

## 9. Rollout order

| # | Change | Effort |
| --- | --- | --- |
| 1 | `2/6` → green/himbeer from `gitSshPrivateKeyConfigured`; copy "Commits will be signed" / "No signing method configured" | quick-win |
| 2 | Adopt the shared [`apps/mobile/components/StatusPill.tsx`](../apps/mobile/components/StatusPill.tsx) (word in text colour ≥ 4.5:1 + glyph); retire amber; drop the dark-mode magenta collision | quick-win |
| 3 | Regroup flat ScrollView into 3 sections; combine GitHub access + verified commits; version → footer | medium |
| 4 | Auto-save: text/secret on blur, per-field feedback; remove Save/Reset bar | medium |
| 5 | Header as tappable required-items checklist from one tested helper; suppress count on load-failure | medium |
| 6 | Reprovision as its own card + state machine (0 / running X-N / partial-failure + retry) | medium |
| 7 | Claude + Codex one card, per-backend rows | medium |
| 8 | Remove host file paths/private-key paste from mobile UI; retain legacy API compatibility | quick-win |
| 9 | A11y pass (labels, roles, live regions, 44 pt, dynamic type) | medium |
| 10 | Unhappy-path coverage (skeletons, first-load failure, unmanaged-secret-store) | medium |
| 11 | Doppler as muted detail text; drop `githubAppId`/`InstallationId` from draft+patch | quick-win |

## 10. Server follow-ups  (out of v1 scope)

- **`signingMode` / `signingBrokerEnabled` on `GET /settings`** — unlocks honest
  "Signed via broker" vs "key file" label text. Cosmetic; deferred behind the client-only
  fix (#1).
- **`POST /settings/signing-key/verify`** — a real sign+verify round-trip through the
  broker, enabling a true `Verified · last checked` state and catching the
  broker-URL-not-wired false-green (`provisioner.ts:1640`) the client cannot otherwise see.

## 11. Open questions

- Unmanaged / no-secret-store deployment: hide Group 2 entirely, or show the explanatory
  line (spec currently assumes the line)?
- Unlock ownership: inline `SecretStoreSection` vs the separate `/unlock-device` gate that
  redirects sealed servers — the "disabled with inline hint" cards must not be specced for a
  state the gate immediately preempts.
