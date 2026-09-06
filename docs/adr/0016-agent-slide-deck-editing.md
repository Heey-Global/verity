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

**Verity edits the live Google Slides deck in place via `presentations.batchUpdate`. Google is the
source of truth for deck content; nothing about the deck is mirrored into Git. Edits address
existing objects by id, and the deck's own design carries the visual quality rather than the
agent — inherited from its layouts where that relationship is intact, and copied from neighbouring
elements where a PowerPoint round-trip has flattened it. Only native Slides files qualify. Writes
that depend on character offsets are guarded by the deck's revision id.**

### D1 — Google is the source of truth; Verity makes incremental edits

The deck lives in Drive, and Verity is one editor among several. There is no deck source in the
repository and no rendered artifact to keep in sync.

This inverts the reflex of ADR 0009, which put imported Drive content into Git precisely so it
would be versioned and reviewable. That reasoning held for reference material with one writer.
It does not survive a document several people edit concurrently: a local copy that is
periodically flushed back is a lost-update machine, whatever we call it.

The audit trail is therefore Google's own revision history plus the session transcript, not a
git log. That is a real loss and is accepted knowingly.

### D2 — Offset-based writes are revision-guarded; a lost race is never forced

Google Slides supports concurrent editing, and this feature does not take that away. Two people
in the editor merge as they always have, and an agent edit merges alongside them the same way.
The guard below is not concurrency control and is not there to serialise anybody.

It exists for one failure that is the agent's alone. A person editing looks at the slide while
they type. The agent reads, plans, and writes seconds or minutes later, in terms of object ids and
**character offsets** — *delete characters 40–60 of this box*. If someone inserted a sentence into
that box in the gap, offsets 40–60 are no longer the text the agent read, and Google will carry
out the instruction faithfully. The result is not a conflict anyone notices; it is a
correct-looking edit in the wrong place.

Every edit therefore follows read → plan → write. Where the plan depends on offsets, the batch
also carries `writeControl.requiredRevisionId` set to the revision it was made against: if the deck
moved, Google rejects it, Verity **re-reads and re-plans**, and never retries such a batch
unguarded. An edit that cannot be re-planned safely surfaces to the operator instead of resolving
itself.

**The guard is applied per request kind, not to every write.** `requiredRevisionId` matches the
revision of the *whole presentation* — the spike saw a batch refused because an unrelated slide
had been added — so guarding everything would mean an agent on a deck with two or three live
editors is rejected constantly, for edits that were never in danger. That trades a rare silent
corruption for a constant visible obstruction, which is not a good trade when the vocabulary
already offers a way out:

- **Guarded — the plan depends on positions that can move.** `insertText` is guarded whenever it
  supplies an `insertionIndex`; `deleteText`, `updateTextStyle` and `updateParagraphStyle` are
  guarded whenever they use a `FIXED_RANGE`. `replaceAllText` is guarded too: even when
  `pageObjectIds` narrows its scope and the preceding read finds exactly the intended occurrences,
  a concurrent editor can add another match before the write. Concurrent text can therefore
  shift a range or change the target set of every operation in this group.
- **Guarded — the request overwrites state read during planning.** Moving an existing element with
  `updatePageElementTransform` is guarded so it cannot silently replace a collaborator's
  intervening move. A transform attached to a newly created element in the same batch needs no
  guard because no prior state exists. `createSlide` is guarded when its `insertionIndex` was
  chosen from the observed slide order; it is unguarded only when placement does not depend on
  that order, such as an explicit append-to-end intent. `updatePageProperties` is guarded when it
  replaces observed state such as the current background fill.
- **Unguarded — the request carries a stable target or adds new content.** `createShape`,
  and `createImage` add rather than reinterpret; `deleteObject` names an `objectId` that either
  still exists or fails loudly; and text or paragraph styling over `ALL` does not depend on
  character offsets.

`replaceAllText` is presentation-wide by default, and identical headings or labels are common, so
content alone is not an object address. The planner constrains it with `pageObjectIds`, verifies
the intended occurrences during the read, and still carries that read's revision guard. This
favours the least restrictive request that identifies exactly what the operator asked to change
without treating content matching as concurrency-safe.

### D3 — Read-plan-write against object ids; layouts, not coordinates

The agent addresses **existing** elements by `objectId` from the preceding `get`. New slides are
created with `createSlide` referencing a layout **already in the deck**, so position, fonts and
colours come from the deck's own master where that relationship survives. This is why the operator
does not have to touch the template.

Layouts are chosen from what the deck actually has, never from Google's predefined names: a
branded deck carries its own set (`DARK`, `BASE`, `DEFAULT` on the deck probed here), so
`TITLE_AND_BODY` is not a value Verity may assume exists. Both `layoutProperties.name` and
`displayName` are free-form on such a deck and neither is a stable key across decks — the agent
enumerates the layouts it finds and picks among those.

The supported edit vocabulary for Phase 1:

| Intent               | Requests                                                        |
| -------------------- | --------------------------------------------------------------- |
| Change text          | `insertText`, `deleteText`, `replaceAllText`                     |
| Format text          | `updateTextStyle`, `updateParagraphStyle`                        |
| New text box         | `duplicateObject` from a comparable shape, or `createShape` + `insertText` for a neutral box |
| Insert image         | `createImage`                                                    |
| Slide background     | `updatePageProperties` (`pageBackgroundFill.stretchedPictureFill`) |
| New slide            | `createSlide` with an existing layout                            |
| Remove / move        | `deleteObject`, `updatePageElementTransform`                     |

Every request kind in that table was exercised end to end in the spike. Layout-sensitive text and
formatting requests ran against a slide created from one of the deck's own layouts; image creation
and background fill ran against the initial blank scratch slide. The spike rendered at checkpoints
after those request groups — a batch can return `200` and still leave something broken — rather
than claiming that each individual request received its own render.

Text inserted into an inherited placeholder carries **no explicit style of its own**: the run
comes back from `presentations.get` with an empty `textStyle`, and font, size and colour resolve
from the layout at render time. Where that holds, Verity never has to name a font to match the
deck, and never gets the chance to pin one and drift the design.

**It does not hold on every real deck, and the design must not assume it.** Probing a 23-slide branded
deck found **no placeholders worth addressing — at most one per slide — and all 889 text runs
pinning their own `fontFamily`/`fontSize`.** Its layouts were named `DARK`, `BASE`, `DEFAULT`, not
Google's predefined set. That is consistent with a deck imported from PowerPoint, where conversion
can flatten master relationships into absolutely positioned shapes with inline styling. It is an
observed property of this deck, not a reliable classifier: native slides can also use free-floating
styled shapes, and imported slides can retain placeholders.

So the vocabulary splits by risk, and this is the part that governs implementation:

- **Editing existing text is the safe half.** `insertText` into an existing run, `deleteText` and
  `replaceAllText` inherit from the run they land in, whether that run's style is inherited or
  inline. These need no style reasoning at all and work identically on both kinds of deck.
- **Creating new elements is the unsafe half.** `createShape` and `createSlide` only inherit design
  where a live master relationship still exists. On a flattened deck a new text box arrives as
  unstyled black Arial on a dark-branded slide. For a design-matched free-floating box, Verity
  therefore uses `duplicateObject` on an explicitly selected comparable shape — one with the same
  semantic role on the same slide, or on a neighbouring slide using the same visual pattern — then
  replaces its content and moves the duplicate. Duplication preserves paragraph styling, autofit,
  fill, border and other shape properties that copying `textStyle` alone would lose. `createShape`
  remains available only when a neutral box is intended. The planner never treats the first styled
  run or a placeholder count as proof that two elements are comparable; if it cannot identify an
  unambiguous source, it does not create the element autonomously.

  The spike's real-deck write tested only text-style field transport, not semantic comparability or
  complete shape design: it sampled a styled run, applied `bold`, `italic`, `fontSize`,
  `foregroundColor` and `weightedFontFamily` to a disposable box, and verified that all five fields
  landed. This establishes the API mechanics but is not the Phase 1 design-matching algorithm.

One practical consequence of the same probe: those slides carry 30–77 page elements each. Reading
a whole presentation to plan one edit is the wrong shape — the agent reads **one page at a time**
through `presentations.pages.get` with a field mask, which is what the spike does.

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
refresh-token expiry. Phase 1 adds both `presentations` for existing decks and `drive.file` for
the temporary image files D5 creates. The latter is non-sensitive; adding `presentations` costs
nothing while the stricter `drive.readonly` grant already determines the verification burden.

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

**Google's fetch is anonymous, not authorised as the connected account.** The spike
(`scripts/slides-api-spike.ts`) tried four Drive URL shapes — `lh3.googleusercontent.com/d/<id>`,
`drive.google.com/uc?export=view`, `drive.google.com/uc`, and the file's own `webContentLink` —
against a freshly uploaded, private image. All four were refused (`Access to the provided image
was forbidden`, `The provided image should be publicly accessible`). After granting
`anyoneWithLink` on that same file, all four succeeded. A private Drive URL is not an option;
inserting an image requires a public one.

**Slides copies the bytes at insert time, so the public window is momentary.** The same spike then
read the inserted element's own `image.contentUrl` (a `lh7-rt.googleusercontent.com` URL owned by
the presentation), revoked the link-share, and deleted the Drive source outright — after which the
image still rendered in `getThumbnail` and its bytes were still served. `createImage` is a copy,
not a live reference.

The insert therefore runs as a bounded transaction: upload → grant `anyoneWithLink` → `createImage`
→ revoke the share → delete the uploaded file. The asset is world-readable-by-link for the seconds
between grant and revoke, to anyone who already holds the unguessable id. That is the real cost of
an image insert, and it is acceptable; a permanent public asset store would not have been. The
revoke and delete must be failure-tolerant on their own — a batch that succeeded and a share that
was not cleaned up is a leak, so cleanup retries independently of the edit's outcome.

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
The spike confirmed `files.export` accepts the PowerPoint MIME type and returns an actual zip
container, so this is the one-line change it looks like.

### D8 — The whole UI is one picker and one chip

Assignment reuses what exists. `attachMenuRows` (`apps/mobile/lib/attachMenu.ts`) already splits
the composer's "+" menu into transient per-turn attachments above a divider and durable
repo-touching actions below; **Google Slides** is a row in the lower group, next to Google Drive.
It opens the existing Drive browser (`app/google-drive/[sessionId].tsx`) filtered to native Slides
and PowerPoint MIME types — the list route already takes a query. Tapping an enabled native deck
**assigns** it rather than importing it; PowerPoint results explain why they cannot be assigned
(D9). Recently used decks sort first, because session-scoped assignment means picking the same
deck again next week.

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

- **Drift.** When the D2 guard fires — rarely, since it now covers only offset-based edits — an
  `Alert` is wrong: the Drive screen uses those for import failures, but this is the outcome of an
  agent turn and belongs in the transcript as a card — *the deck changed in Google* with
  re-read-and-retry alongside open-in-Slides.
- **A connection without write access.** Everyone connected under ADR 0009 holds a
  `drive.readonly` grant. The Drive screen's "Not connected" empty state needs a third variant —
  connected, cannot edit, reconnect — or the first edit fails as a 403 nobody can interpret.

### D9 — Only native Google Slides decks can be assigned; `.pptx` in Drive is refused up front

A `.pptx` file stored in Drive is **not** a Google Slides presentation, and the Slides API will
not touch it: `presentations.get` on one returns `400 — This operation is not supported for this
document. The document must not be an Office file.` No request in D3's vocabulary is reachable for
such a file. This is not a limit Verity can work around; the API has no editing surface for Office
files at all.

The distinction is invisible in the Drive UI — an Office deck opens in the Slides editor and looks
like any other deck — and it is exactly what the operator's current habit produces. Downloading a
deck, editing it in PowerPoint and uploading it back leaves a `.pptx` behind (Drive marks these
with `rtpof=true` in the share URL), so the decks most likely to be picked first are the ones this
feature cannot edit.

Two consequences follow, and the first one is the load-bearing one:

- **The picker queries both native Slides and PowerPoint MIME types, then enables only
  `application/vnd.google-apps.presentation`.** Office decks stay visible-but-unpickable, with the
  reason and the one-time fix — *File → Save as Google Slides* in Drive. Hiding them would be
  worse: the operator knows the deck is there, and a deck that silently does not appear reads as
  a broken picker. The check is a field Drive already returns, so the refusal costs nothing and
  happens before any edit is attempted.
- **Verity does not convert the file itself.** Conversion produces a *new* file with a new id and
  a new link, and the whole premise of this ADR (D1) is that the deck stays where the operator's
  colleagues already edit it. Silently forking that deck is the one failure mode worse than
  refusing the edit. The conversion is the operator's decision, made once, outside Verity.

## Scope

**In (Phase 1):** `presentations` and `drive.file` added to the connect flow; session deck
assignment (picker row, composer chip, server-side enforcement); the read-plan-write edit route
with D2's offset guard; the D3 edit vocabulary, its sibling-style fallback and named placements;
image upload via Drive with its revoke-and-delete cleanup; on-request slide previews; the drift
and no-write-access UI states; D9's two-format picker with native-only assignment; the D7 pptx
export target.

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
- **The assumptions were settled in a spike before this ADR was accepted**
  (`scripts/slides-api-spike.ts`), first against a deck it creates and deletes, then against two
  real ones. It falsified D5 as first written — a private Drive URL is refused, a link-share is
  mandatory — and then established the mitigation that keeps the cost bounded: Slides copies the
  bytes, so the share can be revoked and the source deleted immediately after the insert. D2's
  revision guard was confirmed to actually reject a stale `requiredRevisionId` rather than apply
  the batch anyway, which is the failure the guard exists for and the one that would otherwise be
  invisible — and, by refusing a batch over an edit to an unrelated slide, showed why that guard
  has to be narrowed rather than applied to everything. D3's full edit vocabulary ran green on a
  layout-backed slide. D6's `getThumbnail` and D7's `.pptx` export both worked.
- **D4 holds end to end on a real deck.** Under a token carrying only `drive.file` and
  `presentations`, two decks the app did not create were reached through the Slides API while
  Drive's own `files.get` returned 404 for the same ids. One was refused as an Office file (D9);
  against the other — 23 slides, branded, in active use — the full cycle ran with the operator's
  consent: read the head revision, create a styled element, verify it, watch the stale-revision
  guard refuse a second write, delete it again, confirm the deck was back to its previous shape.
  Authorization, reading, rendering, writing and the revision guard all behave on somebody else's
  deck exactly as they do on a scratch one.
- **The design assumption that broke was D3's, not D5's.** Style inheritance held on a deck
  authored natively and failed completely on a real one: it is absent on exactly the decks this
  feature targets, which is why the spike passing on a scratch deck proved less than it appeared to. The sibling-style fallback in D3 is therefore not an edge case to add later;
  it is the main path for any deck with PowerPoint in its history, and Phase 1 is not usable
  without it.
- **The first decks an operator reaches for may be the ones this cannot edit** (D9). The habit that
  motivated this ADR — download, edit in PowerPoint, upload — is precisely the habit that leaves
  `.pptx` files in Drive. Expect the native-only filter to be the feature's first visible edge, and
  budget the picker's explanation accordingly; it is doing more work than a filter usually does.
- **Image inserts have a cleanup obligation.** Every insert grants and then revokes a link-share
  on a temporary Drive file (D5). A crash between those two steps leaves a world-readable-by-link
  asset behind, so the cleanup cannot ride on the edit's success path.
