# ADR 0016 — Agent Editing of Google Slides Decks In Place

**Status:** Proposed · **Date:** 2026-09-06
**Supersedes in part:** ADR 0009 (its text-first export sends Slides to PDF — D7 sends them to
`.pptx`; its "Drive is reference material, not the work product" does not hold for a deck a
session has been assigned — D1)

## Context

ADR 0009 made Drive a **read-only source**: connect one account with `drive.readonly`, browse,
import into `docs/reference/`, commit. Native Slides files are exported to PDF
(`packages/server/src/google-drive.ts:456`).

The operator wants to edit presentations from the chat. The requirements that shape this
decision, in the operator's own framing:

- **The deck stays in Google Drive as a native Slides file, because other people also edit it.**
  This is the constraint everything else follows from.
- The wanted edits are ordinary content work: change text boxes, insert images, put a background
  image on a slide, add slides. **Explicitly not** master or template surgery.
- The decks should look good — but the design already exists in the deck.

Two architectures were considered before this one and both fail on the first requirement:

- **Download `.pptx`, edit the file, re-upload** — the operator's current manual workflow. It
  replaces the file wholesale, so any edit a colleague made in the meantime is destroyed, and a
  native Slides file is converted twice per cycle (Slides → pptx → Slides), which is not
  lossless.
- **Author deck source in Git, render, publish** — the first draft of this ADR. It presumes a
  single writer. With several people editing in Google, Git cannot be the source of truth, and
  "re-render and overwrite" is precisely the destructive behaviour to avoid.

What already exists: the PKCE connect flow with a `SecretCipher`-encrypted refresh token; a
scope-agnostic token cache (`createCachedGoogleAccessToken`, `google-drive.ts:553`); a GET-only
Drive client pinned to `https://www.googleapis.com/drive/v3` (`google-drive.ts:20,184`); and the
error-slug discipline of `extractDriveErrorSlug`, which lifts only a short sanitised reason out
of Google error bodies.

## Decision

**Verity edits the live Google Slides deck in place via `presentations.batchUpdate`, guarded by
the deck's revision id. Google is the source of truth for deck content; nothing about the deck
is mirrored into Git. Edits address existing objects by id, and new slides inherit the deck's
own layouts, so the deck's design carries the visual quality rather than the agent.**

### D1 — Google is the source of truth; Verity makes incremental edits

The deck lives in Drive, and Verity is one editor among several. There is no deck source in the
repository and no rendered artifact to keep in sync.

This inverts the reflex of ADR 0009, which put imported Drive content into Git precisely so it
would be versioned and reviewable. That reasoning held for reference material with one writer.
It does not survive a document several people edit concurrently: a local copy that is
periodically flushed back is a lost-update machine, whatever we call it.

The audit trail is therefore Google's own revision history plus the session transcript, not a
git log. That is a real loss and is accepted knowingly.

### D2 — Every write is revision-guarded, and a lost race is never forced

Each edit follows read → plan → write:

1. `presentations.get` returns the current structure **and** its `revisionId`.
2. The agent plans a `batchUpdate` against the object ids it just read.
3. The batch carries `writeControl.requiredRevisionId` set to that revision.

If someone edited the deck in between, Google rejects the batch. Verity then **re-reads and
re-plans**; it does not retry without the guard and never force-writes. An edit that cannot be
re-planned safely surfaces to the operator instead of resolving itself.

Without the guard, the agent's plan refers to object ids and text offsets that may no longer
mean what they meant when it read them — the failure mode is not a merge conflict but a
correct-looking edit applied to the wrong place.

### D3 — Read-plan-write against object ids; layouts, not coordinates

The agent addresses **existing** elements by `objectId` from the preceding `get`. New slides are
created with `createSlide` referencing a layout **already in the deck**, so position, fonts and
colours come from the deck's own master. This is why the operator does not have to touch the
template, and it is what makes the output look consistent.

The supported edit vocabulary for Phase 1:

| Intent               | Requests                                                        |
| -------------------- | --------------------------------------------------------------- |
| Change text          | `insertText`, `deleteText`, `replaceAllText`                     |
| Format text          | `updateTextStyle`, `updateParagraphStyle`                        |
| New text box         | `createShape` (`TEXT_BOX`) + `insertText`                        |
| Insert image         | `createImage`                                                    |
| Slide background     | `updatePageProperties` (`pageBackgroundFill.stretchedPictureFill`) |
| New slide            | `createSlide` with an existing layout                            |
| Remove / move        | `deleteObject`, `updatePageElementTransform`                     |

Free-floating elements need an explicit transform. Those come from a small set of named
placements derived from the slide dimensions (full bleed, left/right half, lower third, centred
block) — never from coordinates the agent invents per call. Ugly decks come from arbitrary EMU
values, and this is the boundary that prevents them.

### D4 — Scope `presentations`, narrowed to the session's assigned deck

In-place editing of a deck **Verity did not create** cannot be done under `drive.file`, which
covers only files the app created or the user explicitly handed it. Editing an existing shared
deck therefore requires `https://www.googleapis.com/auth/presentations` — a *sensitive* scope,
granting read and write on **every** presentation in the account.

That is a wide grant, so Verity narrows it itself: **a session may touch exactly the one deck
assigned to it, and nothing else.** The server refuses any Slides call against a different
presentation id. There is no standing registry to curate and go stale — assignment is a
deliberate operator gesture per session (D8), and a session with nothing assigned cannot reach a
presentation at all, even though the token would allow it.

The token stays broad: this constrains Verity's behaviour, not Google's authorization, and does
nothing about a stolen token. What it removes is the realistic failure — an agent editing a
presentation nobody pointed it at.

**One deck at a time.** With two assigned, "shorten the heading on slide 3" is ambiguous, and
ambiguity in a tool that writes to shared documents is not a papercut.

Consent burden is unchanged in practice: `drive.readonly` from ADR 0009 is already *restricted*,
a stricter tier than *sensitive*, and the app already runs in Testing mode with its seven-day
refresh-token expiry. Adding `presentations` costs nothing there.

**Path for a public rollout:** `drive.file` also covers files the user explicitly grants through
the Google Picker. One Picker gesture per deck would keep the scope non-sensitive and make the
grant per-file instead of account-wide — strictly better posture, at the cost of Picker UI in the
mobile app. ADR 0009 rejected the Picker as a *browsing* UI; as a one-time per-deck grant it is a
different thing and should be revisited before the app is verified.

### D5 — Images are uploaded to Drive first, then referenced by URL

`createImage` and `stretchedPictureFill` take a **URL** and Google fetches it; they do not accept
uploaded bytes. The Verity server is never publicly reachable (ADR 0009), so it cannot serve the
image itself.

Images are therefore uploaded to Drive first — that upload is a Verity-created file, so it falls
under `drive.file` — and the resulting Drive URL is referenced from the request. Google's limits
apply: PNG/JPEG/GIF, at most 50 MB and 25 megapixels, and the URL must be reachable at request
time.

**This is the least certain part of the design.** Whether Google's fetch resolves a Drive-hosted
URL under the connected account's permissions needs to be proven before anything is built on it.
If it does not, the fallbacks are a temporary link-share on the uploaded image or an
operator-provided public bucket — both worse, and both changing what "insert an image" costs.

### D6 — Previews on request only

Verity renders no previews on its own. A slide PNG (`presentations.pages.getThumbnail`) is
fetched only when the operator asks for one, and returned into the chat where it renders inline.

The deck is open in Google Slides anyway, on a second screen or a phone, and that view is
authoritative, live, and free. Rendering a picture after every edit would spend an API call and
a line of transcript to tell the operator something they can already see — and for a text change
it shows nothing the one-line summary does not already say.

The consequence is that the session UI must make the deck easy to reach: the active deck is named
in the composer and one tap away from opening in Slides. That handoff, not a thumbnail stream,
is the visual feedback loop.

### D7 — Import exports Slides to `.pptx`, not PDF

Secondary, but it removes a papercut the operator hits today: a native Slides deck imported under
ADR 0009 arrives as PDF, which nothing can edit. Changing the `presentation` entry in
`NATIVE_EXPORT` (`google-drive.ts:456`) to the PowerPoint MIME type yields an artifact that is
actually workable offline, and keeps the operator's existing habit available alongside the API
path. Files already stored as `.pptx` in Drive download correctly today via `extensionFromName`.

### D8 — The whole UI is one picker and one chip

Assignment reuses what exists. `attachMenuRows` (`apps/mobile/lib/attachMenu.ts`) already splits
the composer's "+" menu into transient per-turn attachments above a divider and durable
repo-touching actions below; **Google Slides** is a row in the lower group, next to Google Drive.
It opens the existing Drive browser (`app/google-drive/[sessionId].tsx`) filtered to
`application/vnd.google-apps.presentation` — the list route already takes a query. Tapping a deck
**assigns** it rather than importing it, and recently used decks sort first, because
session-scoped assignment means picking the same deck again next week.

The assigned deck then shows as a single chip above the composer — `Q3 Review ↗ ×`:

- the **name** states which file the agent will write to, before it writes to it;
- tapping the **name** opens the deck in Google Slides — this is the visual feedback loop that
  D6 deliberately does not build out of thumbnails;
- tapping the **×** ends the assignment.

One control, three jobs. An earlier draft of this decision spread them across a picker, a
composer chip and a managed deck list on the project screen; the list existed only because
selection, link and management had been separated in the first place.

Removing the assignment is not an undo. The edits are in Google and stay there — the × ends
access, not the work — and the confirmation has to say so, or "end editing" reads as "discard".

Two states need a home in this UI, and both are easy to leave out:

- **Drift.** When the D2 guard fires, an `Alert` is wrong: the Drive screen uses those for import
  failures, but this is the outcome of an agent turn and belongs in the transcript as a card —
  *the deck changed in Google* with re-read-and-retry alongside open-in-Slides.
- **A connection without write access.** Everyone connected under ADR 0009 holds a
  `drive.readonly` grant. The Drive screen's "Not connected" empty state needs a third variant —
  connected, cannot edit, reconnect — or the first edit fails as a 403 nobody can interpret.

## Scope

**In (Phase 1):** `presentations` added to the connect flow; session deck assignment (picker row,
composer chip, server-side enforcement); the read-plan-write edit route with the D2 revision
guard; the D3 edit vocabulary and named placements; image upload via Drive; on-request slide
previews; the drift and no-write-access UI states; the D7 pptx export target.

**Out (later):** editing masters, layouts or themes; animations and transitions; comments and
suggestions; generating a deck from nothing (no design to inherit — needs a Verity theme, which
is a separate decision); multiple Google accounts; the Picker-based `drive.file` path.

## Alternatives considered

**Automating the download-edit-upload loop.** The operator's current manual workflow, driven by
Verity. Rejected as the main path: replacing the file discards concurrent edits, and the double
conversion is lossy. Retained in weaker form as D7, for offline work and PowerPoint delivery.

**Deck source in Git, rendered and published.** The previous draft of this ADR. Rejected once the
multi-editor requirement was stated: it can only be correct if Verity is the sole writer.

**`drive.file` alone.** Cheapest scope, but structurally unable to reach a deck someone else
created — which is the case that matters here.

## Consequences

- **The stored refresh token becomes read/write over every presentation in the account.** This is
  the largest posture change since the Google integration landed: under ADR 0009 a leaked token
  could only read. D4's assignment rule does not reduce what the token can do if it is stolen,
  and the connect UI must state plainly what is being granted.
- The Drive client gains a POST path and a second API base (`slides.googleapis.com/v1`). The
  error-slug discipline extends to it unchanged — Slides returns the same shaped error bodies.
- Deck edits leave no trace in Git. Reviewability comes from Google's revision history and the
  session transcript. ADR 0009's "Drive is reference material, not the work product" no longer
  holds for an assigned deck: that deck **is** a work product, and it lives outside Git.
- New store state, and less of it than a registry would need: the deck assigned to a session, the
  last revision id Verity observed for it, and a recently-used list for the picker.
- Session-scoped assignment means a deck used across weeks is re-picked each session. That is the
  accepted cost of having no registry to curate; the recently-used ordering keeps it to one tap.
- **One load-bearing unverified assumption, to be settled first in a spike:** that Google's image
  fetch resolves a Drive-hosted URL under the connected account (D5). If it does not, inserting
  an image forces either a link-share side effect on every uploaded asset or an operator-provided
  public bucket, and "insert an image" stops being a cheap operation. `getThumbnail` (D6) is
  tested alongside it, but since previews are on request only, its failure costs a convenience
  rather than a feature.
