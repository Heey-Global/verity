import { describe, expect, it } from 'vitest';

import { brokeredAuthSentence, brokeredHttpSummary } from './brokeredHttpSummary.js';
import { permissionSummary } from './permissionSummary.js';

describe('permissionSummary', () => {
  it('shows where a brokered request goes, what it sends and how the secret travels', () => {
    const input = {
      method: 'POST',
      url: 'https://api.example.com/v1/things?dry=1',
      secretAlias: 'EXAMPLE_TOKEN',
      auth: { header: 'authorization', scheme: 'Bearer' },
      body: { name: 'thing' },
    };
    const summary = permissionSummary('verity_http_request', input);
    expect(summary.title).toBe('Use secret EXAMPLE_TOKEN?');
    expect(summary.lines).toEqual([
      { kind: 'code', text: 'POST api.example.com/v1/things?dry=1' },
      { kind: 'code', text: JSON.stringify({ name: 'thing' }, null, 2) },
      { kind: 'text', text: brokeredAuthSentence(brokeredHttpSummary(input)!) },
    ]);
  });

  it('spells out bidi controls in a command, so it reads in the order it runs', () => {
    const summary = permissionSummary('verity_secret_run', {
      command: ['echo', 'a‮b'],
      secrets: [{ env: 'TOKEN', secretAlias: 'API_TOKEN' }],
    });
    expect(summary.title).toBe('Run trusted command with API_TOKEN?');
    expect(summary.lines[0]?.text).not.toContain('‮');
    expect(summary.lines[1]?.text).toContain('the complete secret');
  });

  // A summariser that cannot read the input must not produce a confident title:
  // the card falls back to the tool's name and the raw input stays the thing to read.
  it('names the tool and adds no lines when nothing recognises the input', () => {
    expect(permissionSummary('verity_secret_run', { command: 'not a list' })).toEqual({
      title: 'Allow Verity · Secret · Run?',
      lines: [],
    });
    expect(permissionSummary('WebFetch', { url: 'https://x.test' }).lines).toEqual([]);
  });

  it('words planning and linked-session approvals the way the session card did', () => {
    expect(permissionSummary('verity_end_planning', { action: 'discard' }).title).toBe(
      'Leave planning and change files?',
    );
    expect(permissionSummary('verity_end_planning', {}).title).toBe('Implement the plan?');
    const message = { targetSessionId: 's-2', message: 'hi' };
    expect(permissionSummary('verity_send_session_message', message).title).toBe(
      'Send to s-2 and continue the exchange?',
    );
    expect(
      permissionSummary('verity_send_session_message', message, { approvedForDelivery: true })
        .title,
    ).toBe('Retry delivery to s-2?');
  });
});
