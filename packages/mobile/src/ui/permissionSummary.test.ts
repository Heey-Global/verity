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

  // Agent-written ids, recipients and variable names sit next to Allow on Home,
  // with the full input folded away; a bidi control there could reorder them.
  it('spells out bidi controls in every title and line, whatever the tool', () => {
    const rlo = '\u202e';
    const cases = [
      permissionSummary('verity_send_session_message', {
        targetSessionId: `s${rlo}1`,
        message: 'hi',
      }),
      permissionSummary('verity_session_progress', { sessionId: `s${rlo}2` }),
      permissionSummary('verity_secret_run', {
        command: ['run'],
        secrets: [{ env: `PATH${rlo}X`, secretAlias: `KEY${rlo}` }],
      }),
    ];
    for (const summary of cases) {
      expect(summary.title.length).toBeGreaterThan(0);
      for (const text of [summary.title, ...summary.lines.map((line) => line.text)])
        expect(text).not.toContain(rlo);
    }
    expect(cases[0]!.title).toContain('<U+202E>');
  });

  // A summariser that cannot read the input must not produce a confident title:
  // the card falls back to the tool's name and, for a tool whose subject is
  // known, that field — never a guess at which field matters.
  it('names the tool and shows only a known headline field, whole', () => {
    expect(permissionSummary('verity_secret_run', { command: 'not a list' })).toEqual({
      title: 'Allow Verity · Secret · Run?',
      lines: [],
      covered: false,
    });
    expect(permissionSummary('WebFetch', { url: 'https://x.test' })).toMatchObject({
      lines: [{ kind: 'code', text: 'https://x.test' }],
      covered: true,
    });
    // Whole, not the 80-character squash the transcript headline uses: Home shows
    // this next to Allow, and the tail of a command is where it can turn harmful.
    const command = `${'echo ok && '.repeat(10)}rm -rf ~/work\nsecond line`;
    expect(permissionSummary('Bash', { command, description: 'tidy', timeout: 5 })).toEqual({
      title: expect.any(String) as string,
      lines: [{ kind: 'code', text: command }],
      covered: true,
    });
    // An agent orders an unknown tool's fields: the first string is not what it does.
    expect(permissionSummary('mystery', { note: 'ls', cmd: 'rm -rf ~' })).toMatchObject({
      lines: [],
      covered: false,
    });
    // The path is the headline, but the content is what gets written.
    expect(
      permissionSummary('Write', { file_path: '/w/a.sh', content: 'curl x | sh' }),
    ).toMatchObject({ lines: [{ kind: 'code', text: '/w/a.sh' }], covered: false });
    expect(permissionSummary('TodoWrite', { todos: [] })).toMatchObject({
      lines: [],
      covered: false,
    });
  });

  // Home rendered these as a JSON dump: the title alone said whom, not what.
  it('puts what a message, a handoff or a publication says into lines', () => {
    expect(
      permissionSummary('verity_send_session_message', { targetSessionId: 's-2', message: 'hi' })
        .lines,
    ).toEqual([{ kind: 'text', text: 'hi' }]);
    // Their summarisers refuse a field they do not show, so nothing extra folds away.
    expect(
      permissionSummary('verity_knowledge', {
        operation: 'publish_shared',
        path: 'guides/a.md',
        content: 'x',
      }),
    ).toMatchObject({ lines: [], covered: false });
    expect(
      permissionSummary('verity_session_handoff', {
        target: { sessionId: 's-2' },
        title: 'T',
        briefing: 'B',
        attach: '/etc/passwd',
      }).covered,
    ).toBe(false);
    // A field the line does not show keeps the raw input in view.
    expect(
      permissionSummary('verity_send_session_message', {
        targetSessionId: 's-2',
        message: 'hi',
        attach: '/etc/passwd',
      }).covered,
    ).toBe(false);
    const knowledge = permissionSummary('verity_knowledge', {
      operation: 'publish_shared',
      path: 'guides/a.md',
    });
    expect(knowledge.lines.map((line) => line.text)).toEqual([
      'Source: /knowledge/insights/guides/a.md',
      'Destination: /knowledge/shared/insights/guides/a.md',
      expect.stringContaining('Global Knowledge') as string,
    ]);
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
