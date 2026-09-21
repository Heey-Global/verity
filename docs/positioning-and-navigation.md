# Verity positioning and navigation — "Say it. See it." spec

Status: proposed · Date: 2026-09-21 · Result of the positioning workshop held that day.
Targets: `apps/mobile/app/index.tsx` (home), `apps/mobile/app/_layout.tsx` (header),
`apps/mobile/app/session/[id].tsx` (attachments, explorer), a new `/capture` route, and the
server pieces named in [ADR 0022](./adr/0022-knowledge-folder-and-retrieval.md). The
tasks decision (§8) has no ADR yet; it is recorded here until something is built on it.

This spec defers to [`design-language.md`](./design-language.md) for the status pill, the
auto-save model and the container-lifecycle glossary, and to
[`project-screen-redesign.md`](./project-screen-redesign.md) for the project screen's
Configure / Operate split. It owns the **product positioning** and the **top-level
information architecture** that follows from it.

---

## 1. Positioning

Two self-descriptions existed side by side and did not agree. The README says "run a fleet
of coding agents on your own server — and steer it from your phone" (a **cockpit**: the
agent is the hero, the operator pilots). The June 2026 concept says "voice is the primary
input; close the capture → prioritise → dispatch → tracking → PR pipeline" (a **work
system**: the operator is the hero, agents are their hands).

The workshop resolved it as neither. Verity is a **delegation machine**:

> **Say what should happen. See what becomes of it.**
> Speak an instruction, confirm with one tap, done. Verity shows what you set in motion and
> where it stands. It administers nothing: no backlog, no folders, no wiki to click through.

The four decisions behind that sentence:

| Question | Decision | Consequence |
| --- | --- | --- |
| What is Verity's core? | **Delegation**, with an overview of what was delegated | The home screen is "Delegated", not "Projects" |
| How much does Verity decide alone? | **Confirm briefly, then go** (variant B) | One card after speaking: Verity's proposal, one tap or a spoken "ok" |
| How much knowledge UI is needed? | **Invisible, but correctable** | Search, a per-project overview, "that's wrong" per line — nothing else |
| Plan or fire? | **Fire** | An instruction *is* a session. No plan tab, no board, no priorities |

Verity stays a development tool. Projects without code (a client, a concept, the household)
are full projects in it — that is a property of the model, not a second product.

**Scope decision (2026-09-21): only the knowledge part is built now.** Sections 4–7 describe
the target picture the positioning implies; they are recorded so that later changes point
the same way, not scheduled. The app's UI and UX stay as they are, with one exception:
knowledge — the Knowledge screen and its book icon go, the Wiki goes, and a knowledge folder
appears in the session explorer instead ([ADR 0022](./adr/0022-knowledge-folder-and-retrieval.md)). Retrieval (RAG) is a later stage on the same folder.

What does **not** change: every control point the operator has today stays. The
confirmation card before dispatch, permission prompts and agent questions during a session,
and pull-request review and merge at the end are all the operator's. "Fire" only means an
instruction starts a session immediately instead of waiting in a list; what the session
does afterwards passes the same gates as now.

## 2. Principles

Inherits the five from the settings spec (one honest status model; auto-save; right altitude;
honest status; destructive stays explicit) and adds:

6. **One gesture in, one glance out.** Speaking is the only way to start something; the
   home list is the only place to see everything. Nothing requires a second screen.
7. **Verity proposes, the operator confirms.** Never a form, never a picker first. The
   proposal is on the card; changing it is the exception path.
8. **Verity asks only when it must.** "Needs you" holds Verity's questions to the operator —
   permission prompts, agent questions, an instruction whose project it could not tell —
   never the operator's sorting work.
9. **Knowledge is a capability, not a place.** Material goes in, agents find it, the
   operator sees a per-project overview and can delete or correct. No folders to curate.
10. **Same components, two breakpoints.** iPad is not a second app; iPhone screens become
    the columns of a split layout.

## 3. Three verbs

```
SAY     🎤 mic (app · widget · Action Button · Watch)  →  confirmation card  →  go
SEE     Home "Delegated": Needs you · per project: running · waiting · landed
FIND    Search: sessions, knowledge material, overview lines — one field
```

Everything else — project settings, the explorer, the knowledge folder — sits one tap
behind a project row and is visited rarely.

### Wording glossary  (extends `design-language.md` § Wording glossary)

| Term | Meaning | Do not confuse with |
| --- | --- | --- |
| **Delegated** | The home screen: every session across projects, grouped by project, plus "Needs you". Today's session list, extended. | A projects list (there is none as a screen) |
| **Needs you** | The section on top of Home holding Verity's open questions to the operator: permission prompts, agent questions, unresolved captures, learning-loop proposals (ADR 0019). | An inbox the operator sorts; a notification centre |
| **Instruction** | What the operator says. Becomes a session (§8), a knowledge note (ADR 0022), or a "Needs you" item. | A task — there is no task object in Verity |
| **Confirmation card** | The card shown after speaking: transcript, Verity's proposal (project + kind), *Go*. | A form; the old triage sheet |
| **Landed** | A session's terminal state on Home: PR open / merged, note saved, session done. | "Done" as a task status |
| **Waiting** | A session that cannot start yet (sandbox waking, concurrency cap). Technical, transient, never operator-ordered. | A backlog |
| **Knowledge** | A project's `knowledge/` folder (ADR 0022): material, transcripts, notes, `overview.md`. Visible in the explorer, searchable by agents. | The former Knowledge screen, Sources / Wiki, General, grants |
| **Overview** | `knowledge/overview.md` — ~20 lines Verity keeps about the project, injected into every session, correctable by voice. | Wiki pages; project memory as a settings field |
| **Keep** | The action on a chat attachment that copies it into the project's knowledge folder. Off by default. | Uploading to the folder directly (not an entry point) |

## 4. iPhone

### 4.1 Home = Delegated

```
Delegated                                              🔍
NEEDS YOU ③ ───────────────────────────────────────────
│ 🤖 npm install ausführen?    Website · permission   [No] [Yes]
│ 🤖 Welche Locale-Fallbacks?  Verity · question      [Reply]
│ 🎤 „Angebot an Müller…"      project unclear        [Kunde X] [Haushalt]
Verity ›                       Sandbox active · 2 running · 1 landed
│ ● Watch complication: App Intent   running · 12 min · #612     [RUNNING]
│ ● Inbox navigation spec            running                     [RUNNING]
│ ● iPad split view fix              landed · PR #598 awaits review  [PR]
Kunde X ›                      no code · 1 waiting
│ ● Jahresbericht zusammenfassen     waiting · sandbox waking     [WAITING]
Haushalt ›                     sleeping
                                                        (🎤 Say)
```

- Structurally today's list (`index.tsx`): project groups, sessions beneath, collapse per
  group. Three changes:
  - **Needs you** on top, accent-framed, with inline actions: *Yes / No* for permission
    prompts (the same resolve path ADR 0008's push quick reply uses), *Reply* for agent
    questions, project chips for an unresolved capture, *Accept / Decline* for proposals.
    The count badge is the sum of open items.
  - **Landed** is a state in the same list. A pull request awaiting review is shown here;
    merge stays a manual action in the session.
  - **The project row is the entry to the project** (tap → project screen). Collapse stays
    on the chevron. Project rows without sessions still appear (sleeping projects).
- Header: title, **Search**. The Knowledge book and the Tasks icon (`_layout.tsx:383-432`)
  go. The home-screen issues footer (`IssuesSection`) goes: issues are created at dispatch
  (§8), not browsed.
- **Mic FAB** ("Say") on Home and on every project screen and session.
- No bottom bar. The three-tab bar ADR 0007 planned (Now / Plan / Projects) is retired with
  the Plan tab; with one home screen there is nothing to tab between.

### 4.2 Confirmation card (variant B)

```
🎤 Heard                                                   0:07
„Prüf mal, ob der App Intent vom Action Button auch ohne Widget geht,
 und mach ein Issue draus."
VERITY PROPOSES
┌ 🤖 Start agent                                             › ┐
│    [Verity] · creates issue · branch feat/…                  │
Or:  [📖 As knowledge]  [🔍 Project]  [📥 Remember]
[                        Go                        ]
              or say "ok" · swipe to cancel
```

- The **dispatch brain** is the existing refiner (`packages/server/src/task-refine.ts`)
  with a widened contract: from the transcript it returns `{ project, kind, confidence,
  blueprint }` where `kind ∈ agent | knowledge | unclear`. Project recognition uses project
  names, recent activity and the project overviews (ADR 0022) as context.
- **Go** (tap or spoken "ok") executes the proposal. *As knowledge* saves the transcript as
  a note in the project's knowledge folder instead of starting an agent. *Project* changes
  the target. *Remember* saves the transcript as a note without any further action.
- `confidence` below a threshold, or `kind = unclear`, skips the card: the capture lands
  in **Needs you** with project chips. The operator resolves it there with one tap.
- The card never shows more than one proposal and three alternatives. If Verity is wrong
  twice in a row on the same project, that is a bug in the dispatch brain, not a reason to
  add a picker.
- Everything spoken is stored first (local-first queue, see §6) and only then classified.
  A dropped connection never loses an instruction.

### 4.3 Project screen

Tapping a project row opens the project: an Operate-first overview per
[`project-screen-redesign.md`](./project-screen-redesign.md), then its sessions, then two
rows:

- **Knowledge** → the `knowledge/` folder in the explorer (ADR 0022): `overview.md` on top,
  then `meetings/`, `imports/`, `notes/`. Delete, open, download. Nothing else.
- **Settings** → the Configure sub-screen.

The overview is readable here and correctable by voice from anywhere ("Müller ist nicht
mehr Ansprechpartner" → line replaced, capture kept as evidence in `notes/`).

### 4.4 Session screen

Unchanged in structure. Two additions:

- **Attachment card gains a Keep toggle**, off by default:

  ```
  📄 Angebot_Mueller_v3.pdf  1.2 MB     [Only this chat ✓]  [📚 Keep]
  ```

  *Keep* copies the file into `knowledge/imports/` of the session's project. Without it,
  the attachment lives in the worktree as today and ends with the session.
- **Meeting recordings are kept automatically** in `knowledge/meetings/` (audio +
  transcript); the session receives the path. They no longer land in the repository under
  `docs/meetings/`.

### 4.5 Search

One field over sessions (existing message search), knowledge material (ADR 0022 retrieval)
and overview lines. Results are grouped by kind; a knowledge hit shows its locator
(`meetings/2026-09-21-kickoff.md · 14:32`) and opens the file at that position.

## 5. iPad

Above the split breakpoint (`knowledge.tsx:46`, `width >= 900`) the app renders three
columns rooted in `_layout.tsx`:

```
┌ Sidebar ────────┬ Content ───────────────┬ Detail ────────────────────────┐
│ Verity      🔍  │ Delegated              │ (session · file · confirmation)│
│ ▣ Needs you  ③  │ NEEDS YOU …            │                                │
│ PROJECTS        │ Verity › …             │                                │
│ ● Verity        │ Kunde X › …            │                                │
│ ● Kunde X       │ Haushalt ›             │                                │
│ ● Haushalt      │                        │                                │
│ + New project   │                        │                                │
│ [🎤 Say]        │                        │                                │
└─────────────────┴────────────────────────┴────────────────────────────────┘
```

- The sidebar is the model: Needs you, projects, capture button. Selecting a project
  filters the content column to that project; selecting *Needs you* shows only that section.
- The detail column shows what the iPhone pushes: a session, a knowledge file, or the
  confirmation card as a persistent pane after speaking (transcript on top, proposal below,
  ⌘↩ to go).
- Below the breakpoint the same routes render as the iPhone stack. No iPad-only components.

## 6. Capture entry points

| Entry | Mechanism | Stage |
| --- | --- | --- |
| In-app mic | `/capture` route; dictation starts on open via `useVoiceInput` (`apps/mobile/hooks/useVoiceInput.ts`, pure logic in `packages/mobile/src/dictation.ts`) | 1 |
| Lock-screen / Home widget, Control Center control, Action Button, Back Tap, Siri | **One App Intent** (`SayToVerity`) that deep-links into `/capture`. Widgets and complications cannot record; the intent opens the app already listening | 1 |
| Apple Watch (Shortcuts complication) | Same intent, forwarded by Shortcuts; the phone records | 1 |
| Share sheet (files, links, text) | iOS share extension → `Keep` into a chosen project's knowledge folder, or a text capture through the confirmation card | 2 |
| Notification quick reply | ADR 0008's `AGENT_QUESTION` text input already gives Watch dictation for replies; a `SAY` category lands an instruction without opening the app | 2 |
| Native watchOS app + complication | Own Swift target recording on the wrist, uploading through the audio stream route (`packages/server/src/meeting-transcript-routes.ts:114`). Needs a config plugin for an extension target and App Group / Keychain sharing for the token (`apps/mobile/lib/authToken.ts:103`) | 3, only if stage 1 proves daily use |

**Local-first is a requirement.** A capture is written to device storage before any
network call and synced by a queue; an unsynced capture shows as `transient` in Needs you.
A self-hosted server behind Uplink may be unreachable exactly when a thought arrives.

## 7. Captures: the minimal store

New table `captures`: `id` (client UUID), `transcript`, `audio_ref` (nullable),
`source` (`app` · `intent` · `watch` · `share` · `notification`), `status`
(`pending` · `dispatched` · `needs_you` · `dismissed`), `proposal` (JSON: project, kind,
confidence, blueprint), `outcome` (JSON: session id / note path), `created_at`,
`resolved_at`.

Routes: `POST /captures` (idempotent on `id`; returns the proposal), `POST
/captures/:id/audio` (streamed, reusing the transcript plumbing), `POST /captures/:id/go`
(execute the proposal or an override), `DELETE /captures/:id`. `GET /needs-you` aggregates
open captures with open permission prompts, agent questions and proposals into the Home
section.

A capture is never agent-visible by itself. It becomes a session prompt, a knowledge note,
or nothing.

## 8. What this retires

**Tasks (decision recorded, nothing built or removed yet).** There is no task object in
Verity. An instruction becomes a session at once ("fire"); what cannot start yet is
*waiting* for a technical reason, never for an operator's ordering. For a repository
project, dispatch creates a GitHub issue over REST as the landing record (branch
`feat/<n>-…`, `Closes #N`); a local project's session is its own record. The Plan tab, the
Projects v2 board and its GraphQL client (`github-tasks.ts`), drafts, priorities and the
`TASKS_ENABLED` flag are retired by this decision; ADR 0007's lifecycle and refiner survive
as the dispatch brain. The code stays in place until the capture work (stage 1) replaces
it, and gets its own ADR then.

| Retired | Replaced by | Decision |
| --- | --- | --- |
| Plan tab, GitHub Projects v2 board, drafts, priorities, `TASKS_ENABLED` | Instruction → session; issue created at dispatch | this spec §8, ADR later |
| Bottom bar (Now / Plan / Projects) | One home screen | this spec §4.1 |
| Knowledge screen, folder tree, General, grants, Wiki jobs, Sources/Wiki labels | `knowledge/` folder per project + retrieval index | ADR 0022 |
| Project memory as a settings field (`verity-memory` text) | `knowledge/overview.md` | ADR 0022 |
| Home-screen issues footer | Issues are landing records, browsed on GitHub | this spec §8 |
| `docs/meetings/*.md` in the repository | `knowledge/meetings/` | ADR 0022 |
| A triage Inbox screen (earlier draft of this spec) | Confirmation card + Needs you | this spec §4.2 |

## 9. Rollout order

**Now:** ADR 0022's build order — knowledge folder, explorer roots, re-pointed entry points,
ingest and retrieval, removal of the Knowledge screen, book icon, grants screen and Wiki.
No other screen changes.

**Later, in this order, each gated on the previous one proving useful:**

| # | Change | Effort |
| --- | --- | --- |
| 1 | `captures` store + routes; `/capture` route with instant dictation; mic FAB; confirmation card wired to the widened refiner; `Go` starts a session | medium |
| 2 | `SayToVerity` App Intent + Lock-screen widget + Control Center control; Watch via Shortcuts for free | medium |
| 3 | Needs you section on Home (permission prompts + agent questions first, captures second); remove Tasks icon | medium |
| 4 | Landed state and project-row entry on Home; remove issues footer; retire the board code; tasks ADR | medium |
| 5 | iPad three-column root | medium |
| 6 | Share extension; `SAY` notification category | small each |

## 10. Open questions

- **Confidence threshold for skipping the card.** Start conservative (card always shown);
  measure how often the operator changes the proposal; only then consider skipping for
  high-confidence repeats of the same project.
- **Concurrency cap.** How many sessions may start at once per project before an
  instruction is *waiting*? Today: no cap. A cap protects the sandbox; the number is a
  setting, not a design decision.
- **Spoken "ok".** On-device recognition of a confirmation word after the card appears is
  cheap with `expo-speech-recognition`; whether it is reliable enough in noisy places is an
  experiment for stage 1.
- **Learning-loop proposals** (ADR 0019) belong in Needs you; ADR 0019 itself is still
  proposed and its proposal shape may change.
