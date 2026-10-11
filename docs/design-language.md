# Verity Mobile — Design Language

This document is the single source of truth for the shared behavior of the Verity
mobile control plane. It owns the status intents and their words, the auto-save and
interaction model, the navigation model, the wording glossary, and the credential
patterns. How things look — colors, type, shapes and every component, including status
indicators — is owned by [`design-system.md`](./design-system.md).

Both surface specs — [`settings-redesign.md`](./settings-redesign.md) (the server
Settings screen) and [`project-screen-redesign.md`](./project-screen-redesign.md) (the
project overview and its settings sub-screen) — **defer to this document** for behavior
and wording, and to [`design-system.md`](./design-system.md) for appearance. Where they
touch a status, the save experience, a lifecycle verb, or a status word, they reference
the relevant section and restate nothing. If a surface spec disagrees with either
document, the shared document wins: this one for behavior and wording, `design-system.md`
for appearance.

The purpose is narrow and deliberate: the redesign exists to kill status and vocabulary
sprawl. Two engineers building one screen each must ship the *same* status and the *same*
save experience. That is only guaranteed if the status intents, the save model, and the
words are defined once, in a neutral place. This is that place.

---

## Status system

Every status shown anywhere in the app is one of **four intents**. The intent decides the
meaning and the words; [`design-system.md` § Status](./design-system.md#54-status) decides
how each intent is drawn (tag or dot and word) and in which color.

### The four intents

| Intent | Meaning | Example labels |
| --- | --- | --- |
| `ready` | Works, nothing to do | Connected, Configured, Active, Running, Minted, Signing ready, Unlocked, Up to date |
| `needsSetup` | Something required is missing or failed | Needs setup, Update available, Rejected, Error |
| `optional` | Optional and empty — not a to-do | Optional, Not configured, Off |
| `transient` | In motion | Saving…, Checking, Starting, Stopping, Bound, Reprovisioning X/N |

### Rules that bind both screens

- An `optional` state is never counted as a to-do and never uses the `needsSetup`
  appearance.
- The word **`Not configured`** is reserved for `optional`. A *required* thing that is
  missing says **`Needs setup`** (`needsSetup`), never `Not configured`.
- `transient` covers every in-flight state, including `Bound` (the in-progress Doppler
  step) and `Reprovisioning X/N`. It always shows a spinner next to its word.
- Meaning is never conveyed by color alone: every status renders its word.

### Accessibility

- Every status sets `accessibilityRole` and `accessibilityState`. The accessible label
  reads the **word plus its intent** (e.g. "Connected, ready").
- `transient → settled` transitions are announced through a **live region** so a state
  change is perceivable without sight of the spinner.
- A tappable status has a minimum interactive height of **44 pt**.

---

## Auto-save & interaction

Both surfaces auto-save. There is **no Save button and no Reset button anywhere**, and
the `n/6` / `n/8` progress counters are retired on both screens.

### When each control saves

| Control type | When it saves | Feedback |
| --- | --- | --- |
| Toggle | immediately on flip | row `saving…` → settles |
| Text (name, email, paths, command, ports, branch) | on blur, debounced; **invalid values are not persisted** | per-field `saving… → saved ✓` |
| Secret paste (SSH key, Doppler token) | on blur; write-only, never echoed back | per-field `saving… → saved ✓` |
| Selection / picker (default model, Doppler binding) | on selection commit | per-field `saving… → saved ✓` |

### Aggregate save signal

The aggregate signal is **identical on both surfaces**: a subtle global `Saving…` /
`✓ All changes saved` line, plus a `Last saved HH:MM` footer. This appears on the server
Settings screen **and** on the project settings sub-screen — the sub-screen must not drop
it.

### Errors and validation

- Errors are **per-field and inline** — never a toast, never a floating bar.
- **Invalid values revert.** They are not persisted; the field returns to its last valid
  state and shows the inline error.
- **Sealed secret store:** a `503` from a sealed store on *any* secret field — the server
  SSH signing key **and** the project Doppler token — shows `Unlock the secret store first`
  under that field and reverts the value. The project Doppler-token field inherits this
  sealed-store gating verbatim.

### Applying config to a running container

Persisting a setting and applying it are two different things:

- **Persisting** a setting is silent.
- **Applying** a persisted setting to a running container is a deliberate, confirmed
  **Reprovision** (see [glossary](#wording-glossary)).
- Both screens surface a **"changes pending since provisioned"** affordance. On the
  project, editing the dev-server command/ports or the Doppler binding on the Configure
  sub-screen raises a **"Config changed — Reprovision to apply"** banner on the overview
  Container card, mirroring the server's non-sticky Reprovision card. A silent edit on one
  screen followed by a manual tap on another, with no banner, is not acceptable.

### Destructive-action confirmation (one policy)

- **Any container recreation is confirmed** using the same confirm/warnings flow: server
  Reprovision, project Reprovision, and Update sandbox.
- **Purge and Delete** keep their stronger, explicitly destructive confirmation.
- **Token refresh** and **dev-server start / stop / restart** are *not* destructive and
  need **no** confirmation.

---

## Navigation model

The two surfaces have **deliberately different shapes**. This asymmetry is a decision, not
an omission, and both specs state it explicitly.

- **Server = one screen.** A single scrolling screen with a tappable **required-setup
  checklist header** whose rows scroll to their card.
- **Project = overview + sub-screen.** An Operate-first **overview** plus a **Project
  settings** sub-screen. The `Project settings ›` row is the deliberate replacement for the
  server's scroll-to deep links.

The **required-setup checklist header is server-only by design.** A project's required
setup is surfaced by its **per-card status** and the **changes-pending banner**, not by a
header count. Both specs state this so the difference reads as intentional.

---

## Wording glossary

One decision per contested term. These labels are used **verbatim** on both surfaces.

| Term | Meaning | Use for | Do not confuse with |
| --- | --- | --- | --- |
| **Sandbox image** | The per-project container image *version* (e.g. `v1.19.7`) and its up-to-date status | Project Container card: `Sandbox v1.19.7 · Up to date`, and the manual **Update sandbox** action | Sandbox update stuck (the fault report) |
| **Sandbox update stuck** | Nothing is going to move this sandbox onto the current image on its own — Verity's repair has failed repeatedly, or the reconciler has looked and has no reason to act | The overview icon and the project Container card, **only** when the repair has stalled — never while it is merely in progress | Sandbox image (the artifact); an ordinary pending update, which needs no report because Verity applies it itself |
| **Reprovision** | Recreate a container to apply changed config/image, losing container state. The one canonical verb for "recreate this container" | Server: reprovision all active containers. Project: reprovision **this** container (replaces the old label "Repair") | A GitHub-token refresh, a dev-server restart, or an image-version check |
| **Update sandbox** | A reprovision that specifically pulls a newer sandbox image | Project Container card, only when a newer image exists | Reprovision-to-apply-config (same mechanism, but this action is scoped to image bumps) |
| **Refresh token** | Re-mint the per-project GitHub token; does **not** recreate the container | Project Container card | Reprovision / Update sandbox (these recreate the container) |
| **GitHub connection** | The authorization that grants Verity repository/API access | Server GitHub group: clone, push, pull-request access | Do not expose "GitHub App" in primary UI; it is an implementation detail |
| **Commit author** | The personal name and GitHub-verified email written to commits | Server GitHub group and GitHub commits onboarding | "Agent Git identity" or GitHub App identity |
| **Verified commits** | SSH signing that lets GitHub verify Verity-created commits | Server GitHub group and GitHub commits onboarding | Repository access or commit author |
| **Ready** | `ready` terminal state meaning "this works / nothing to do" | The intent name in the status system; not a user-facing word by itself | The literal label `Ready` |
| **Connected** | `ready` label for "external service link established" | GitHub, AI backends, Secret store (`Unlocked`), dev-server-reachable | `Configured` |
| **Configured** | `ready` label for "a value is stored here" | Signing key stored, Doppler token pasted, default model set | `Connected` |
| **Active** | `ready` label for container liveness | The container lifecycle status (`Active / Failed / Absent` → `ready` / `needsSetup` / `optional`) | `Running` |
| **Running** | `ready` label for a *process* being up | The dev-server process status | `Active` (container) |
| **Needs setup** | `needsSetup` state for a **required** thing that is missing | Signing unconfigured, GitHub unconnected, dev-server `Error` / `Unreachable`, sandbox `Update available` | `Not configured` (which is optional / muted) |
| **Not configured** | Muted state for an **optional** thing that is empty | Doppler when unset, optional dev-server absence | `Needs setup` (required → `needsSetup`). Never render this phrase as `needsSetup` |
| **Optional** | `optional` state, excluded from any to-do count | Server Doppler; project Monitors; any configured-but-optional item | A `ready` status |
| **Account Doppler token** | The server-level token that lets projects bind Doppler secrets | Server Group 3 Doppler card | Doppler binding (the per-project consumer) |
| **Doppler binding** | The per-project mapping (project → config) that consumes the account token | Project Configure sub-screen | Account Doppler token (its prerequisite) |
| **Minted** | `ready`: the Doppler binding has a live minted secret | Project Doppler binding, `ready` only | `Bound` (the in-progress step) |
| **Bound** | The binding exists but is not yet minted — an **in-progress**, not optional, state | Project Doppler binding, rendered as `transient` (spinner + word), **not** muted | `Minted` (done) / `Optional` (muted) |
| **Verity Premium** | The umbrella for every paid Uplink feature | Settings row, hero panel, upsell dialogs and badges | "Uplink" as a product name in primary UI (it is the transport) |
| **Uplink subscription key** | The credential that activates Verity Premium on a server | The one secret field on the Verity Premium screen | "Verity subscription key", "Premium key" |
| **Online sharing** | Public preview links that work over the internet | Preview sheet, dev-server rows, Verity Premium feature switch, diagnostics | "Shared online", "Over the internet", "public sharing" |
| **Remote access** | The app reaching Core from outside the local network through Uplink | Verity Premium feature switch, diagnostics, connection test | "Remote Control" |
| **Off** | Muted state for a feature the operator switched off deliberately | Verity Premium and diagnostics feature rows, rendered as `optional` | `Needs setup` (a fault) / `Not included` (Uplink does not grant it) |

### Ready-word convention

Use the right `ready` word for the right kind of "done", and ban ad-hoc synonyms:

- **`Connected`** — an external service link is established.
- **`Configured`** — a value is stored here.
- **`Active`** — a *container* is live. (Use `Active`, not "running containers", when
  counting container liveness.)
- **`Running`** — a *process* is up.

### Progressive connection setup

Connected-service onboarding reveals technical follow-up only after authorization. GitHub starts
with one **Connect to GitHub** action; commit-author fields and the public Signing Key appear only
after the browser round-trip. Internal credential types, IDs, and private keys are not presented as
setup choices.

### Doppler two-step lifecycle

Doppler has a two-step lifecycle, and the two steps use different intents:

- **`Bound`** — the binding exists but is not yet minted. `transient` (spinner + word).
- **`Minted`** — the binding has a live minted secret. `ready`.

---

## Shared components & tokens

Define each of these **once**, in the home listed. Both specs reference the home; neither
restates it.

| Artifact | Home | Notes |
| --- | --- | --- |
| **Status intents and words** | `design-language.md` § [Status system](#status-system) | The four intents, the reserved words and the accessibility rules. |
| **Status appearance** (tag, dot and word, colors) | [`design-system.md` § Status](./design-system.md#54-status) | One shared status component driven by `intent` and `label`, replacing the hand-rolled status indicators. |
| **Auto-save model** (full table + aggregate line + `Last saved` footer + validation + sealed-store `503`) | `design-language.md` § [Auto-save & interaction](#auto-save--interaction) | Both specs reference by section and restate nothing. |
| **Container-lifecycle glossary** (Reprovision / Update sandbox / Refresh token) | `design-language.md` § [Wording glossary](#wording-glossary) | The one canonical verb set. |
| **Account → project credential-derivation pattern** | `design-language.md` § [Credentials](#credential-derivation-pattern) | One pattern, instantiated twice; named reciprocally on both screens. |
| **Tokens** | [`design-system.md`](./design-system.md) → [`apps/mobile/theme/tokens.ts`](../apps/mobile/theme/tokens.ts) | Color roles, type, spacing, radii and elevation as specified in the design system. |

### Credential-derivation pattern

There is **one** account-to-project credential-derivation pattern, instantiated twice.
Name it **reciprocally** on both screens so the two ends of each link point at each other:

- **GitHub App → per-project token.** Server: the GitHub App connection. Project: the
  per-project GitHub token derived from it (refreshed with **Refresh token**).
- **Account Doppler token → per-project Doppler binding.** Server: "Account Doppler token
  (lets projects bind Doppler secrets)". Project: "Doppler binding (uses the account token
  from server Settings)".

There is no server-side counterpart for the sandbox image, and deliberately so: Verity
updates its own sandboxes — the relay reconciler rebuilds every one of them onto the
current image after each Server restart, which on a released Server is how the fleet
follows the Server's version. So the project Container card reports only the two states
worth a human's attention: "Verity is rebuilding this sandbox" while that runs, and
"stuck" when it will not happen on its own. There is no policy to link to, and no toggle
to offer, because there is no decision left for anyone to make.

The second state is not only the failure case. The reconciler decides from relay topology,
not from image staleness, so the rebuild is a side effect of the restart rather than a
response to a new image. On a released Server the two move together — a new target image
means a new Server version means a restart — but on a deployment tracking a floating tag
the target can move without one, and then nothing recreates anything. The Server reports
that as "stuck" too, because from the operator's side it is the same fact: this sandbox is
on the old image and will stay there.

---

## How the two specs use this

- **[`settings-redesign.md`](./settings-redesign.md)** (server) references this document for
  status intents, the auto-save model, the glossary, and the credential-derivation pattern. It
  owns only what is server-specific: the required-setup checklist header, Group 2/4 layout,
  and reprovision-all copy. Its **Sandbox auto-updates** panel is gone — the toggles it
  described were removed once Verity started repairing its own sandboxes. Its residual
  `amber` references are replaced by `Needs setup` (`needsSetup`) per the [status
  rules](#rules-that-bind-both-screens).
- **[`project-screen-redesign.md`](./project-screen-redesign.md)** (project) references this
  document for the same four things. It owns only what is project-specific: the overview /
  settings-sub-screen split, the Container card with **Sandbox image** / **Update sandbox** /
  **Refresh token**, the `Config changed — Reprovision to apply` banner, and the `DOPPLER`
  section. Its `§6` muted status rows are re-specified here as `optional` (with `Bound` as
  `transient`), and "Repair" is renamed to **Reprovision**.

When either surface changes a status word, a save behaviour, or a lifecycle verb, change it
**here first**, then let both specs pick it up by reference. That is the whole point of this
file: the shared vocabulary can never drift because there is only one copy of it.
