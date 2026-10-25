import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { EventStore, LiveMeetingSyncRecord } from '@verity/store';
import { attendeeResearchHints } from './attendee-research.js';

it('persists addressed requests as hints for the existing Research action', async () => {
  const addInsight = vi.fn().mockResolvedValue(true);
  const callback = attendeeResearchHints({
    store: { liveMeetings: { addInsight } } as unknown as EventStore,
    classify: vi.fn().mockResolvedValue([{ kind: 'research', request: 'check the deadline' }]),
  });
  await callback(
    { id: 'meeting', sessionId: 'session', transcript: 'context' } as LiveMeetingSyncRecord,
    'Verity, check the deadline',
    'request',
  );
  expect(addInsight).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({
      id: 'request-0',
      meetingId: 'meeting',
      kind: 'research',
      summary: 'check the deadline',
      evidenceA: 'Verity, check the deadline',
    }),
  );
});

it('binds audio to the hint writer instead of silently restoring automatic agent turns', () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const attendeeMeetings = new AttendeeMeetings(');
  const end = source.indexOf('registerAttendeeRoutes(', start);
  const binding = source.slice(start, end);
  expect(start).toBeGreaterThan(-1);
  expect(binding).toContain('spoken: attendeeResearchHints(');
  expect(binding).not.toMatch(/conductor\.(?:sendTurn|dispatchTurn|dispatchTurnWhenIdle)/u);
});

it('reuses a classified question identity for an addressed online-meeting hint', async () => {
  const addInsight = vi.fn().mockResolvedValue(true);
  const classify = vi
    .fn()
    .mockResolvedValue([
      { kind: 'research', request: 'check its price', questionId: 'question-price' },
    ]);
  const callback = attendeeResearchHints({
    store: { liveMeetings: { addInsight } } as unknown as EventStore,
    classify,
  });
  await callback(
    { id: 'meeting', sessionId: 'session', transcript: 'context' } as LiveMeetingSyncRecord,
    'Verity, check its price',
    'request',
  );
  expect(classify).toHaveBeenCalledWith('session', 'Verity, check its price', 'context', 'meeting');
  expect(addInsight).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ id: 'question-price', meetingId: 'meeting' }),
  );
});
