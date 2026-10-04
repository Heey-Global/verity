import { describe, expect, it } from 'vitest';
import { parseAutomationProposal } from './automation.js';

const proposal = {
  name: 'Morning review',
  schedule: { kind: 'daily', hour: 9, minute: 0 },
  prompt: 'Summarize the open pull requests.',
};

describe('parseAutomationProposal', () => {
  it('lifts a prompt-only proposal and removes its contract fence from prose', () => {
    const input = [
      'Here is the automation I propose.',
      '```verity:automation',
      JSON.stringify(proposal),
      '```',
    ].join('\n');

    expect(parseAutomationProposal(input)).toEqual({
      text: 'Here is the automation I propose.',
      proposal,
    });
  });

  it('keeps an optional check script', () => {
    const withScript = { ...proposal, script: 'test -n "$(git status --porcelain)" && exit 10' };
    const input = `\`\`\`verity:automation\n${JSON.stringify(withScript)}\n\`\`\``;
    expect(parseAutomationProposal(input).proposal).toEqual(withScript);
  });

  it('leaves a proposal without a prompt visible as plain prose', () => {
    const input =
      '```verity:automation\n{"name":"No task","schedule":{"kind":"daily","hour":9,"minute":0}}\n```';
    expect(parseAutomationProposal(input)).toEqual({ text: input });
  });

  it('rejects intervals shorter than fifteen minutes', () => {
    const input = `\`\`\`verity:automation\n${JSON.stringify({
      ...proposal,
      schedule: { kind: 'interval', everyMinutes: 5 },
    })}\n\`\`\``;
    expect(parseAutomationProposal(input).proposal).toBeUndefined();
  });

  it('keeps an invalid fence visible beside a valid proposal', () => {
    const invalid = '```verity:automation\n{"name":"missing prompt"}\n```';
    const valid = `\`\`\`verity:automation\n${JSON.stringify(proposal)}\n\`\`\``;
    expect(parseAutomationProposal(`${invalid}\n${valid}`)).toEqual({ text: invalid, proposal });
  });
});
