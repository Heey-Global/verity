import { describe, expect, it } from 'vitest';
import { splitNoticeText } from './systemNotice.js';

describe('splitNoticeText', () => {
  it('uses the first sentence as the headline and the rest as the explanation', () => {
    expect(
      splitNoticeText(
        'Preparing project environment. Checking the agent connection and tools. Your message continues automatically when they’re ready.',
      ),
    ).toEqual({
      title: 'Preparing project environment',
      detail:
        'Checking the agent connection and tools. Your message continues automatically when they’re ready.',
    });
  });

  it('keeps a single sentence or fragment as one headline', () => {
    expect(splitNoticeText('Installing dependencies.')).toEqual({
      title: 'Installing dependencies',
    });
    expect(splitNoticeText('Waiting for the Sandbox')).toEqual({
      title: 'Waiting for the Sandbox',
    });
  });

  it('keeps an ellipsis or an abbreviation inside the headline', () => {
    expect(splitNoticeText('Cloning repository...')).toEqual({ title: 'Cloning repository...' });
    expect(splitNoticeText('Waiting for e.g. the Sandbox')).toEqual({
      title: 'Waiting for e.g. the Sandbox',
    });
  });
});
