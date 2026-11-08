// A reviewer decides on what a proposal changes. Shown wrong, the review
// approves text nobody saw: an unchanged page shown as one big replacement, a
// removed paragraph left out, or a new page shown as a replacement of nothing.
import { proposalPassages } from './wikiProposalDiff';

describe('proposalPassages', () => {
  it('shows a new page as new text', () => {
    expect(proposalPassages(null, '# Billing\n\nMonthly.')).toEqual([
      { after: '# Billing\n\nMonthly.' },
    ]);
  });

  it('shows only the paragraphs that change, with what they replace', () => {
    const current = '# Plan\n\nIntro.\n\nOld step.\n\nOutro.';
    const proposed = '# Plan\n\nIntro.\n\nNew step.\n\nOutro.\n\nAdded note.';
    expect(proposalPassages(current, proposed)).toEqual([
      { before: 'Old step.', after: 'New step.' },
      { after: 'Added note.' },
    ]);
  });

  it('shows a removed paragraph and nothing for an unchanged page', () => {
    expect(proposalPassages('A\n\nB\n\nC', 'A\n\nC')).toEqual([{ before: 'B' }]);
    expect(proposalPassages('A\r\n\r\nB', 'A\n\nB')).toEqual([]);
  });
});
