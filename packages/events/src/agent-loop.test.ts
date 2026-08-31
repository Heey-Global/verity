import { describe, expect, it } from 'vitest';
import { parseAgentLoopProposal } from './agent-loop.js';

describe('parseAgentLoopProposal', () => {
  it('lifts a valid proposal and removes its contract fence from prose', () => {
    const input = [
      'Here is the loop I propose.',
      '```verity:agent-loop',
      JSON.stringify({
        loopId: '11111111-1111-4111-8111-111111111111',
        name: 'Dependency audit',
        script: '#!/bin/sh\nexit 0',
        schedule: { kind: 'interval', everyMinutes: 30 },
      }),
      '```',
    ].join('\n');

    expect(parseAgentLoopProposal(input)).toEqual({
      text: 'Here is the loop I propose.',
      proposal: {
        loopId: '11111111-1111-4111-8111-111111111111',
        name: 'Dependency audit',
        script: '#!/bin/sh\nexit 0',
        schedule: { kind: 'interval', everyMinutes: 30 },
      },
    });
  });

  it('leaves an invalid proposal visible as plain prose', () => {
    const input = '```verity:agent-loop\n{"name":"missing loop id"}\n```';
    expect(parseAgentLoopProposal(input)).toEqual({ text: input });
  });

  it('keeps an invalid fence visible beside a valid proposal', () => {
    const invalid = '```verity:agent-loop\n{"name":"missing loop id"}\n```';
    const valid = `\`\`\`verity:agent-loop\n${JSON.stringify({
      loopId: '11111111-1111-4111-8111-111111111111',
      name: 'Audit',
      script: 'exit 0',
      schedule: { kind: 'interval', everyMinutes: 30 },
    })}\n\`\`\``;
    expect(parseAgentLoopProposal(`${invalid}\n${valid}`).text).toBe(invalid);
  });
});
