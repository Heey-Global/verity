# Verity Design System

Status: decided, not yet implemented · Owner of: visual foundations, components, screen patterns

This document is the single source of truth for how Verity looks. It defines the color
roles, typography, spacing, shape and elevation tokens, the shared components with their
states, and the screen patterns built from them. Every screen in the mobile app — and, where
practical, the web surfaces that ship with Verity — is built from what is specified here.

[`design-language.md`](./design-language.md) keeps owning behavior: the auto-save model,
navigation, confirmation policy and the wording glossary. Where that document describes how
something _looks_ (for example the status pill and its tones), this document replaces it.

## 1. Principles

1. **One visual language.** The app, the public preview PIN page and the website share one
   palette, one typeface and one set of shapes. No screen keeps its own palette.
2. **Dark is the designed theme.** Every decision is made for the dark theme first. The light
   theme is derived from the same roles and must be clean and readable, but receives no
   separate visual polish: no tuned gradients, and glow is replaced by the plain border (selected
   card) or omitted (status dots).
3. **Roles, not values.** Components use named roles (`action`, `surface`, `attention`…),
   never raw hex values or ad-hoc transparencies.
4. **Calm by default.** Little text, quiet actions, color only where it carries meaning.
   Glow is reserved for brand moments.
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
| Muted text      | `textMuted`   | `#a5a8b8`           | `#5a5f73`              | Subtitles, values, labels, section headers in lists, icons                             |
| Faint text      | `textFaint`   | `#80849a`           | `#62677c`              | Placeholders, footnotes, chevrons, inactive                                            |
| Action          | `action`      | `#18c8f5`           | `#066a8c`              | Everything that can be tapped: buttons, links, focus, toggle (on)                      |
| Action label    | `actionLabel` | `#6fdcf8`           | `#055a78`              | Label of the tonal primary button                                                      |
| Signature       | `signature`   | `#ff18b7`           | `#b0107d`              | Brand only: content-screen eyebrows, Premium icon, success moment. **Never an action** |
| Success         | `success`     | `#2ee6a6`           | `#13744f`              | Connected, active, done                                                                |
| Attention       | `attention`   | `#a99bff`           | `#5b4bc4`              | Errors, rejected states, outline of destructive buttons                                |
| Scrim           | `scrim`       | `rgba(3,4,8,0.72)`  | `rgba(10,12,20,0.40)`  | The single backdrop behind sheets and dialogs                                          |

### Rules

- **Action is cyan, signature is pink.** Pink never marks something tappable; cyan never
  decorates.
- **There is no red and no orange/amber.** Problems use `attention` (lavender).
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
| Glow      | Colored halo                                                | Two uses only: brand moments in `signature` (success check) and the selected card in `action`. Buttons never glow. Dark theme only. |

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
- Error: subtle `attention` border and a **hint box** below the field — lavender tint, a short
  bold title ("Key not recognized") and one explanatory sentence. The entered value is kept.
  No dialog.
- Variants:
  - **Single line**
  - **Secret:** masked, with a reveal control, never offered to the password manager
  - **Multiline:** grows up to six lines

### 5.4 Status

- **Tag** — the state of a single element: uppercase `Label` text on a 14 % tint of its
  tone, radius 6. Tones: success, attention, neutral. Examples: `ACTIVE`, `SOON`, `UPDATE`.
- **Dot and word** — rows in pure status lists: an 8 px dot (with a soft glow for success
  and attention) followed by a muted word. Example: `● Connected`.
- Bordered pills are retired. A state is never shown by color alone — a word is always
  present.
- Mapping from the status intents in [`design-language.md`](./design-language.md#status-system):

  | Intent       | Tag                  | Dot and word                 |
  | ------------ | -------------------- | ---------------------------- |
  | `ready`      | success tone         | success dot                  |
  | `needsSetup` | attention tone       | attention dot                |
  | `optional`   | no tag — muted word  | faint dot                    |
  | `transient`  | spinner + muted word | spinner + muted word         |

### 5.5 Toggle

- Filled track: off = `border` track, white knob; on = `action` track, white knob.
- States: on, off, disabled, switching (spinner in the knob until the server confirms).
- The whole row is tappable, not just the toggle. Switching something off that has
  consequences (e.g. revoking public links) asks first.

### 5.6 Sheet

- One bottom-sheet component for every overlay that slides up.
- Single `scrim`, grab handle, top corners 16, `Floating` elevation.
- Header: `Title` on the left, close control on the right.
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
- State is always expressed in words as well as color.
- All type scales with the in-app font zoom and the platform text size.
- Focus order follows reading order. Sheets and confirmations trap focus while open.

## 8. Implementation

1. **Theme:** move the roles, type scale, spacing, radii and elevation into
   `apps/mobile/theme/tokens.ts` and bundle Inter. Retire the separate `colors.setup.*`
   palette and the meeting override palette (`components/meeting/meetingPalette.ts`).
2. **Components:** implement section 5 as one shared module. It replaces the duplicated
   building blocks in `components/settings/SettingsChrome.tsx`,
   `components/premium/PremiumChrome.tsx` and the local button, pill, chip, input and sheet
   styles across screens.
3. **Catalog:** add a developer screen that renders every component in every state. It
   becomes the visual reference for future work, also on the web.
4. **Enforcement:** add a check that rejects raw colors and font sizes outside the theme, and
   a contributor rule that UI is built from the shared components.
5. **Migration:** move screens area by area, starting with Settings.

The visual workbench used to reach these decisions is
[`design-system/index.html`](./design-system/index.html). It shows every component and pattern
rendered with the decided values.
