# Verity Mobile — Design Language

This document is the single source of truth for the shared design language of the
Verity mobile control plane. It owns the status pill, the auto-save and interaction
model, the navigation model, the wording glossary, and the shared component and token
contracts.

Both surface specs — [`settings-redesign.md`](./settings-redesign.md) (the server
Settings screen) and [`project-screen-redesign.md`](./project-screen-redesign.md) (the
project overview and its settings sub-screen) — **defer to this document**. Where they
touch the pill, the save experience, a lifecycle verb, or a status word, they reference
the relevant section here and restate nothing. If a rule appears both here and in a
surface spec and the two disagree, this document wins.

The purpose is narrow and deliberate: the redesign exists to kill status and vocabulary
sprawl. Two engineers building one screen each must ship the *same* pill and the *same*
save experience. That is only guaranteed if the pill, the save model, and the words are
defined once, in a neutral place. This is that place.

---

## Status system

There is exactly **one** status pill across both surfaces, implemented by a single
component (see [Shared components & tokens](#shared-components--tokens)) and driven by an
`intent` prop. It has **four intents**. Three of them render a pill; one (`optional`)
renders no pill at all.

### The four intents

| Intent | Tone token (light / dark) | Glyph | Chrome | Example labels |
| --- | --- | --- | --- | --- |
| `ready` | `tone.done` `#3aa657` / `#28e6a4` | `✓` | dot + hairline border + background in tone; **word in `text`** | Connected, Configured, Active, Running, Minted, Signing ready, Unlocked, Up to date |
| `needsSetup` | `tone.danger` (Himbeere) `#d84f74` / `#ff5c8a` | `!` | dot + hairline border + background in tone; **word in `text`** | Needs setup, Update available, Error |
| `optional` | none — `textMuted` `#5b6770` / `#9a9ec9` | none | **no pill, no dot** — right-aligned muted detail text only | Optional, Not configured |
| `transient` | none — neutral | spinner (no tone) | spinner + word; no dot, no border, no background | Saving…, Checking, Starting, Stopping, Bound, Reprovisioning X/N |

All hex values above are the real per-theme values from
[`apps/mobile/theme/tokens.ts`](../apps/mobile/theme/tokens.ts). No new token is
introduced for the status system: `tone.done`, `tone.danger`, and `textMuted` cover all
four intents in both themes.

### When to render a pill vs. muted text

- **Render a pill** for `ready`, `needsSetup`, and `transient`. These are states that
  demand the eye: something works, something required is missing, or something is in
  motion.
- **Render muted text — never a pill, never a dot —** for `optional`. An optional-and-empty
  thing is not a to-do and is excluded from any to-do count. It is a right-aligned muted
  detail, e.g. `Optional` or `Not configured`.
- The word **`Not configured`** is reserved for the `optional` intent and **must never be
  rendered in Himbeere**. A *required* thing that is missing uses **`Needs setup`**
  (`needsSetup`), not `Not configured`.

### Rules that bind both screens

- **Word colour is always `text`** (or `textMuted` for `optional`), at a contrast ratio
  of at least **4.5:1**. Tone drives only the dot, the border, and the background.
  Colouring the *word* in the tone is prohibited.
- **Every non-optional pill carries its leading glyph in the visible text** — `✓` for
  `ready`, `!` for `needsSetup` — not just in the coloured dot. Meaning is never conveyed
  by colour alone. Mockups render `✓ Connected`, `✓ Active`, `✓ Minted`, `! Needs setup`,
  never a bare `● Connected`.
- **The optional/empty state is chrome-less muted text.** There is no muted *pill* and no
  muted *dot* anywhere in the system.
- **`Amber` (`tone.attention`) is retired from the status system on both screens.** It is
  not a valid pill intent. The token remains in `tokens.ts` but must not appear in any
  status usage. (Its remaining non-status use in the project warning banner is an open
  design call, not a status-pill concern.)
- The **`transient`** variant is a spinner plus a word, with no tone, dot, border, or
  background. It covers every in-flight state, including `Bound` (the in-progress Doppler
  step) and `Reprovisioning X/N`.

### Accessibility

- Every pill sets `accessibilityRole` and `accessibilityState`. The accessible label
  reads the **word plus its state** (e.g. "Connected, ready").
- `transient → settled` transitions are announced through a **live region** so a state
  change is perceivable without sight of the spinner.
- Minimum **44 pt** interactive height on any pill that is tappable.
- Because the glyph is in the text and the word is at ≥ 4.5:1, no status is
  colour-only.

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
setup is surfaced by its **per-card pills** and the **changes-pending banner**, not by a
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
| **Ready** | Green terminal state meaning "this works / nothing to do" | The intent name in the pill spec; not a user-facing word by itself | The literal label `Ready` |
| **Connected** | Green label for "external service link established" | GitHub, AI backends, Secret store (`Unlocked`), dev-server-reachable | `Configured` |
| **Configured** | Green label for "a value is stored here" | Signing key stored, Doppler token pasted, default model set | `Connected` |
| **Active** | Green label for container liveness | The container lifecycle pill (`Active / Failed / Absent` → green / Himbeere / muted) | `Running` |
| **Running** | Green label for a *process* being up | The dev-server process pill | `Active` (container) |
| **Needs setup** | Himbeere state for a **required** thing that is missing | Signing unconfigured, GitHub unconnected, dev-server `Error` / `Unreachable`, sandbox `Update available` | `Not configured` (which is optional / muted) |
| **Not configured** | Muted state for an **optional** thing that is empty | Doppler when unset, optional dev-server absence | `Needs setup` (required → Himbeere). Never render this phrase in Himbeere |
| **Optional** | Muted right-aligned detail, no pill, excluded from any to-do count | Server Doppler; project Monitors; any configured-but-optional item | A green "done" pill |
| **Account Doppler token** | The server-level token that lets projects bind Doppler secrets | Server Group 3 Doppler card | Doppler binding (the per-project consumer) |
| **Doppler binding** | The per-project mapping (project → config) that consumes the account token | Project Configure sub-screen | Account Doppler token (its prerequisite) |
| **Minted** | Green: the Doppler binding has a live minted secret | Project Doppler binding, green pill only | `Bound` (the in-progress step) |
| **Bound** | The binding exists but is not yet minted — an **in-progress**, not optional, state | Project Doppler binding, rendered as `transient` (spinner + word), **not** muted | `Minted` (done) / `Optional` (muted) |

### Green-word convention

Use the right green word for the right kind of "done", and ban ad-hoc synonyms:

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
- **`Minted`** — the binding has a live minted secret. `ready` (green pill).

---

## Shared components & tokens

Define each of these **once**, in the home listed. Both specs reference the home; neither
restates it.

| Artifact | Home | Notes |
| --- | --- | --- |
| **`StatusPill` component** | [`apps/mobile/components/StatusPill.tsx`](../apps/mobile/components/StatusPill.tsx) | Props `{ intent: 'ready' \| 'needsSetup' \| 'optional' \| 'transient', label }`. Replaces the four hand-rolled pills (`settings.tsx` StatusPill/StatePill, `project/[id].tsx` inline statusPill/StatePill). Both rollout lists reference this path, not prose. |
| **Pill intent → (glyph, tone token, word colour, chrome) map** | `design-language.md` § [Status system](#status-system) | Owns the `✓` / `!` glyph dictionary, the "optional = no pill" rule, and the "transient = spinner" rule. |
| **Pinned pill geometry & type** | `StatusPill.tsx` + this document | `radius.pill` (`999`), one hairline border, one font weight, one uppercase decision — resolved into a single spec, not left to per-screen taste. |
| **Auto-save model** (full table + aggregate line + `Last saved` footer + validation + sealed-store `503`) | `design-language.md` § [Auto-save & interaction](#auto-save--interaction) | Both specs reference by section and restate nothing. |
| **Container-lifecycle glossary** (Reprovision / Update sandbox / Refresh token) | `design-language.md` § [Wording glossary](#wording-glossary) | The one canonical verb set. |
| **Account → project credential-derivation pattern** | `design-language.md` § [Credentials](#credential-derivation-pattern) | One pattern, instantiated twice; named reciprocally on both screens. |
| **Tokens** | [`apps/mobile/theme/tokens.ts`](../apps/mobile/theme/tokens.ts) (unchanged) | `tone.done`, `tone.danger`, `textMuted` cover all four intents in both themes. **No new token needed.** `tone.attention` stays in the file but is removed from all status usage. |

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
  the pill, the auto-save model, the glossary, and the credential-derivation pattern. It
  owns only what is server-specific: the required-setup checklist header, Group 2/4 layout,
  and reprovision-all copy. Its **Sandbox auto-updates** panel is gone — the toggles it
  described were removed once Verity started repairing its own sandboxes. Its residual
  `amber` references are replaced by `Himbeere / Needs setup` per the [status
  rules](#rules-that-bind-both-screens).
- **[`project-screen-redesign.md`](./project-screen-redesign.md)** (project) references this
  document for the same four things. It owns only what is project-specific: the overview /
  settings-sub-screen split, the Container card with **Sandbox image** / **Update sandbox** /
  **Refresh token**, the `Config changed — Reprovision to apply` banner, and the `DOPPLER`
  section. Its `§6` muted-pill rows are re-specified here as muted detail text (with `Bound`
  as `transient`), and "Repair" is renamed to **Reprovision**.

When either surface changes a status word, a save behaviour, or a lifecycle verb, change it
**here first**, then let both specs pick it up by reference. That is the whole point of this
file: the shared vocabulary can never drift because there is only one copy of it.
