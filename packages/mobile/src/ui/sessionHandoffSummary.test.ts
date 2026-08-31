import {
  LIST_SESSIONS_FIELDS,
  listSessionsRequestSchema,
  sessionHandoffRequestSchema,
} from '@verity/events';
import { describe, expect, it } from 'vitest';

import {
  briefingExtent,
  listSessionsSentence,
  listSessionsSummary,
  listSessionsTitle,
  sessionHandoffCaveats,
  sessionHandoffSummary,
  sessionHandoffTitle,
} from './sessionHandoffSummary.js';

describe('sessionHandoffSummary', () => {
  it('names the target and carries the briefing verbatim, however long', () => {
    const briefing = `Digest sha256:abc\n\n${'x'.repeat(19_000)}\nlast line`;
    const summary = sessionHandoffSummary({
      target: { sessionId: 'sess-web' },
      title: 'Overlay for the new site',
      briefing,
    });
    expect(summary).toEqual({
      target: 'session sess-web',
      targetKind: 'session',
      title: 'Overlay for the new site',
      // Not clamped, not squashed to one line: the card is the only place this is read
      // before it becomes a turn somewhere else.
      briefing,
      // 17 + 2 + 19,000 + 1 + 9 characters. Three newlines — the blank-line pair after the
      // digest, and the one before the last line — so four lines. None of them trails.
      briefingSize: { characters: 19_029, lines: 4 },
    });
    expect(sessionHandoffTitle(summary!)).toBe('Send briefing to session sess-web?');
  });

  it('names a project target as a project', () => {
    const summary = sessionHandoffSummary({
      target: { project: 'acme/website' },
      title: 't',
      briefing: 'b',
    });
    expect(sessionHandoffTitle(summary!)).toBe('Send briefing to project acme/website?');
    expect(summary!.targetKind).toBe('project');
  });

  it('says on a project target that the destination is chosen after the decision', () => {
    // The one thing the headline cannot say: a project target names no session, so the card
    // has to admit that approving picks one the operator never saw named. Both resolutions
    // are stated, because both happen after the decision — `resolveProjectReference` also
    // accepts a bare repo name, so the reference the operator reads is not necessarily the
    // `owner/repo` the briefing lands in. Each refuses rather than choosing when it is not
    // unique, which is what makes the card's promise checkable.
    const toProject = sessionHandoffCaveats(
      sessionHandoffSummary({ target: { project: 'acme/website' }, title: 't', briefing: 'b' }),
    );
    expect(toProject).toContain('resolved after you allow this');
    expect(toProject).toContain('exactly one project');
    expect(toProject).toContain('exactly one eligible session');
    expect(toProject).toContain('fails rather than choosing');

    const toSession = sessionHandoffCaveats(
      sessionHandoffSummary({ target: { sessionId: 'sess-web' }, title: 't', briefing: 'b' }),
    );
    expect(toSession).not.toContain('resolved after you allow this');

    // Said in both cases, because it is the part that outlasts the decision: the briefing
    // arrives as a turn, so the target spends the grants it already holds without asking.
    for (const caveats of [toProject, toSession]) {
      expect(caveats).toContain('not by you');
      expect(caveats).toContain('does not ask again');
      expect(caveats).toContain('No standing grant covers the next handoff.');
    }
  });

  it('says a busy target is not waited for, because the handoff does not require a standalone turn', () => {
    // `dispatchTurn` is called without `requireStandalone` on purpose — refusing a busy target
    // would defeat handing off to a working session — so a briefing can be queued behind the
    // work in flight or steered into it. Landing inside a turn already holding a capability is
    // the most consequential of the three outcomes, and it is the one nothing else on the card
    // names, so the caveats have to.
    const caveats = sessionHandoffCaveats(
      sessionHandoffSummary({ target: { sessionId: 'sess-web' }, title: 't', briefing: 'b' }),
    );
    expect(caveats).toContain('does not wait for it to finish');
    expect(caveats).toContain('folded into the turn already running');
  });

  it('still states the caveats when the input did not parse', () => {
    // The fallback card shows raw JSON in the summary's place. Every caveat is a property of
    // the tool rather than of the request, so dropping them there would withhold them from the
    // decision that needs them most — the one made on an input nothing could describe.
    const caveats = sessionHandoffCaveats(null);
    expect(caveats).toContain('not by you');
    expect(caveats).toContain('does not ask again');
    expect(caveats).toContain('No standing grant covers the next handoff.');
    expect(caveats).toContain('folded into the turn already running');
    // The target is unread, so the sentence covers the project case conditionally rather than
    // claiming a session was named.
    expect(caveats).toContain('If that target is a project rather than a session');
    expect(caveats).toContain('fails rather than choosing');
  });

  it('still states the metadata-only boundary when a listing input did not parse', () => {
    const sentence = listSessionsSentence(null);
    expect(sentence).toContain('metadata only');
    expect(sentence).toContain('No transcript, no messages, no session names.');
    for (const field of LIST_SESSIONS_FIELDS) expect(sentence).toContain(field.label);
    // Which slice of the fleet is being read is the one thing an unreadable input costs.
    expect(sentence).not.toContain('Sessions that could receive a handoff');
  });

  it('refuses an input it cannot describe, so the card falls back to raw JSON', () => {
    for (const input of [
      undefined,
      null,
      'a string',
      [{ target: { sessionId: 's' } }],
      { title: 't', briefing: 'b' },
      { target: {}, title: 't', briefing: 'b' },
      { target: { sessionId: 's' }, briefing: 'b' },
      { target: { sessionId: 's' }, title: 't' },
      { target: { sessionId: 's' }, title: 't', briefing: '' },
      // Whitespace-only: judged the way the schema judges it, so the card never renders a
      // blank body under a confident headline.
      { target: { sessionId: 's' }, title: 't', briefing: '  \n  ' },
      // A headline field that would misrender the sentence it sits in.
      { target: { sessionId: 'a\u202eb' }, title: 't', briefing: 'b' },
      { target: { sessionId: 's' }, title: 'go\nhere', briefing: 'b' },
      { target: { sessionId: 's' }, title: '   ', briefing: 'b' },
      // Line and paragraph separators break a rendered line without being `\p{Cc}`, and
      // the Arabic letter mark reorders one without being the LRM or RLM.
      { target: { sessionId: 's' }, title: 'go\u2028here', briefing: 'b' },
      { target: { sessionId: 's' }, title: 'go\u2029here', briefing: 'b' },
      { target: { sessionId: 'a\u061cb' }, title: 't', briefing: 'b' },
      // Past what the schema would ever have admitted.
      { target: { sessionId: 's' }, title: 'x'.repeat(201), briefing: 'b' },
    ]) {
      expect(sessionHandoffSummary(input)).toBeNull();
    }
  });

  it('refuses a target naming both a session and a project, rather than picking one', () => {
    // The schema's target is a union of two `.strict()` objects, so this is refused server
    // side too. What matters here is that the card does not fall through to the readable key
    // and headline a target the request does not name: the session id below fails the
    // headline filter, and reporting "project acme/website" would describe a delivery that
    // was never requested.
    expect(
      sessionHandoffSummary({
        target: { sessionId: 'a\u202eb', project: 'acme/website' },
        title: 't',
        briefing: 'b',
      }),
    ).toBeNull();
    // Both readable is refused for the same reason — one request, one destination.
    expect(
      sessionHandoffSummary({
        target: { sessionId: 'sess-web', project: 'acme/website' },
        title: 't',
        briefing: 'b',
      }),
    ).toBeNull();
    // And an explicit `undefined` still names the key. Zod's `.strict()` counts it as present
    // and refuses the request, so a card reading this as a plain project target would describe
    // a delivery the server is about to reject.
    const explicitUndefined = {
      target: { sessionId: undefined, project: 'acme/website' },
      title: 't',
      briefing: 'b',
    };
    expect(sessionHandoffSummary(explicitUndefined)).toBeNull();
    expect(sessionHandoffRequestSchema.safeParse(explicitUndefined).success).toBe(false);
  });

  it('refuses a request carrying a field it would not show', () => {
    // A confident card that silently omits a field is the failure this card exists to
    // prevent — `protectedEnvironment` is the shape of the thing that must never ride along
    // unseen. The server's `.strict()` refuses it too; this is the half that runs on what
    // arrived rather than on what should have.
    for (const input of [
      { target: { sessionId: 's' }, title: 't', briefing: 'b', protectedEnvironment: 'prod' },
      { target: { sessionId: 's', requireStandalone: true }, title: 't', briefing: 'b' },
    ]) {
      expect(sessionHandoffSummary(input)).toBeNull();
      expect(sessionHandoffRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it('renders a headline in any script, refusing only what would deceive', () => {
    const summary = sessionHandoffSummary({
      target: { project: 'acme/überlagerung' },
      title: 'Überlagerung — Runde 2',
      briefing: 'b',
    });
    expect(sessionHandoffTitle(summary!)).toBe('Send briefing to project acme/überlagerung?');
    expect(summary?.title).toBe('Überlagerung — Runde 2');
    // A ZWNJ is a formatting character, but a required one — it must not blank the card.
    expect(
      sessionHandoffSummary({ target: { sessionId: 's' }, title: 'می\u200cرود', briefing: 'b' })
        ?.title,
    ).toBe('می\u200cرود');
  });

  it('spells out bidi controls in the briefing instead of letting them reorder it', () => {
    // The card's whole job is to show what the target session will receive. An invisible
    // override would let the operator read one order and the model read another, so each
    // control is named where it sits — the briefing is annotated, never filtered out.
    const summary = sessionHandoffSummary({
      target: { sessionId: 's' },
      title: 't',
      briefing: 'Delete\u202e nothing\u202c, then stop',
    });
    expect(summary?.briefing).toBe('Delete<U+202E> nothing<U+202C>, then stop');
    // Everything else survives untouched, including the characters the headline refuses.
    expect(
      sessionHandoffSummary({
        target: { sessionId: 's' },
        title: 't',
        briefing: 'می\u200cرود\n\tzwei',
      })?.briefing,
    ).toBe('می\u200cرود\n\tzwei');
  });

  it('shows a briefing that headline filtering would have rejected', () => {
    // The briefing is rendered as a body, not woven into a sentence — refusing to show one
    // because it contains a newline or a non-ASCII character would defeat the point.
    const summary = sessionHandoffSummary({
      target: { sessionId: 's' },
      title: 't',
      briefing: 'Zeile eins\nZeile zwei — mit Gedankenstrich',
    });
    expect(summary?.briefing).toBe('Zeile eins\nZeile zwei — mit Gedankenstrich');
  });

  it('accepts exactly the title characters the server schema accepts', () => {
    // Characters, not lengths: the card's ceiling is deliberately the loosest of the schema's
    // three headline fields (200), so an over-long title still renders as a described request
    // rather than as raw JSON. Length is the server's to refuse.
    //
    // Both sides now test the same imported class, so this can no longer catch the two naming
    // different characters — that failure was designed out rather than tested for. What it
    // still catches is a SECOND filter appearing on one side and not the other: an extra
    // `.refine` on the schema, or a normalisation step ahead of the class here. So the probes
    // are the decision boundary rather than a sweep — one representative of each reason the
    // class names a character, and the near misses it deliberately admits.
    const probes: number[] = [
      0x0009, // CHARACTER TABULATION — \p{Cc}, and mid-string the trim does not reach it
      0x000a, // LINE FEED — splits the sentence
      0x000d, // CARRIAGE RETURN — overwrites it
      0x0000, // NULL, the low end of \p{Cc}
      0x009f, // APPLICATION PROGRAM COMMAND, the high end of the C1 block
      0x2028, // LINE SEPARATOR — \p{Zl}, so not covered by \p{Cc}
      0x2029, // PARAGRAPH SEPARATOR — \p{Zp}, likewise
      0x061c, // ARABIC LETTER MARK
      0x200e, // LEFT-TO-RIGHT MARK
      0x200f, // RIGHT-TO-LEFT MARK
      0x202a, // LEFT-TO-RIGHT EMBEDDING, the low end of the embedding/override range
      0x202e, // RIGHT-TO-LEFT OVERRIDE, its high end
      0x2066, // LEFT-TO-RIGHT ISOLATE, the low end of the isolate range
      0x2069, // POP DIRECTIONAL ISOLATE, its high end
      // Admitted, and each for a reason the class's doc names. Neighbours of the rejected
      // ranges, so a range widened by one code point fails here.
      0x00a0, // NO-BREAK SPACE, one past the C1 block
      0x00ad, // SOFT HYPHEN — German hyphenation
      0x200b, // ZERO WIDTH SPACE
      0x200c, // ZERO WIDTH NON-JOINER — Persian
      0x200d, // ZERO WIDTH JOINER — Hindi, and emoji sequences
      0x2027, // HYPHENATION POINT, one before LINE SEPARATOR
      0x202f, // NARROW NO-BREAK SPACE, one past the override range
      0x2065, // unassigned, one before the isolate range
      0x206a, // INHIBIT SYMMETRIC SWAPPING, one past it
      0x00fc, // LATIN SMALL LETTER U WITH DIAERESIS
      0x2014, // EM DASH
      0x1f600, // GRINNING FACE — above the BMP, where neither class names anything
      0x10e60, // RUMI DIGIT ONE — likewise
    ];
    const rejectedByCard: number[] = [];
    const rejectedBySchema: number[] = [];
    for (const code of probes) {
      const title = `a${String.fromCodePoint(code)}b`;
      const card = sessionHandoffSummary({ target: { sessionId: 's' }, title, briefing: 'b' });
      if (card === null) rejectedByCard.push(code);
      const parsed = sessionHandoffRequestSchema.safeParse({
        target: { sessionId: 's' },
        title,
        briefing: 'b',
      });
      if (!parsed.success) rejectedBySchema.push(code);
    }
    expect(rejectedByCard).toEqual(rejectedBySchema);
    // And the comparison is not vacuous in either direction: the deceptive half was refused,
    // and the characters that spell ordinary words were not.
    expect(rejectedByCard).toEqual(probes.slice(0, 14));
    expect(rejectedByCard).toContain(0x202e);
    expect(rejectedByCard).not.toContain(0x200d);
  });
});

describe('briefingExtent', () => {
  const extent = (briefing: string) => {
    const summary = sessionHandoffSummary({ target: { sessionId: 's' }, title: 't', briefing });
    return summary === null ? null : briefingExtent(summary);
  };

  it('states the extent before the box that would otherwise hide it', () => {
    expect(extent('one line')).toBe('Briefing: 8 characters over 1 line. The box below scrolls.');
    expect(extent('a\nb\nc')).toBe('Briefing: 5 characters over 3 lines. The box below scrolls.');
  });

  it('groups the number a person is asked to judge a reading length by', () => {
    expect(extent(`${'x'.repeat(19_999)}\ny`)).toBe(
      'Briefing: 20,001 characters over 2 lines. The box below scrolls.',
    );
  });

  it('counts an emoji as the one character it looks like', () => {
    // Two UTF-16 units, one thing on screen. The number exists to set a reading expectation,
    // so it counts what is read rather than what is stored.
    expect(extent('ab😀')).toBe('Briefing: 3 characters over 1 line. The box below scrolls.');
  });

  it('measures the briefing that is sent, not the annotated one that is shown', () => {
    // `spellOutBidiControls` renders each control as eight visible characters, so counting the
    // displayed string would report a size the target session never receives — and inflate it
    // most for exactly the briefings that already deserve a closer read.
    const summary = sessionHandoffSummary({
      target: { sessionId: 's' },
      title: 't',
      briefing: 'ab\u202ecd',
    });
    expect(summary?.briefing).toBe('ab<U+202E>cd');
    expect(briefingExtent(summary!)).toBe(
      'Briefing: 5 characters over 1 line. The box below scrolls.',
    );
  });

  it('shows and measures the briefing the way the schema trims it', () => {
    // `sessionHandoffRequestSchema`'s `z.string().trim()` is a transform, not just a check, so
    // the target session receives the trimmed string and the server hashes that. A card that
    // rendered the raw argument would show whitespace nobody is sent, and — worse for a number
    // the operator is asked to judge a reading length by — let a briefing padded with a
    // thousand trailing newlines announce itself as a thousand lines long.
    const summary = sessionHandoffSummary({
      target: { sessionId: 's' },
      title: 't',
      briefing: `\n\n  one\ntwo  ${'\n'.repeat(1000)}`,
    });
    expect(summary?.briefing).toBe('one\ntwo');
    expect(briefingExtent(summary!)).toBe(
      'Briefing: 7 characters over 2 lines. The box below scrolls.',
    );
  });
});

describe('listSessionsSummary', () => {
  it('describes the whole-fleet listing, which is the call with no arguments', () => {
    for (const input of [undefined, {}, { activeOnly: true }]) {
      const summary = listSessionsSummary(input);
      expect(summary).toEqual({ scope: 'every project', activeOnly: true });
      expect(listSessionsTitle(summary!)).toBe('List sessions in every project?');
    }
    // The default matches the schema's: omitting `activeOnly` means the narrowed listing.
    expect(listSessionsRequestSchema.parse({}).activeOnly).toBeUndefined();
  });

  it('names the project when the listing is narrowed to one', () => {
    const summary = listSessionsSummary({ project: 'acme/website', activeOnly: false });
    expect(summary).toEqual({ scope: 'acme/website', activeOnly: false });
    expect(listSessionsTitle(summary!)).toBe('List sessions in acme/website?');
  });

  it('says metadata only, and names what that excludes', () => {
    // This sentence is the boundary the tool was built around: a listing must not become a
    // way to read another session's content, and the card is where that is stated.
    const sentence = listSessionsSentence(listSessionsSummary({}));
    expect(sentence).toContain('metadata only');
    expect(sentence).toContain('No transcript, no messages, no session names.');
    // Every field the listing returns is named, because the sentence is read as an exhaustive
    // one: a field present in the result but missing here would make the card understate it.
    // The server test holds the other end, asserting its entry keys against the same array.
    for (const field of LIST_SESSIONS_FIELDS) expect(sentence).toContain(field.label);
    expect(sentence).toContain('Sessions that could receive a handoff');
    expect(listSessionsSentence(listSessionsSummary({ activeOnly: false }))).toContain(
      'Every session this tool can address, eligible or not',
    );
  });

  it('refuses an input it cannot describe, so the card falls back to raw JSON', () => {
    for (const input of [
      null,
      'a string',
      [{}],
      { activeOnly: 'yes' },
      { project: 42 },
      { project: '   ' },
      // A project reference that would misrender the headline it sits in.
      { project: 'acme/\u202ebisuv' },
      // The schema is `.strict()`, so a key this card cannot see would be refused anyway.
      { project: 'acme/website', sessionId: 'sess-web' },
    ]) {
      expect(listSessionsSummary(input)).toBeNull();
      if (input !== null && typeof input === 'object' && !Array.isArray(input))
        expect(listSessionsRequestSchema.safeParse(input).success).toBe(false);
    }
  });
});
