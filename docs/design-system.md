# Verity Design System

Status: appearance decided, not yet implemented; behavior in effect · Owner of: appearance,
components, screen patterns, status intents, interaction and wording

This document is the single source of truth for how Verity looks and behaves.

- **Part I — Appearance:** color roles, typography, spacing, shape and elevation tokens, the
  shared components with their states, and the screen patterns built from them.
- **Part II — Behavior and wording:** the status intents and their words, the auto-save
  model, navigation, the confirmation policy, the wording glossary and the credential
  patterns.
- **Part III — Implementation:** how the appearance moves into the app.

Every screen in the mobile app — and, where practical, the web surfaces that ship with
Verity — follows what is specified here. Surface specs reference sections of this document
and restate nothing; if one disagrees with it, this document wins.

# Part I — Appearance

## 1. Principles

1. **One visual language.** The app, the public preview PIN page and the website share one
   palette, one typeface and one set of shapes. No screen keeps its own palette.
2. **Dark is the designed theme.** Every decision is made for the dark theme first. The light
   theme is derived from the same roles and must be clean and readable, but receives no
   separate visual polish: no tuned gradients and no glow (see Elevation).
3. **Roles, not values.** Components use named roles (`action`, `surface`, `attention`…),
   never raw hex values or ad-hoc transparencies.
4. **Calm by default.** Little text, quiet actions, color only where it carries meaning.
   Glow is reserved for a few defined uses (see Elevation).
5. **One of each.** Every component exists once, with all its states. A new screen is
   assembled from existing components; a genuinely new component is added here first.

## 2. Color

### Palette and roles

| Role            | Token         | Dark                | Light                  | Use                                                                                    |
| --------------- | ------------- | ------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| Background      | `background`  | `#07080d`           | `#f6f7fa`              | Screen background                                                                      |
| Surface         | `surface`     | `#0c0e17`           | `#ffffff`              | Cards, grouped lists, sheets                                                           |
| Raised surface  | `surfaceAlt`  | `#111422`           | `#eef0f5`              | Inputs, secondary buttons, toggle track (off)                                          |
| Border          | `border`      | `#22263a`           | `#dde1ea`              | 1 px outline of cards and fields, dividers                                             |
| Text            | `text`        | `#f5f5f8`           | `#0d0f17`              | Titles and body                                                                        |
| Muted text      | `textMuted`   | `#a5a8b8`           | `#4a4f62`              | Subtitles, values, labels, section headers in lists, icons                             |
| Faint text      | `textFaint`   | `#80849a`           | `#62677c`              | Placeholders, footnotes, chevrons, inactive                                            |
| Action          | `action`      | `#18c8f5`           | `#056485`              | Everything that can be tapped: buttons, links, focus, toggle (on)                      |
| Action label    | `actionLabel` | `#6fdcf8`           | `#055a78`              | Label of the tonal primary button                                                      |
| Signature       | `signature`   | `#ff18b7`           | `#b0107d`              | Brand only: content-screen eyebrows, Premium icon, success moment. **Never an action** |
| Success         | `success`     | `#2ee6a6`           | `#0e6845`              | Connected, active, done                                                                |
| Attention       | `attention`   | `#ff5c8a`           | `#d84f74`              | Errors, rejected states, outline of destructive buttons                                |
| Scrim           | `scrim`       | `rgba(3,4,8,0.72)`  | `rgba(10,12,20,0.40)`  | The single backdrop behind sheets and dialogs                                          |

### Rules

- **Action is cyan, signature is pink.** Pink never marks something tappable; cyan never
  decorates.
- **Red means a problem, nothing else.** Errors, rejected states and destructive actions use
  `attention` (red). There is no orange/amber, and red is never used for decoration.
- **Transparencies are derived from roles** with a fixed set of strengths:
  - 6 % for neutral tints (icon tiles, pressed rows)
  - 14 % for tonal fills (primary button, tags)
  - 35 % for tonal borders
- **Icons are thin line icons** (Feather, the app's existing set) in `textMuted`. No emoji, no
  multicolored icons. The only colored icon is the Premium mark in `signature`.

## 3. Typography

Typeface: **Inter** (variable, bundled with the app; already used by the website). Code and
keys use the platform monospace font. All sizes scale with the in-app font-zoom factor.

| Style     | Size | Weight | Tracking | Line height | Color       | Use                                             |
| --------- | ---- | ------ | -------- | ----------- | ----------- | ----------------------------------------------- |
| Display   | 28   | 750    | −0.035em | 1.15        | `text`      | Large headline at the top of a content screen   |
| Title     | 20   | 700    | −0.02em  | 1.25        | `text`      | Sheet, dialog and section titles                |
| Row       | 17   | 600    | 0        | 1.3         | `text`      | Titles in cards and list rows                   |
| Body      | 15   | 400    | 0        | 1.5         | `text`      | Running text, explanations, chat                |
| Button    | 15   | 700    | 0        | 1           | per variant | Button and link labels                          |
| Subtitle  | 13   | 400    | 0        | 1.4         | `textMuted` | Second line under titles                        |
| Footnote  | 12   | 400    | 0        | 1.4         | `textFaint` | Versions, timestamps, hints                     |
| Eyebrow   | 11   | 800    | 0.18em   | 1.2         | `signature` | Uppercase group header on content screens       |
| Label     | 11   | 700    | 0.14em   | 1.2         | `textMuted` | Uppercase section headers in lists, tags  |
| Code      | 14   | 400    | 0        | 1.4         | `text`      | Branches, commands, keys (monospace)            |

- Weights in use: 400, 600, 700, plus 750 for Display and 800 for Eyebrow only.
- **Section headers:** `Label` style (grey) in navigation and settings lists; `Eyebrow`
  style (pink) only on content screens with few sections (e.g. Verity Premium, meetings).

## 4. Spacing, shape and elevation

**Spacing scale:** `2 · 4 · 8 · 12 · 16 · 24 · 32 · 48`. No other values.

| Value | Typical use                                |
| ----- | ------------------------------------------ |
| 2     | Title to subtitle                          |
| 4     | Icon to text inside one line               |
| 8     | Between cards of one group                 |
| 12    | Padding of small elements                  |
| 16    | Card padding, screen margin                |
| 24    | Between groups                             |
| 32    | Between large sections                     |
| 48    | Space above a Display headline             |

**Radii:**

| Token   | Value | Use                                       |
| ------- | ----- | ----------------------------------------- |
| `card`  | 16    | Cards, grouped lists, sheet top corners   |
| `control` | 12  | Buttons, fields, icon buttons             |
| `tile`  | 10    | Icon tiles inside rows                    |
| `tag`   | 6     | Status tags                               |
| `round` | 999   | Toggles, dots                             |

**Elevation:**

| Level     | Look                                                        | Use                                              |
| --------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Flat      | 1 px `border`, no shadow                                    | Cards and lists — the default                    |
| Floating  | Soft dark shadow downward (`0 18px 50px` black at 60 %)     | Sheets, menus, dialogs                           |
| Glow      | Colored halo                                                | Three uses only: brand moments in `signature` (success check), the selected card in `action`, and success and attention status dots in their tone. Buttons never glow. Dark theme only — in light, the selected card keeps its plain border and dots have no halo. |

## 5. Components

Each component is implemented once in a shared module and covers every state listed.
Disabled is always 40 % opacity; pressed is always a slight darkening.

### 5.1 Button

| Variant     | Look                                                            | Use                                                      |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| Primary     | Tonal: `action` at 14 % fill, 35 % border, `actionLabel` text   | The single main action of a screen                       |
| Secondary   | `surfaceAlt` fill, `border` outline, `text` label               | Further actions, Cancel                                  |
| Text        | No container, `action` label                                    | Quiet actions inside cards ("Replace")                   |
| Destructive | No fill, `attention` outline and label                          | Remove, delete — always preceded by a confirmation       |

- Sizes: **large 48** (full width, pinned at the bottom of a flow), **compact 36** (inside
  cards and rows, as wide as its label), **icon 40** (square, one symbol).
- States: default, pressed, disabled, loading. Loading keeps the label, adds a spinner in
  front and keeps the width; the button is locked while loading.
- At most one primary button per screen. Labels are verbs ("Activate", "Copy", "Remove key"),
  never "OK" or "Yes".

### 5.2 Card and list row

- **Grouped list:** several rows of the same kind share one surface with 1 px dividers
  (settings navigation, diagnostics).
- **Card:** a single item with its own state or control stands alone (subscription,
  each feature switch). Cards of one group are 8 apart.
- **Row anatomy** (minimum height 56):
  - **Leading (optional):** icon tile 36 (radius 10, 6 % tint, icon in `textMuted`) or a
    status dot.
  - **Center:** title in `Row`, at most one subtitle in `Subtitle`. Never more than two lines.
  - **Trailing:** exactly one of value (muted), tag, toggle or compact button. The chevron
    `›` appears only when the row navigates.
- States: default, pressed (slightly darker surface), disabled (40 %), selected (`action`
  border with glow).

### 5.3 Text field

- Label above the field in `Subtitle` style (13, muted).
- Field: height 48, radius 12, `surfaceAlt` fill, 1 px `border`, value in `Body`.
- Focus: `action` border plus a 3 px `action` ring at 20 %.
- Error: subtle `attention` border and a **hint box** below the field — red tint, a short
  bold title ("Key not recognized") and one explanatory sentence. The entered text stays in the
  field so it can be corrected, but nothing is saved until it is valid (see
  [§ 9](#errors-and-validation)). No dialog.
- Variants:
  - **Single line**
  - **Secret:** masked, with a reveal control, never offered to the password manager
  - **Multiline:** grows up to six lines

### 5.4 Status

- **Tag** — the state of a single element: uppercase `Label` text on a 14 % tint of its
  tone, radius 6. Tones: success (`success`), attention (`attention`) and neutral
  (`textMuted` label on a 6 % `text` tint). Examples: `ACTIVE`, `SOON`, `UPDATE`.
- **Dot and word** — rows in pure status lists: an 8 px dot in its tone (`textFaint` when
  neutral) followed by a muted word. Example: `● Connected`.
- Bordered pills are retired. A state is never shown by color alone — a word is always
  present.
- Mapping from the status intents in [§ 8](#8-status-intents):

  | Intent       | Tag                  | Dot and word                 |
  | ------------ | -------------------- | ---------------------------- |
  | `ready`      | success tone         | success dot                  |
  | `needsSetup` | attention tone       | attention dot                |
  | `optional`   | muted word; neutral tag only for `Soon` on feature cards | faint dot |
  | `transient`  | spinner + muted word | spinner + muted word         |

### 5.5 Toggle

- Filled track: off = `textFaint` track, white knob; on = `action` track, white knob. Both
  tracks reach at least 3 : 1 against `surface`. The white knob has a 1 px `background`
  outline, keeping its position distinguishable against either track at at least 3 : 1.
- States: on, off, disabled, switching (spinner in the knob until the server confirms).
- The whole row is tappable, not just the toggle. Switching something off that has
  consequences (e.g. revoking public links) asks first.

### 5.6 Sheet

- One bottom-sheet component for every overlay that slides up.
- Single `scrim`, grab handle, top corners 16, `Floating` elevation.
- Header: `Title` on the left, close control on the right. Confirmations ([§ 5.7](#57-confirmation))
  omit the close control; Cancel and dismissal cover it.
- Content uses the same components as screens. At most one primary button, full width, at
  the bottom. Dismissal by dragging down, tapping the scrim or the close control.

### 5.7 Confirmation

Confirmations use a compact Verity sheet instead of the platform alert:

- The question is the title ("Turn off Online sharing?"), followed by one sentence about the
  consequence.
- Two buttons: Cancel (secondary) and the action as a verb (destructive variant when
  destructive).
- Dragging down, tapping the scrim or going back always cancels; nothing is ever executed by
  dismissal.
- VoiceOver announces the question on open and keeps focus inside the sheet until it closes.
- While the action runs, its button shows a spinner and is locked.
- Only for decisions. Information without a decision belongs in the screen as a row or hint
  box.

## 6. Patterns

### 6.1 Settings screen

System navigation title, then sections: a grey `Label` header followed by a grouped list.
State on the right as a tag (`UPDATE`, `ACTIVE`), plain values muted ("On").

### 6.2 Step flow

For anything that is set up: **explain → enter → success**.

- **Explain:** Display headline (second line may use `signature`), one lead sentence, a few
  cards describing what the step unlocks.
- **Enter:** the field(s) of the step. Errors stay in place as hint boxes.
- **Success:** the brand moment — a pink check tile with glow, short confetti, success
  haptic; then continue.
- The primary action is pinned at the bottom of the screen, always in the same place. On the
  success step it becomes secondary ("Continue").

### 6.3 Status list

For diagnostics and overviews:

- **Order:** state first (what is), then actions (tests), then everything else.
- **State rows:** they use dot and word.
- **Reasons:** they appear only when something deviates ("Switched off in Verity Premium").
- **Refresh:** status loads when the screen opens and after a test; it does not poll.

## 7. Accessibility

- Every text role (`text`, `textMuted`, `textFaint`, `action`, `actionLabel`, `signature`,
  `success`, `attention`) meets at least 4.5 : 1 on `background`, `surface` and `surfaceAlt` in
  both themes; colored text also meets it on its own 14 % tint. This is why the light theme
  uses darker variants.
- Every interactive element is at least 44 × 44 pt (rows 56, buttons 48 or 36 with padded
  hit area).
- Non-text controls and their states (toggle tracks, field borders on focus, selected card
  borders) reach at least 3 : 1 against their background.
- State is always expressed in words as well as color.
- All type scales with the in-app font zoom and the platform text size.
- Focus order follows reading order. Sheets and confirmations trap focus while open.

# Part II — Behavior and wording

## 8. Status intents

Every status shown anywhere in the app is one of **four intents**. The intent decides the
meaning and the words; [§ 5.4 Status](#54-status) decides how each intent is drawn (tag or
dot and word) and in which color.

### The four intents

| Intent | Meaning | Example labels |
| --- | --- | --- |
| `ready` | Works, nothing to do | Connected, Configured, Active, Running, Minted, Signing ready, Unlocked, Up to date |
| `needsSetup` | Something required is missing or failed | Needs setup, Update available, Rejected, Error |
| `optional` | Optional and empty — not a to-do | Optional, Not configured, Off |
| `transient` | In motion | Saving…, Checking, Starting, Stopping, Bound, Reprovisioning X/N |

### Status rules

- An `optional` state is never counted as a to-do and never uses the `needsSetup`
  appearance.
- The word **`Not configured`** is reserved for `optional`. A *required* thing that is
  missing says **`Needs setup`** (`needsSetup`), never `Not configured`.
- `transient` covers every in-flight state, including `Bound` (the in-progress Doppler
  step) and `Reprovisioning X/N`. It always shows a spinner next to its word.
- Meaning is never conveyed by color alone: every status renders its word.

### Status accessibility

- Every status sets `accessibilityRole` and `accessibilityState`. The accessible label
  reads the **word plus its intent** (e.g. "Connected, ready").
- `transient → settled` transitions are announced through a **live region** so a state
  change is perceivable without sight of the spinner.
- A tappable status has a minimum interactive height of **44 pt**.

## 9. Saving and interaction

Settings auto-save. There is **no Save button and no Reset button anywhere**, and the
`n/6` / `n/8` progress counters are retired.

### When each control saves

| Control type | When it saves | Feedback |
| --- | --- | --- |
| Toggle | immediately on flip | spinner in the knob until the server confirms |
| Text (name, email, paths, command, ports, branch) | on blur, debounced; **invalid values are not persisted** | per-field `saving… → saved ✓` |
| Secret paste (SSH key, Doppler token) | on blur; write-only, never echoed back | per-field `saving… → saved ✓` |
| Selection / picker (default model, Doppler binding) | on selection commit | per-field `saving… → saved ✓` |

### Aggregate save signal

The aggregate signal is **identical on both surfaces**: a subtle global `Saving…` /
`✓ All changes saved` line, plus a `Last saved HH:MM` footer. This appears on the server
Settings screen **and** on the project settings sub-screen — the sub-screen must not drop
it.

### Errors and validation

- Errors are **per-field and inline**, shown as the hint box from [§ 5.3](#53-text-field) —
  never a toast, never a floating bar.
- **Invalid values are not saved.** The entered text stays visible with the inline hint box
  so it can be corrected; the stored value remains the last valid one. Leaving the screen
  without correcting it discards the invalid text.
- **Sealed secret store:** a `503` from a sealed store on *any* secret field — the server
  SSH signing key **and** the project Doppler token — shows `Unlock the secret store first`
  under that field and reverts the value. The project Doppler-token field inherits this
  sealed-store gating verbatim.

### Applying config to a running container

Persisting a setting and applying it are two different things:

- **Persisting** a setting is silent.
- **Applying** a persisted setting to a running container is a deliberate, confirmed
  **Reprovision** (see [§ 11 Wording](#11-wording)).
- Both screens surface a **"changes pending since provisioned"** affordance. On the
  project, editing the dev-server command/ports or the Doppler binding on the Configure
  sub-screen raises a **"Config changed — Reprovision to apply"** banner on the overview
  Container card, mirroring the server's non-sticky Reprovision card. A silent edit on one
  screen followed by a manual tap on another, with no banner, is not acceptable.

### Destructive-action confirmation (one policy)

- **Any container recreation is confirmed** with the confirmation sheet from
  [§ 5.7](#57-confirmation): server Reprovision, project Reprovision, and Update sandbox.
- **Purge and Delete** keep their existing, stronger confirmation flows; this sheet does not
  replace them.
- **Token refresh** and **dev-server start / stop / restart** are *not* destructive and
  need **no** confirmation.

## 10. Navigation model

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

## 11. Wording

### Glossary

One decision per contested term. These labels are used **verbatim** everywhere.

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
| **Soon** | `optional`: an announced feature that is not available yet | Verity Premium feature list (Teams) | `Off` (switched off) / `Not included` (not granted) |
| **Update** | Short `needsSetup` tag for `Update available`, used where the row subtitle names the version | Settings row "Server update" | `Update sandbox` (the action) |
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

## 12. Credential and sandbox patterns

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

## 13. How surface specs use this document

- **[`settings-redesign.md`](./settings-redesign.md)** (server) references this document for
  status intents, the auto-save model, the glossary, and the credential-derivation pattern. It
  owns only what is server-specific: the required-setup checklist header, Group 2/4 layout,
  and reprovision-all copy. Its **Sandbox auto-updates** panel is gone — the toggles it
  described were removed once Verity started repairing its own sandboxes. Its residual
  `amber` references are replaced by `Needs setup` (`needsSetup`) per the [status
  rules](#status-rules).
- **[`project-screen-redesign.md`](./project-screen-redesign.md)** (project) references this
  document for the same four things. It owns only what is project-specific: the overview /
  settings-sub-screen split, the Container card with **Sandbox image** / **Update sandbox** /
  **Refresh token**, the `Config changed — Reprovision to apply` banner, and the `DOPPLER`
  section. Its `§6` muted status rows are re-specified here as `optional` (with `Bound` as
  `transient`), and "Repair" is renamed to **Reprovision**.

When a surface changes a status word, a save behavior, or a lifecycle verb, change it
**here first**, then let the surface specs pick it up by reference. The shared vocabulary
can never drift because there is only one copy of it.

# Part III — Implementation

## 14. Implementation

1. **Theme:** move the roles, type scale, spacing, radii and elevation into
   `apps/mobile/theme/tokens.ts` and bundle Inter. Retire the separate `colors.setup.*`
   palette and the meeting override palette (`components/meeting/meetingPalette.ts`).
   The current status tones map as follows: `tone.done` becomes `success`, `tone.danger`
   becomes `attention` (red), and the existing amber `tone.attention` is removed. Until
   that lands, `tone.attention` in code still means amber and must not be used for errors.
2. **Components:** implement section 5 as one shared module. It replaces the duplicated
   building blocks in `components/settings/SettingsChrome.tsx`,
   `components/premium/PremiumChrome.tsx` and the local button, pill, chip, input and sheet
   styles across screens. The shared status component (tag and dot, driven by `intent` and
   `label`) replaces `apps/mobile/components/StatusPill.tsx`; surface specs that name
   `StatusPill.tsx` refer to it.
3. **Catalog:** add a developer screen that renders every component in every state. It
   becomes the visual reference for future work, also on the web.
4. **Enforcement:** add a check that rejects raw colors and font sizes outside the theme, and
   a contributor rule that UI is built from the shared components.
5. **Migration:** move screens area by area, starting with Settings.

The visual workbench used to reach these decisions is
[`design-system/index.html`](./design-system/index.html). It shows every component and pattern
rendered with the decided values.
