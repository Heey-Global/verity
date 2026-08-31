import { describe, expect, it } from 'vitest';
import type { SequencedEvent } from '@verity/store';

import {
  currentPublishedProgress,
  olderEventsMayMatchWindow,
  redactSessionObservationText,
  safeRecentMessages,
  safeSessionProgressErrorKind,
} from './session-observation.js';

describe('safe session observation', () => {
  it('exposes only bounded structured error kinds in transcript-free progress', () => {
    expect(safeSessionProgressErrorKind('run_failed')).toBe('run_failed');
    expect(safeSessionProgressErrorKind('failure contained raw secret text')).toBe('unknown');
    expect(safeSessionProgressErrorKind('x'.repeat(65))).toBe('unknown');
  });

  it('returns only prompt, top-level assistant and error text without attachments or tools', () => {
    const events = [
      {
        seq: 1,
        ts: 10,
        event: {
          t: 'prompt',
          text: 'Please investigate',
          attachments: [{ kind: 'image', mediaType: 'image/png', data: 'secret-bytes' }],
        },
      },
      {
        seq: 2,
        ts: 11,
        event: { t: 'tool_call', id: 'x', name: 'Bash', input: { token: 'hidden' } },
      },
      { seq: 3, ts: 12, event: { t: 'text', delta: 'Working ' } },
      { seq: 4, ts: 13, event: { t: 'text', delta: 'now.' } },
      { seq: 5, ts: 14, event: { t: 'text', delta: 'tool output', parentToolId: 'x' } },
      {
        seq: 6,
        ts: 15,
        event: { t: 'error', message: 'failed with ghp_abcdefghijklmnopqrstuvwxyz' },
      },
    ] as unknown as SequencedEvent[];
    expect(safeRecentMessages(events, 20)).toEqual({
      messages: [
        { role: 'user', text: 'Please investigate', timestamp: 10 },
        { role: 'assistant', text: 'Working now.', timestamp: 13 },
        { role: 'system-error', text: 'failed with [REDACTED CREDENTIAL]', timestamp: 15 },
      ],
      hasMore: false,
    });
  });

  it('returns a cursor that can reach messages older than the current page', () => {
    const events = [
      { seq: 1, ts: 10, event: { t: 'prompt', text: 'first' } },
      { seq: 2, ts: 20, event: { t: 'prompt', text: 'second' } },
      { seq: 3, ts: 30, event: { t: 'prompt', text: 'third' } },
    ] as unknown as SequencedEvent[];
    expect(safeRecentMessages(events, 2)).toEqual({
      messages: [
        { role: 'user', text: 'second', timestamp: 20 },
        { role: 'user', text: 'third', timestamp: 30 },
      ],
      hasMore: true,
      nextBeforeSeq: 2,
    });
    expect(
      safeRecentMessages(
        events.filter((event) => event.seq < 2),
        2,
      ),
    ).toEqual({
      messages: [{ role: 'user', text: 'first', timestamp: 10 }],
      hasMore: false,
    });
  });

  it('keeps pagination available at an inclusive time-window boundary', () => {
    expect(olderEventsMayMatchWindow(true, 1_000, 1_000)).toBe(true);
    expect(olderEventsMayMatchWindow(true, 999, 1_000)).toBe(false);
  });

  it('drops assistant fragments that cross an event-page boundary', () => {
    const fragment = [
      { seq: 10, ts: 10, event: { t: 'text', delta: 'credential-tail' } },
      { seq: 11, ts: 11, event: { t: 'result', stopReason: 'end_turn', usage: {} } },
    ] as unknown as SequencedEvent[];
    expect(safeRecentMessages(fragment, 20, undefined, { olderEventsExist: true })).toEqual({
      messages: [],
      hasMore: false,
    });
    expect(
      safeRecentMessages(
        [
          { seq: 1, ts: 1, event: { t: 'prompt', text: 'task' } },
          { seq: 2, ts: 2, event: { t: 'text', delta: 'credential-head' } },
          { seq: 3, ts: 3, event: { t: 'tool_call', id: 'tool', name: 'Bash', input: {} } },
        ] as unknown as SequencedEvent[],
        20,
        undefined,
        { newerEventsExist: true },
      ),
    ).toEqual({
      messages: [
        { role: 'user', text: 'task', timestamp: 1 },
        {
          role: 'assistant',
          text: '[assistant message omitted: crosses approved page boundary]',
          timestamp: 2,
        },
      ],
      hasMore: false,
    });
  });

  it('drops an assistant fragment that crosses the approved time boundary', () => {
    expect(
      safeRecentMessages(
        [
          { seq: 1, ts: 999, event: { t: 'text', delta: 'secret-head' } },
          { seq: 2, ts: 1_000, event: { t: 'text', delta: 'secret-tail' } },
        ] as unknown as SequencedEvent[],
        20,
        1_000,
      ),
    ).toEqual({ messages: [], hasMore: false });
  });

  it('keeps separate turns separate and retains the recent tail of long answers', () => {
    const messages = safeRecentMessages(
      [
        { seq: 1, ts: 1, event: { t: 'prompt', text: 'first task' } },
        { seq: 2, ts: 2, event: { t: 'text', delta: 'first answer' } },
        { seq: 3, ts: 3, event: { t: 'result', stopReason: 'end_turn', usage: {} } },
        { seq: 4, ts: 4, event: { t: 'prompt', text: 'second task' } },
        { seq: 5, ts: 5, event: { t: 'text', delta: `${'old '.repeat(5_000)}recent tail` } },
      ] as unknown as SequencedEvent[],
      20,
    ).messages;
    expect(messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]?.text).toBe('first answer');
    expect(messages[3]?.text).toBe('[assistant message omitted: exceeds safe observation bound]');
    expect(messages[3]?.timestamp).toBe(5);
  });

  it('redacts a credential split across streaming deltas after assembly', () => {
    expect(
      safeRecentMessages(
        [
          { seq: 1, ts: 1, event: { t: 'prompt', text: 'task' } },
          { seq: 2, ts: 2, event: { t: 'text', delta: 'ghp_abcdefgh' } },
          { seq: 3, ts: 3, event: { t: 'text', delta: 'ijklmnop' } },
        ] as unknown as SequencedEvent[],
        20,
      ).messages,
    ).toEqual([
      { role: 'user', text: 'task', timestamp: 1 },
      { role: 'assistant', text: '[REDACTED CREDENTIAL]', timestamp: 3 },
    ]);
  });

  it('keeps a complete first assistant response when its prompt is on the page', () => {
    expect(
      safeRecentMessages(
        [
          { seq: 100, ts: 1, event: { t: 'prompt', text: 'task' } },
          { seq: 101, ts: 2, event: { t: 'text', delta: 'complete answer' } },
          { seq: 102, ts: 3, event: { t: 'result', stopReason: 'end_turn', usage: {} } },
        ] as unknown as SequencedEvent[],
        20,
        undefined,
        { olderEventsExist: true, newerEventsExist: true },
      ).messages,
    ).toEqual([
      { role: 'user', text: 'task', timestamp: 1 },
      { role: 'assistant', text: 'complete answer', timestamp: 2 },
    ]);
  });

  it('invalidates a published outcome when a newer standalone turn starts', () => {
    const progress = {
      seq: 2,
      ts: 20,
      event: { t: 'session_progress', summary: 'done', outcomeDelivered: true },
    } as unknown as SequencedEvent;
    expect(
      currentPublishedProgress([
        { seq: 1, ts: 10, event: { t: 'prompt', text: 'task' } },
        progress,
      ]),
    ).toBe(progress);
    expect(
      currentPublishedProgress([
        progress,
        { seq: 3, ts: 30, event: { t: 'prompt', text: 'new task' } },
      ]),
    ).toBeUndefined();
    expect(
      currentPublishedProgress([
        progress,
        {
          seq: 3,
          ts: 30,
          event: { t: 'prompt', text: 'steer', steered: true },
        },
      ]),
    ).toBe(progress);
  });

  it('caps each message and redacts complete credential-bearing lines', () => {
    const privateKeyEnvelope = (words: string[]) => {
      const label = words.join(' ');
      const fence = '-'.repeat(5);
      return `${fence}BEGIN ${label}${fence}\nsecret\n${fence}END ${label}${fence}`;
    };
    const jwtFixture = [
      Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: '1234567890' })).toString('base64url'),
      `signature${String(123)}`,
    ].join('.');
    expect(
      redactSessionObservationText(
        [
          'Authorization: Bearer secret-token',
          'Proxy-Authorization: Basic dXNlcjpwYXNz',
          'Cookie: session=secret; refresh=also-secret',
          'Set-Cookie: session=secret; HttpOnly; Secure',
          'SERVICE_API_KEY="secret value"',
          'safe line',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Authorization: [REDACTED]',
        'Proxy-Authorization: [REDACTED]',
        'Cookie: [REDACTED]',
        'Set-Cookie: [REDACTED]',
        'SERVICE_API_KEY=[REDACTED]',
        'safe line',
      ].join('\n'),
    );
    expect(redactSessionObservationText(privateKeyEnvelope(['OPENSSH', 'PRIVATE', 'KEY']))).toBe(
      '[REDACTED PRIVATE KEY]',
    );
    expect(
      redactSessionObservationText(privateKeyEnvelope(['ENCRYPTED', 'PRIVATE', 'KEY', 'BLOCK'])),
    ).toBe('[REDACTED PRIVATE KEY]');
    expect(
      redactSessionObservationText(
        [
          `AWS ${'AK'}IAIOSFODNN7EXAMPLE`,
          `JWT ${jwtFixture}`,
          'postgres://alice:database-password@example.test/app',
          'password: unprefixed prose value',
          'my password is hunter2',
          'opaque abcdefghijklmnopqrstuvwxyz1234567890ABCD',
        ].join('\n'),
      ),
    ).toBe(
      [
        'AWS [REDACTED AWS ACCESS KEY]',
        'JWT [REDACTED JWT]',
        'postgres://[REDACTED]@example.test/app',
        'password: [REDACTED]',
        'my password: [REDACTED]',
        'opaque [REDACTED OPAQUE TOKEN]',
      ].join('\n'),
    );
    expect(redactSessionObservationText('x'.repeat(5_000))).toHaveLength(4_000);
    expect(redactSessionObservationText('x'.repeat(16_001))).toBe(
      '[message omitted: exceeds safe observation bound]',
    );
  });
});
