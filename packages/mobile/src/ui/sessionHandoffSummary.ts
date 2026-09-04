import { isDeceptiveInARenderedLine, LIST_SESSIONS_FIELD_SENTENCE } from '@verity/events';

import { spellOutBidiControls } from './bidi.js';

/**
 * What a `verity_session_handoff` approval card shows.
 *
 * The whole safety argument for that tool is that the operator reads the briefing before it
 * becomes a turn in another session: the control-plane agent composes it from container logs
 * and other projects' output, so the text is agent-written and may quote anything it read.
 * The generic card path summarises an input to one squashed 80-character line, which for a
 * 20,000-character briefing means approving a document after seeing its first sentence. So
 * the briefing gets its own renderer, shown in full.
 *
 * Null when the input does not parse. The caller then falls back to the raw JSON rather than
 * a confident summary of a shape it did not understand — the same rule the brokered HTTP and
 * trusted CLI summaries follow.
 */
export type SessionHandoffSummary = {
  /** `session <id>` or `project <reference>`, as written by the caller. */
  target: string;
  /**
   * Which of the two the caller named.
   *
   * A project target is resolved to a concrete session after this approval, and only if
   * exactly one of that project's sessions is eligible. So `'project'` is the case where the
   * card cannot name the destination, and the one the card has to say that about.
   */
  targetKind: 'session' | 'project' | 'new-session';
  title: string;
  /**
   * Unclamped — rendering it in full is this module's reason to exist — and verbatim except
   * that invisible bidi controls are spelled out. See {@link spellOutBidiControls}. What the
   * target session receives is the unmodified text; this is only how it is shown.
   */
  briefing: string;
  /**
   * How big the briefing is, measured on what the target session receives rather than on
   * what {@link briefing} shows. `spellOutBidiControls` turns each control into eight visible
   * characters, so counting the rendered string would report a size no one sent — and this
   * number exists to set a reading expectation, which is about the text, not its annotation.
   */
  briefingSize: { characters: number; lines: number };
};

/**
 * A single-line string safe to drop into the card's headline.
 *
 * The title and the target are rendered as prose next to fixed words, so a control character
 * or a bidi formatter in them would misdescribe where the briefing is going. Those are the
 * only characters rejected: a title is written by an agent for a person to read, and
 * "Überlagerung", an em dash or a ZWNJ must render rather than drop the card back to raw JSON.
 *
 * This re-runs `cardLine`'s check rather than trusting that it ran. The schema runs on the
 * server; this runs on what arrived, and the point of a permission card is that it describes
 * the request accurately even when something upstream is wrong. The predicate is imported from
 * `@verity/events` because re-running it IS the independent check — a local copy of the
 * character class would only add a way for card and schema to disagree about which
 * characters are deceptive, and that disagreement is silent in both directions: too strict
 * drops a legitimate request to raw JSON, too loose renders a line the schema would never have
 * admitted.
 *
 * The trim and the ceiling are this module's own. One function serves all three headline
 * fields, so its ceiling is the loosest of the schema's three (title 120, session id 128,
 * project reference 200): anything the schema admits renders, and length is the server's to
 * enforce — refusing a 150-character title here would hide a request rather than describe it.
 *
 * The briefing itself is deliberately NOT filtered this way: it is displayed as a body of text
 * rather than woven into a sentence, and silently refusing to show one would defeat the point
 * of showing it at all.
 */
const MAX_HEADLINE_LEN = 200;

function headlineText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADLINE_LEN) return null;
  return isDeceptiveInARenderedLine(trimmed) ? null : trimmed;
}

/**
 * True when the object carries nothing this module would fail to describe.
 *
 * Every request schema here is `.strict()`, so a key the card cannot see is one the server
 * would refuse anyway — but the card's job is to describe what arrived, not what should have,
 * and a confident summary that silently omits a field is the failure mode the card exists to
 * prevent. An unknown key drops the request to raw JSON, where the operator sees all of it.
 */
function onlyKnownKeys(value: Record<string, unknown>, known: readonly string[]): boolean {
  return Object.keys(value).every((key) => known.includes(key));
}

/**
 * `session <id>` or `project <reference>` — exactly one, never a choice between them.
 *
 * The schema's target is a union of two `.strict()` objects, so a request naming both is
 * refused outright. Falling through from one key to the other would let this card headline a
 * target the request does not name: `{ sessionId: 'a<U+202E>b', project: 'acme/website' }`
 * would render "project acme/website" because the session id failed the headline filter. The
 * card exists so it cannot misname where the briefing is going, so an ambiguous target drops
 * to raw JSON like any other input this module cannot read.
 */
function targetLabel(raw: unknown): Pick<SessionHandoffSummary, 'target' | 'targetKind'> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const target = raw as Record<string, unknown>;
  if (!onlyKnownKeys(target, ['sessionId', 'project', 'newSession'])) return null;
  // Presence, not definedness: `{ sessionId: undefined, project: 'x' }` is a request naming
  // two keys, and Zod's `.strict()` refuses it as one. Reading it as a project target would
  // describe a request the server will not accept.
  const named = ['sessionId', 'project', 'newSession'].filter((key) => key in target);
  if (named.length !== 1) return null;
  if (named[0] === 'sessionId') {
    const sessionId = headlineText(target['sessionId']);
    return sessionId === null ? null : { target: `session ${sessionId}`, targetKind: 'session' };
  }
  if (named[0] === 'newSession') {
    const value = target['newSession'];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const nested = value as Record<string, unknown>;
    if (!onlyKnownKeys(nested, ['project']) || !('project' in nested)) return null;
    const project = headlineText(nested['project']);
    return project === null
      ? null
      : { target: `a new session in project ${project}`, targetKind: 'new-session' };
  }
  const project = headlineText(target['project']);
  return project === null ? null : { target: `project ${project}`, targetKind: 'project' };
}

export function sessionHandoffSummary(input: unknown): SessionHandoffSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const request = input as Record<string, unknown>;
  if (!onlyKnownKeys(request, ['target', 'title', 'briefing'])) return null;
  const target = targetLabel(request['target']);
  const title = headlineText(request['title']);
  const raw = request['briefing'];
  if (target === null || title === null) return null;
  if (typeof raw !== 'string') return null;
  // Trimmed as the schema trims it. `z.string().trim()` is a transform, not just a check, so
  // the string the target session receives is the trimmed one — showing and measuring the
  // untrimmed value would render whitespace nobody is sent and let a briefing padded with
  // trailing newlines report a size the target never sees. A whitespace-only briefing is
  // empty by the same rule and falls back to raw JSON rather than a card with a blank body.
  const briefing = raw.trim();
  if (briefing.length === 0) return null;
  // Annotated, not filtered — the opposite of the headline's treatment, because a briefing is
  // a body of text and refusing to show 20,000 characters over one suspicious character would
  // defeat the point of showing it. What the target session receives is the unmodified string.
  return {
    ...target,
    title,
    briefing: spellOutBidiControls(briefing),
    // Code points rather than UTF-16 units: this is a number a person is asked to judge a
    // reading length by, and an emoji is one character to them.
    briefingSize: { characters: [...briefing].length, lines: briefing.split('\n').length },
  };
}

/** The card headline: where this is going, which is the part that cannot be undone. */
export function sessionHandoffTitle(summary: SessionHandoffSummary): string {
  return `Send briefing to ${summary.target}?`;
}

/**
 * How much briefing there is, stated before it is read.
 *
 * The briefing is shown in a fixed-height scroll box with no scrollbar of its own, so a
 * 20,000-character document and a two-line note look identical until the operator scrolls —
 * and the safety argument for this tool is that they read the text before it becomes a turn
 * elsewhere. A card that shows the first screen of a long briefing without saying it is the
 * first screen invites exactly the approval it exists to prevent.
 *
 * Reads {@link SessionHandoffSummary.briefingSize}, which is measured before the bidi controls
 * are spelled out — the size of what the target session receives, not of what the box shows.
 * Grouped with commas because the whole card is English, the project default for
 * operator-facing copy.
 */
export function briefingExtent(summary: SessionHandoffSummary): string {
  const { characters, lines } = summary.briefingSize;
  const group = (value: number) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `Briefing: ${group(characters)} character${characters === 1 ? '' : 's'} over ${group(
    lines,
  )} line${lines === 1 ? '' : 's'}. The box below scrolls.`;
}

/**
 * What approving actually does, in the three places the headline cannot say it.
 *
 * A project target names a destination that does not exist yet: Verity picks the project's one
 * eligible session after this decision, so the card names a project and the briefing lands in a
 * session the operator never saw named. The handoff deliberately does not require a standalone
 * turn — refusing a busy target would defeat the point of handing off to a working session — so
 * a briefing may join work already running rather than starting its own turn. And it is
 * delivered as a turn either way, so the target spends whatever standing grants it already
 * holds without asking again: the blast radius of this one approval is that session's existing
 * authority, not the handoff's own.
 *
 * `null` is the card's fallback path, where the input did not parse and the raw JSON is shown
 * in the summary's place. Every sentence here is true of a handoff regardless of what it names,
 * and that path is where the request is least trustworthy — dropping the caveats there would
 * withhold them from exactly the decision that needs them most. The only thing `null` costs is
 * the certainty of which target sentence applies, so both are folded into one.
 */
export function sessionHandoffCaveats(summary: SessionHandoffSummary | null): string {
  const resolvedAfterwards =
    'the name must match exactly one project, and that project must have exactly one eligible session, or the call fails rather than choosing';
  return `Written by the Verity Control agent, not by you. Allowing delivers it as a turn in ${
    summary === null ? 'the session the request above names' : 'that session'
  }, marked as agent-written material.${
    summary === null
      ? ` If that target is a project rather than a session, both halves of it are resolved after you allow this: ${resolvedAfterwards}.`
      : summary.targetKind === 'project'
        ? ` Both halves of that target are resolved after you allow this: ${resolvedAfterwards}.`
        : summary.targetKind === 'new-session'
          ? ' Allowing creates that session and delivers the briefing as its first turn.'
          : ''
  } If that session is already working, the briefing does not wait for it to finish: it is queued behind that work, or folded into the turn already running. The session then acts on it with the authority it already had, including any grant already standing there, which does not ask again. No standing grant covers the next handoff.`;
}

export type SessionProgressSummary = { sessionId: string };
export function sessionProgressSummary(input: unknown): SessionProgressSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!onlyKnownKeys(value, ['sessionId'])) return null;
  const sessionId = headlineText(value['sessionId']);
  return sessionId === null ? null : { sessionId };
}

export type RecentSessionMessagesSummary = {
  sessionId: string;
  count: number;
  sinceMinutes?: number;
  beforeSeq?: number;
  purpose: string;
};
export function recentSessionMessagesSummary(input: unknown): RecentSessionMessagesSummary | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!onlyKnownKeys(value, ['sessionId', 'count', 'sinceMinutes', 'beforeSeq', 'purpose']))
    return null;
  const sessionId = headlineText(value['sessionId']);
  const purpose = headlineText(value['purpose']);
  const count = value['count'] === undefined ? 20 : value['count'];
  const sinceMinutes = value['sinceMinutes'];
  const beforeSeq = value['beforeSeq'];
  if (
    sessionId === null ||
    purpose === null ||
    !Number.isInteger(count) ||
    (count as number) < 1 ||
    (count as number) > 50 ||
    (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || (beforeSeq as number) < 1)) ||
    (sinceMinutes !== undefined &&
      (!Number.isInteger(sinceMinutes) ||
        (sinceMinutes as number) < 1 ||
        (sinceMinutes as number) > 10_080))
  )
    return null;
  return {
    sessionId,
    purpose,
    count: count as number,
    ...(sinceMinutes === undefined ? {} : { sinceMinutes: sinceMinutes as number }),
    ...(beforeSeq === undefined ? {} : { beforeSeq: beforeSeq as number }),
  };
}

/**
 * What a `verity_list_sessions` approval card shows.
 *
 * Every gateway call is approval-gated with no waiver (ADR 0014 D2), and that holds for a
 * read-only tool too — so this card appears on each listing. A card that said only
 * "Allow verity_list_sessions?" would make the frequent decision the least informed one: it
 * would not say which project is being read, and it would not say what "read" means here.
 * Both belong on the card, because the answer to the second is the boundary the tool was
 * built around — metadata, never session content.
 *
 * Null when the input does not parse, as with the handoff summary, so the card falls back to
 * raw JSON rather than describing a request it did not understand.
 */
export type ListSessionsSummary = {
  /** `every project`, or the project reference as the caller wrote it. */
  scope: string;
  /** True when the listing is narrowed to sessions a handoff could actually reach. */
  activeOnly: boolean;
};

const EVERY_PROJECT = 'every project';

export function listSessionsSummary(input: unknown): ListSessionsSummary | null {
  // A call with no arguments at all is the common one, and it is a complete request: both
  // fields are optional. `undefined` and `{}` mean the same thing and read the same way.
  //
  // Defensive rather than reachable: the gateway normalises a missing `arguments` to `{}`
  // before either reader sees it, so this branch and `listSessionsRequestSchema` — which is a
  // bare `.strict()` object and would REJECT `undefined` — cannot actually disagree about the
  // same call. Kept because the card must not depend on that normalisation to stay truthful;
  // if it ever goes away, this branch is what stops the card describing a request the schema
  // is about to refuse, and the schema is what would need `.optional()` to match.
  if (input === undefined) return { scope: EVERY_PROJECT, activeOnly: true };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const request = input as Record<string, unknown>;
  if (!onlyKnownKeys(request, ['project', 'activeOnly'])) return null;
  const activeOnly = request['activeOnly'];
  if (activeOnly !== undefined && typeof activeOnly !== 'boolean') return null;
  const project = request['project'];
  if (project === undefined)
    return { scope: EVERY_PROJECT, activeOnly: activeOnly === undefined ? true : activeOnly };
  const scope = headlineText(project);
  if (scope === null) return null;
  return { scope, activeOnly: activeOnly === undefined ? true : activeOnly };
}

/** The card headline: which slice of the fleet is being read. */
export function listSessionsTitle(summary: ListSessionsSummary): string {
  return `List sessions in ${summary.scope}?`;
}

/**
 * What the listing returns, spelled out rather than implied.
 *
 * Naming the fields is the point: it is how the card shows that a session's transcript, its
 * messages and its model-written name are not among them. The names come from
 * `LIST_SESSIONS_FIELD_SENTENCE` rather than being written out here, so that a field added to
 * the listing cannot leave this card asserting an older, smaller list — the promise the
 * operator reads and the data the server sends are the same list.
 *
 * `null` is the fallback path, where the input did not parse. The metadata-only boundary is a
 * property of the tool rather than of the request, so it still holds and is still what the
 * operator is being asked about; only which slice of the fleet is being read becomes unknown.
 */
export function listSessionsSentence(summary: ListSessionsSummary | null): string {
  return `${
    summary === null
      ? 'The sessions the request above names'
      : summary.activeOnly
        ? 'Sessions that could receive a handoff'
        : 'Every session this tool can address, eligible or not'
  }, as metadata only: ${LIST_SESSIONS_FIELD_SENTENCE}. No transcript, no messages, no session names.`;
}
