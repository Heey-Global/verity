import { describe, expect, it } from 'vitest';

import {
  formatProjectInquiryAnswerTurn,
  parseProjectInquiryAnswerTurn,
} from './project-inquiry-answer.js';

describe('project inquiry answer turn', () => {
  it('reads back what the server writes, including blank lines in the answer', () => {
    const turn = {
      inquiryId: 'inq-1',
      title: 'Why does the supervisor reject the OCR import?',
      answer: 'Two PDFs have a cover page.\n\nThe import stops before OCR.',
    };
    expect(parseProjectInquiryAnswerTurn(formatProjectInquiryAnswerTurn(turn))).toEqual(turn);
  });

  it('keeps an empty answer', () => {
    const turn = { inquiryId: 'inq-2', title: 'Title', answer: '' };
    expect(parseProjectInquiryAnswerTurn(formatProjectInquiryAnswerTurn(turn))).toEqual(turn);
  });

  // An operator's own prompt that merely quotes the preamble must stay their message.
  it('leaves any other prompt alone', () => {
    expect(parseProjectInquiryAnswerTurn('Please check the OCR import.')).toBeNull();
    const quoted = formatProjectInquiryAnswerTurn({ inquiryId: 'x', title: 't', answer: 'a' });
    expect(parseProjectInquiryAnswerTurn(`> ${quoted}`)).toBeNull();
    expect(
      parseProjectInquiryAnswerTurn(quoted.replace('Request: x', 'Requested by someone')),
    ).toBeNull();
  });
});
