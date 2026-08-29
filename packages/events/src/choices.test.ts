import { describe, expect, it } from 'vitest';
import {
  CHOICES_FENCE_TAG,
  CHOICES_SYSTEM_PROMPT,
  formatChoiceAnswer,
  parseChoicesBlock,
} from './choices.js';

/** Build a ` ```verity:choices ` fenced block around a JSON body. */
function fence(body: string): string {
  return `\`\`\`${CHOICES_FENCE_TAG}\n${body}\n\`\`\``;
}

describe('parseChoicesBlock', () => {
  it('returns the text verbatim and no choices when there is no block', () => {
    const input = 'Just some prose with no decision.';
    expect(parseChoicesBlock(input)).toEqual({ text: input });
  });

  it('synthesizes yes/no choices for a final go-ahead question when the fence is missing', () => {
    const input =
      'Die Checks sind grün.\n\nSoll ich bf07744 pushen und einen PR gegen main öffnen?';
    expect(parseChoicesBlock(input)).toEqual({
      text: input,
      choices: {
        question: 'Soll ich bf07744 pushen und einen PR gegen main öffnen?',
        options: [{ label: 'Ja', recommended: true }, { label: 'Nein' }],
        multiSelect: false,
      },
    });
  });

  it('synthesizes yes/no choices for terse English approval questions', () => {
    const input = 'Ready.\n\nPush?';
    expect(parseChoicesBlock(input).choices?.options.map((option) => option.label)).toEqual([
      'Ja',
      'Nein',
    ]);
  });

  it('synthesizes yes/no choices for English was questions', () => {
    const input = 'Was this expected?';
    expect(parseChoicesBlock(input).choices?.question).toBe(input);
  });

  it('does not synthesize choices for open-ended questions', () => {
    for (const input of [
      'Soll ich das umsetzen — und wenn ja, in welchem Scope?',
      'Was soll ich ändern?',
      'Soll ich was ändern?',
    ]) {
      expect(parseChoicesBlock(input)).toEqual({ text: input });
    }
  });

  it('does not synthesize choices for quoted or fenced questions', () => {
    expect(parseChoicesBlock('> Soll ich pushen?')).toEqual({ text: '> Soll ich pushen?' });
    expect(parseChoicesBlock('```text\nSoll ich pushen?\n```')).toEqual({
      text: '```text\nSoll ich pushen?\n```',
    });
  });

  it('lifts a well-formed block off the trailing prose', () => {
    const prose = 'Here are your options.\n\nWhich one?';
    const input = `${prose}\n\n${fence('{"options":[{"label":"A"},{"label":"B"}]}')}`;
    const { text, choices } = parseChoicesBlock(input);
    expect(text).toBe(prose);
    expect(choices).toEqual({ options: [{ label: 'A' }, { label: 'B' }] });
  });

  it('preserves question, recommended, and multiSelect fields', () => {
    const input = fence(
      '{"question":"Pick","options":[{"label":"A","recommended":true},{"label":"B"}],"multiSelect":true}',
    );
    const { choices } = parseChoicesBlock(input);
    expect(choices).toEqual({
      question: 'Pick',
      options: [{ label: 'A', recommended: true }, { label: 'B' }],
      multiSelect: true,
    });
  });

  it('yields an empty text when the block is the whole message', () => {
    const { text, choices } = parseChoicesBlock(fence('{"options":[{"label":"Go"}]}'));
    expect(text).toBe('');
    expect(choices).toBeDefined();
  });

  it('tolerates CRLF newlines and trailing spaces on the opener', () => {
    const input = `prose\r\n\`\`\`${CHOICES_FENCE_TAG}  \r\n{"options":[{"label":"A"}]}\r\n\`\`\``;
    const { text, choices } = parseChoicesBlock(input);
    expect(text).toBe('prose');
    expect(choices?.options).toEqual([{ label: 'A' }]);
  });

  it('honors the last block when several are present (the trailing one is operative)', () => {
    // The contract says "append one final block"; when an agent slips and emits
    // two (e.g. an illustrative example first, the real question last), the
    // trailing block is the decision.
    const input = `${fence('{"options":[{"label":"first"}]}')}\n${fence('{"options":[{"label":"second"}]}')}`;
    const { choices } = parseChoicesBlock(input);
    expect(choices?.options).toEqual([{ label: 'second' }]);
  });

  it('strips a stray second fence from the prose so it never leaks as raw JSON', () => {
    // Regression: two fences left the non-honored one in the prose, where the
    // renderer showed it as a raw-JSON code card next to the real chips.
    const input = `intro\n${fence('{"options":[{"label":"example"}]}')}\nmiddle\n${fence('{"options":[{"label":"real"}]}')}`;
    const { text, choices } = parseChoicesBlock(input);
    expect(choices?.options).toEqual([{ label: 'real' }]);
    expect(text).not.toContain(CHOICES_FENCE_TAG);
    expect(text).toBe('intro\n\nmiddle');
  });

  it('falls back to an earlier valid block when the last is unparseable', () => {
    // Last fence is un-repairable garbage; the earlier valid one still surfaces,
    // and both fences are stripped from the prose.
    const input = `${fence('{"options":[{"label":"valid"}]}')}\n${fence('not json at all')}`;
    const { text, choices } = parseChoicesBlock(input);
    expect(choices?.options).toEqual([{ label: 'valid' }]);
    expect(text).not.toContain(CHOICES_FENCE_TAG);
  });

  it('degrades to plain text on non-JSON body (no throw, no choices)', () => {
    const input = fence('not json at all');
    expect(parseChoicesBlock(input)).toEqual({ text: input });
  });

  it('recovers an unescaped double-quote in the question (the live screenshot bug)', () => {
    // Verbatim shape that rendered as raw JSON on mobile: the closing of the
    // German „…" phrase was a straight `"`, ending the JSON string early. The
    // lenient repair pass must lift it into chips rather than leak the fence.
    const body =
      '{"question":"#37 + #28 schließen + Follow-up „live permission UI" aufmachen?","options":[{"label":"Ja","recommended":true},{"label":"Offen lassen"}]}';
    const { text, choices } = parseChoicesBlock(fence(body));
    expect(text).toBe('');
    expect(choices?.question).toBe(
      '#37 + #28 schließen + Follow-up „live permission UI" aufmachen?',
    );
    expect(choices?.options.map((o) => o.label)).toEqual(['Ja', 'Offen lassen']);
    expect(choices?.options[0]?.recommended).toBe(true);
  });

  it('recovers an unescaped double-quote inside a label', () => {
    const body = '{"options":[{"label":"Say "commit" now"},{"label":"Hold"}]}';
    const { choices } = parseChoicesBlock(fence(body));
    expect(choices?.options.map((o) => o.label)).toEqual(['Say "commit" now', 'Hold']);
  });

  it('recovers a trailing comma in the options array', () => {
    const { choices } = parseChoicesBlock(fence('{"options":[{"label":"A"},{"label":"B"},]}'));
    expect(choices?.options.map((o) => o.label)).toEqual(['A', 'B']);
  });

  it('still degrades to raw text when repair cannot produce a schema-valid payload', () => {
    // Repairable into JSON, but the result violates the schema (empty options) —
    // must fall back to the verbatim block, never a partial/garbage choices event.
    const input = fence('{"options":[],}');
    expect(parseChoicesBlock(input)).toEqual({ text: input });
  });

  it('degrades to plain text on schema-invalid payloads', () => {
    // Empty options array violates `.min(1)`.
    expect(parseChoicesBlock(fence('{"options":[]}'))).toEqual({
      text: fence('{"options":[]}'),
    });
    // A blank label violates `.min(1)`.
    expect(parseChoicesBlock(fence('{"options":[{"label":""}]}')).choices).toBeUndefined();
    // Missing options entirely.
    expect(parseChoicesBlock(fence('{"question":"hi"}')).choices).toBeUndefined();
  });
});

describe('formatChoiceAnswer', () => {
  it('returns a single label unchanged', () => {
    expect(formatChoiceAnswer(['Build it now'])).toBe('Build it now');
  });

  it('joins multiple labels with a comma', () => {
    expect(formatChoiceAnswer(['A', 'B', 'C'])).toBe('A, B, C');
  });

  it('returns an empty string for no labels', () => {
    expect(formatChoiceAnswer([])).toBe('');
  });
});

describe('CHOICES_SYSTEM_PROMPT', () => {
  it('names the fence tag so the instructed format matches the parser', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain(CHOICES_FENCE_TAG);
  });

  it('warns the agent to escape inner double-quotes (the main break source)', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain('\\"');
  });

  it('skips only the final merge decision, not commit/push go-aheads', () => {
    // The PR status/merge bar owns the merge click, so the block must not
    // duplicate it — but a go-ahead that merely culminates in push/open-PR is
    // still a decision and must keep emitting the block (regression: #948e0639,
    // a "land this? → push + PR" ask that wrongly suppressed the block).
    expect(CHOICES_SYSTEM_PROMPT).toContain('final merge decision on an open PR');
    expect(CHOICES_SYSTEM_PROMPT).toContain('commit, review, push, or open a PR');
    expect(CHOICES_SYSTEM_PROMPT).toContain('When not already authorized');
    expect(CHOICES_SYSTEM_PROMPT).toContain(
      'when the user already requested the action, execute it without another choice',
    );
  });

  it('states that approval question choices are mandatory', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain('mandatory for yes/no approval questions');
    expect(CHOICES_SYSTEM_PROMPT).toContain('Soll ich ...?');
    expect(CHOICES_SYSTEM_PROMPT).toContain('Push + PR');
  });

  it('makes selected actions executable without redundant confirmation', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain("sent verbatim as the user's next message");
    expect(CHOICES_SYSTEM_PROMPT).toContain(
      'proceed without asking for the same confirmation again',
    );
    expect(CHOICES_SYSTEM_PROMPT).toContain('Offer only actions you can actually perform');
  });

  it('reserves choices for consequential decisions instead of obvious fixes', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain(
      'Do not use a Quick Action to defer work already authorized',
    );
    expect(CHOICES_SYSTEM_PROMPT).toContain('small, low-risk solution is clear');
    expect(CHOICES_SYSTEM_PROMPT).toContain('materially different solution approaches');
  });

  it('tells the agent not to narrate PR/check status updates', () => {
    expect(CHOICES_SYSTEM_PROMPT).toContain('check-only status prose');
    expect(CHOICES_SYSTEM_PROMPT).toContain('poll/monitor PR checks/CI');
    expect(CHOICES_SYSTEM_PROMPT).toContain('gh pr checks');
  });

  it('round-trips: an example shaped like the contract parses back', () => {
    // Mirror the exact JSON skeleton the prompt instructs the agent to emit.
    const example = fence(
      '{"question":"Which?","options":[{"label":"Do A","recommended":true},{"label":"Do B"}],"multiSelect":false}',
    );
    const { choices } = parseChoicesBlock(example);
    expect(choices?.options.map((o) => o.label)).toEqual(['Do A', 'Do B']);
    expect(choices?.options[0]?.recommended).toBe(true);
  });
});
