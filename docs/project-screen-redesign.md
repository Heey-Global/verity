# Verity mobile Project screen — redesign spec

Status: proposed · Target: `apps/mobile/app/project/[id].tsx` (2409 lines) +
`packages/mobile/src/projectSettings.ts`

This spec defers to [`design-language.md`](./design-language.md) for the status pill, the
auto-save/interaction model, the wording glossary, and the credential-derivation pattern. It
restates none of those; it owns only what is project-specific.

Companion to [`settings-redesign.md`](./settings-redesign.md) (the **server**-level screen).
This one covers the **per-project** screen. Same principles — auto-save, one status model,
honest live state — plus one project-specific move: split **Configure / Operate / Automate**
into clear surfaces instead of one 2400-line stack.

---

## 1. Why

`project/[id].tsx` is a single `ScrollView` stacking nine sections
(`project/[id].tsx:179-209`): Header, Fields, **Lifecycle**, **Sandbox**, **Settings**,
**Concierge**, **Operations** (Dev Server + Monitors), Sessions, **Danger**. Grounded defects:

- **Dev-server config lives in two places.** The editable fields (command, URL, workdir,
  host/container port) are in the **Settings** section (`:1224-1254`); the *same* values are
  echoed read-only again in **Operations → Dev Server** (Command `:916`, URL `:925`, Workdir
  `:941`, Port `:952`). The user edits in one section and reads the result in another.
- **Three overlapping provision/repair entry points.** Lifecycle has Provision/Repair + Stop
  + Purge (`:502-551`), Concierge has its own Repair/Provision (`:651-669`), Sandbox has
  "Update Sandbox" which *also* recreates the container (`:341-356`). Three sections, one
  underlying "(re)provision this container" concept.
- **Same status-vocabulary sprawl as the old server screen.** Dev-server status is
  `Running / Checking / Inactive / Ready / Not configured / Error` (`:721-731`), Doppler
  binding uses a `Minted / Bound` `StatePill` (`:1402`), Sandbox uses
  `Current / Update available / Security update` (`:373-379`) — plus the same `n/8` counter
  and manual **Save** button (`:1192`, `:1256-1270`) this project is retiring elsewhere.
- **Config and live-ops are interleaved** so the screen answers neither "what's my project
  configured to do" nor "what's running right now" cleanly.
- **The mobile hierarchy collapses under one endless scroll.** The screenshots show project
  metadata, lifecycle controls, sandbox image data, eight settings, Concierge, Dev Server,
  Monitors, ten session rows, and the Danger zone at the same navigation depth. Sessions can
  grow without bound and push destructive project actions farther down the page. Card styling
  alone cannot fix this; these concerns need separate destinations.
- **Every datum gets a full-width card.** Container name, image, release, timestamps, and each
  empty setting carry the same visual weight as actionable runtime state. Related read-only
  facts belong in compact rows inside one card; editable values belong in grouped forms.
- **One missing Dev Server configuration is rendered as several failures.** The screenshots
  show `ERROR`, `project runtime is not configured` twice, `URL unset`, disabled Start/Stop,
  and an empty logs box for the same root cause. An unconfigured optional Dev Server is one
  calm empty state with one action, not a runtime error.
- **The settings summary contradicts its detail.** `SETTINGS 0/8` and eight empty chips appear
  directly above a green `MINTED` Doppler binding. The field counter is not a readiness signal
  and must be removed rather than recalculated.
- **Unavailable features look actionable.** `Add Monitor` is styled like a production action
  although no scheduler or persistence exists. Disabled lifecycle buttons retain strong
  button chrome without explaining their prerequisite.
- **Monitors is a front-end stub** buried at the bottom of Operations (`:1019-1125`); the
  setup prompt itself says "Do not implement backend scheduler changes yet" (`:72`). No
  server scheduler, schema, or persistence exists — yet it's the recurring-automation
  feature ("der Loop") and deserves a real home, not a corner of Operations.

## 2. Principles

Inherits all five from the server spec (one honest status model; auto-save; right altitude;
honest status; destructive stays explicit), plus:

6. **Configure / Operate / Automate are different surfaces.** Static config you set and
   forget; live runtime you watch and poke; recurring automation you schedule. Each gets its
   own space; none bleeds into the others.
7. **The project screen is an Operate-first overview.** Opening a project shows *what's
   happening now*; configuration lives one tap away.

---

## 3. Project navigation and the three-surface split

The project is a small hub, not one settings document. Use four stable destinations:

| Destination | Purpose | Contents |
| --- | --- | --- |
| **Overview** | What needs attention now? | project state, Dev Server runtime, Container maintenance, recent activity |
| **Sessions** | Work history | searchable/filterable session list; never embedded in full on Overview |
| **Automations** | Recurring work | Monitors/schedules and run history once implemented |
| **Settings** | Configure the project | branch/model, Dev Server config, Doppler binding, advanced details, Danger zone |

On compact layouts, Overview / Sessions / Automations use project-local tab or segmented
navigation; Settings opens from a conventional gear action in the header. Preserve destination
and scroll position when switching. The project name needs a two-line-safe title or compact
`owner / repo` treatment instead of unexplained truncation such as `heey-glob…`.

Overview renders only a short recent-activity preview (for example the latest three sessions)
with `View all sessions`. **Delete project moves to the bottom of Project settings**, away from
routine session content.

| Surface | What | Today's scattered home | New home |
| --- | --- | --- | --- |
| **Configure** | default branch/model; dev-server command/URL/workdir/ports; Doppler binding + token | `Settings` section | **Project settings** sub-screen (auto-save) |
| **Operate** | container lifecycle, sandbox update, GitHub-token refresh; dev-server start/stop/logs/health/preview; recent activity | `Lifecycle` + `Sandbox` + `Concierge` + `Operations→DevServer` + `Sessions` | **Project overview**; full history in **Sessions** |
| **Automate** | monitors / scheduled checks that can start sessions | `Operations→Monitors` (stub) | **Automations** destination (first-class; server work required) |

---

## 4. Project overview  (the screen you land on)

Operate-first. Live state at the top, maintenance below, recent activity kept short.

```
‹ Projects        owner/repo

┌───────────────────────────────────────┐
│  owner/repo              ✓ Active      │   container state pill (unified vocab)
│  ‹main · claude-sonnet-…›              │   default branch/model at a glance
└───────────────────────────────────────┘

── RUNNING NOW ─────────────────────────────
┌───────────────────────────────────────┐
│  Dev server              ✓ Running     │   merges today's Settings-config +
│  ‹npm run dev›                         │   Operations-runtime into ONE card
│  http://localhost:5173  ↗  Preview     │   the link that matters, up front
│  Health: Healthy (200) · checked 22:04 │
│  ▭ Restart   ▭ Stop      [▸] Logs      │   logs collapsed by default
│  ‹Command, ports → Project settings›   │   config is a link, not a duplicate echo
└───────────────────────────────────────┘

── RECENT ACTIVITY ─────────────────────────
┌───────────────────────────────────────┐
│  … latest three session rows …         │
│  View all sessions                  ›  │
└───────────────────────────────────────┘

── MAINTENANCE ─────────────────────────────
┌───────────────────────────────────────┐
│  Container               ✓ Active      │   ONE unified card replacing
│  ‹verity-owner-repo-…›                 │   Lifecycle + Sandbox + Concierge
│ ! Config changed — Reprovision to apply│   shown after a Configure auto-save
│  Sandbox image  v1.19.7 · Up to date   │   per-project image version surface
│  GitHub token   Refreshed 21:50        │
│  ▭ Reprovision ▭ Stop ▭ Update sandbox │   Reprovision recreates THIS container
│  ▭ Refresh token          [▸] More     │   Purge (destructive) under "More"
└───────────────────────────────────────┘

```

Key moves:

- **Dev server = one card.** Merge the Settings-config and Operations-runtime. Show the
  running state, the preview URL, health, and Start/Stop/Restart; collapse logs; link out to
  edit command/ports rather than echoing them read-only (kills the two-places defect).
- **Unconfigured Dev Server = one calm empty state.** Do not render Error, logs, PID, health,
  Start, and Stop when no command/URL exists. Show a short explanation and one
  `Configure dev server` action. Reserve Himbeere `! Error` for a configured process that
  attempted to start or was running and then failed.
- **Compact facts, prominent actions.** Container/image/version/timestamps become labelled
  rows inside the Container card or Advanced details, not individual full-width cards.
- **Container = one maintenance card.** Fold **Lifecycle + Sandbox + Concierge** into a
  single "Container" block: state, **Sandbox image** update status, GitHub-token status, and
  the actions **Reprovision** / Stop / **Update sandbox** / Refresh token. **Reprovision**
  recreates **this** project's container (the one canonical verb, replacing the old "Repair"
  label); **Update sandbox** is scoped to image bumps — a reprovision that specifically pulls
  a newer **Sandbox image**, which Verity otherwise applies on its own (the relay reconciler
  rebuilds every sandbox onto the current image after each Server restart), so the manual
  action is the escape hatch for when that repair has stalled, not the normal path. There is
  no server-side policy to set. **Purge clone** (destructive) moves under a
  "More" disclosure. This retires the three-way provision/repair split — one place owns "the
  container and its provisioning".
- **Config-changed banner.** After a relevant Configure auto-save (dev-server command/ports
  or the Doppler binding), the card raises a **"Config changed — Reprovision to apply"**
  banner, per design-language.md's "applying config to a running container".
- **Confirmation policy (per design-language.md).** Every container recreation —
  **Reprovision** and **Update sandbox** — is confirmed; **Refresh token** and dev-server
  Start / Stop / Restart are not destructive and need no confirmation.
- **Configuration is a door, not a section.** A single row routes to the project-settings
  sub-screen.

## 5. Project settings sub-screen  (Configure)  [answers "eigene Projekt Seite?"]

A dedicated route (e.g. `app/project/[id]/settings.tsx`) — this is the "own project page"
worth having. **Auto-save**, same model as the server spec (§4 there): text on blur,
per-field feedback, no Save/Reset button, `n/8` counter retired.

```
‹ owner/repo       Project settings

DEFAULTS
┌───────────────────────────────────────┐
│  Default branch          main          │   auto-save on blur
│  Default model           claude-…      │   → model picker, not free text
└───────────────────────────────────────┘

DEV SERVER
┌───────────────────────────────────────┐
│  Command                 npm run dev   │
│  URL                     http://loc…   │
│  Workdir                 (project root)│
│  Host port               5173          │
│  Container port          5173          │
│  ‹Live status & controls → overview›   │   reciprocal link back
└───────────────────────────────────────┘

DOPPLER
┌───────────────────────────────────────┐
│  Doppler binding         ✓ Minted      │   uses the account token from server
│  demo-project / dev                    │   Settings; picker flow unchanged
│  ▭ Change                              │
│  Doppler token           ‹write-only›  │   fallback paste, ✓ Configured / muted
└───────────────────────────────────────┘

✓ All changes saved · Last saved 22:06
```

- **Default model** becomes a picker (`useModels` is already loaded on this screen for the
  monitor model list — reuse it) instead of a free-text field.
- **One or multiple development servers:** the current API has one singular set of
  `devServer*` fields, so v1 presents one coherent server instead of pretending multi-server
  support exists. Supporting a web app plus Storybook/API/etc. is a follow-up data-model change:
  replace the singular fields with a stable-ID `developmentServers[]` collection and render one
  runtime card per entry. The navigation and Configure/Operate split already accommodate that
  expansion without another IA change.
- **Doppler binding** (`DopplerBindingSection`, `:1289`) keeps its guided project→config
  picker verbatim; only its status pill folds into the unified pill.
- The two Doppler concepts stay distinguishable from the **server**-level account token:
  here it's a per-project *binding*/token, there it's the account token that makes binding
  possible. Copy names them reciprocally: **"Doppler binding (uses the account token from
  server Settings)"**.
- **Aggregate save signal on this sub-screen.** Per design-language.md's auto-save model,
  the sub-screen carries the same subtle global `Saving…` / `✓ All changes saved` line plus a
  `Last saved HH:MM` footer — it must not drop it.
- **Sealed store.** The Doppler-token field inherits the sealed-store handling verbatim: a
  `503` shows `Unlock the secret store first` under the field and reverts the value.

## 6. Status system  (shared with the server spec)

Reuse the exact same pill (server spec §5): word in `text`/`textMuted` ≥ 4.5:1 + leading
glyph; tone only drives dot/border/background; **green = ready · Himbeere = needs setup ·
muted text = optional**. Map the current project vocab onto it:

| Today | New |
| --- | --- |
| Dev server `Running` | green `✓ Running` |
| Dev server `Ready` | muted `Ready` |
| Dev server absent, **optional** | muted `Not configured` (never Himbeere) |
| Dev server absent but **required** | Himbeere `! Needs setup` |
| Dev server `Error` / `Unreachable` | Himbeere `! Needs setup` |
| Sandbox image `Update available` / `Security update` | green `✓ Up to date` / Himbeere `! Update available` |
| Doppler `Minted` / `Bound` | green `✓ Minted` / `transient` `Bound` (spinner + word, not muted) |
| Container `Active` / `Failed` / `Absent` | green `✓ Active` / Himbeere `! Failed` / muted `Absent` |

Live/transient states (`Checking`, `Starting`, `Stopping`) keep a spinner + word, not a tone.

## 7. Automations (Monitors)  — first-class, needs server work

Monitors is the recurring-automation feature ("run certain activities on a schedule"). It is
currently a UI stub with **no backend** (`:72`, no scheduler/schema/persistence). The
redesign gives it a real home but is honest that it is not yet functional:

- Its own **Automations** destination (not buried under Dev Server in Operations).
- Until the backend exists, show an honest feature-preview empty state explaining what is
  missing. Do not render `Add monitor` as an enabled production action. A guided draft action
  may be offered only as `Draft a monitor`, with its non-running result kept accessible.
- **This is where "der Loop"/cron belongs.** When the scheduler is built, this area lists
  configured monitors with their schedule, last run, and last result — a real cron surface.

## 8. Rollout order

| # | Change | Effort |
| --- | --- | --- |
| 1 | Retire `n/8` + Save button in the config → auto-save (text on blur, per-field feedback); reuse the server spec's model | quick-win |
| 2 | Adopt the shared 3-state pill; map dev-server / sandbox / Doppler / container vocab onto it | quick-win |
| 3 | Merge Dev-server config + runtime into one card; link to config instead of echoing it read-only | medium |
| 4 | Fold Lifecycle + Sandbox + Concierge into one "Container" maintenance card; Purge under "More" | medium |
| 5 | Split Configure into a dedicated `project/[id]/settings` sub-screen; overview becomes Operate-first | medium |
| 6 | Promote Monitors to a first-class Automations area with an honest not-yet-live label | quick-win |
| 7 | Default-model field → model picker (reuse `useModels`) | quick-win |
| 8 | A11y + edge states parity with the server spec (labels, roles, live regions, 44 pt, skeletons, load-vs-empty) | medium |
| 9 | Add project-local Overview / Sessions / Automations navigation; move Danger zone into Project settings | medium |
| 10 | Replace one-card-per-datum metadata with compact grouped definition rows | quick-win |

## 9. Server follow-ups  (out of v1 scope)

- **Monitor scheduler.** The whole Automate surface needs a backend: monitor schema,
  persistence, a scheduler, run history, and the "critical finding starts a session" hook.
  This is a design track of its own — see `packages/server/src/agent-loop-scheduler.ts` as
  the nearest in-repo scheduler pattern to build from. Note ADR 0007 already constrains
  anything touching GitHub-backed task data.

## 10. Open questions

- **Container-maintenance grouping.** Confirm Lifecycle + Sandbox + Concierge truly merge
  cleanly — Concierge's token refresh is arguably a distinct concern from container
  (re)provisioning; it may stay a labelled row rather than share the Reprovision action.
- **Monitor preview availability.** Decide whether `Draft a monitor` is useful enough before
  the scheduler ships. The production-looking `Add Monitor` action is retired either way.
