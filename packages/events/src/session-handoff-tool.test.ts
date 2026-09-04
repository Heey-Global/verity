import { describe, expect, it } from 'vitest';

import { listSessionsRequestSchema, sessionHandoffRequestSchema } from './session-handoff-tool.js';

describe('listSessionsRequestSchema', () => {
  it('accepts an empty request and both narrowings', () => {
    expect(listSessionsRequestSchema.parse({})).toEqual({});
    expect(
      listSessionsRequestSchema.parse({ project: ' acme/website ', activeOnly: false }),
    ).toEqual({ project: 'acme/website', activeOnly: false });
  });

  it('refuses an unknown key, so a misspelled filter cannot widen the listing silently', () => {
    expect(() => listSessionsRequestSchema.parse({ projects: 'acme/website' })).toThrow();
  });
});

describe('sessionHandoffRequestSchema', () => {
  const valid = {
    target: { sessionId: 'agent-a6d21d43' },
    title: 'Overlay for the new site',
    briefing: 'Everything the other session needs.',
  };

  it('accepts either target shape, but not both at once', () => {
    expect(sessionHandoffRequestSchema.parse(valid).target).toEqual({
      sessionId: 'agent-a6d21d43',
    });
    expect(
      sessionHandoffRequestSchema.parse({ ...valid, target: { project: 'acme/website' } }),
    ).toBeTruthy();
    expect(
      sessionHandoffRequestSchema.parse({
        ...valid,
        target: { newSession: { project: 'acme/website' } },
      }).target,
    ).toEqual({ newSession: { project: 'acme/website' } });
    expect(() =>
      sessionHandoffRequestSchema.parse({
        ...valid,
        target: { sessionId: 's', project: 'acme/website' },
      }),
    ).toThrow();
  });

  it('takes a title in any script but refuses one that could misdescribe the target', () => {
    // The approval card renders the title and the target next to fixed words. Ordinary
    // writing has to survive that; characters that can restructure the sentence do not.
    expect(
      sessionHandoffRequestSchema.parse({ ...valid, title: 'Überlagerung — Runde 2' }).title,
    ).toBe('Überlagerung — Runde 2');
    // A ZWNJ is required to spell ordinary Persian and Hindi words, and a ZWJ to write an
    // emoji sequence; neither can reorder a line, so neither is refused.
    expect(sessionHandoffRequestSchema.parse({ ...valid, title: 'می\u200cرود' }).title).toBe(
      'می\u200cرود',
    );
    for (const title of [
      '',
      '   ',
      'go\nhere',
      'a\u202eb',
      'a\u2066b',
      'a\u200fb',
      // LINE and PARAGRAPH SEPARATOR: outside `\p{Cc}`, and they break the rendered line.
      'a\u2028b',
      'a\u2029b',
      // The Arabic letter mark is an implicit bidi control, in the same family as the LRM
      // and RLM above.
      'a\u061cb',
      'x'.repeat(121),
    ]) {
      expect(() => sessionHandoffRequestSchema.parse({ ...valid, title })).toThrow();
    }
    for (const sessionId of ['s\nx', 'a\u202eb']) {
      expect(() =>
        sessionHandoffRequestSchema.parse({ ...valid, target: { sessionId } }),
      ).toThrow();
    }
  });

  it('keeps a multi-line briefing intact, because it is shown as a body of text', () => {
    const briefing = `Line one\n\nLine two — mit Gedankenstrich`;
    expect(sessionHandoffRequestSchema.parse({ ...valid, briefing }).briefing).toBe(briefing);
    expect(() => sessionHandoffRequestSchema.parse({ ...valid, briefing: '' })).toThrow();
    expect(() =>
      sessionHandoffRequestSchema.parse({ ...valid, briefing: 'x'.repeat(20_001) }),
    ).toThrow();
  });

  it('refuses an unknown key rather than dropping it', () => {
    expect(() =>
      sessionHandoffRequestSchema.parse({ ...valid, protectedEnvironment: 'prod' }),
    ).toThrow();
  });
});
