import { afterEach, expect, it, vi } from 'vitest';
import {
  createSwitchDiagnosticBudget,
  switchRequestDiagnostic,
} from './switch-request-diagnostic.js';
afterEach(() => vi.restoreAllMocks());
it('admits only bounded tokens for the matching GET route', () => {
  const headers = { 'x-verity-switch-request': 'switch-1', 'x-verity-switch-kind': 'events' };
  expect(
    switchRequestDiagnostic('GET', '/sessions/private/events?cursor=private', headers),
  ).toEqual({ diagnosticRequestId: 'switch-1', kind: 'events' });
  for (const id of ['secret/value', 'a'.repeat(81), ['switch-1'], '', 'switch-1\n']) {
    expect(
      switchRequestDiagnostic('GET', '/sessions/private/events', {
        ...headers,
        'x-verity-switch-request': id,
      }),
    ).toBeUndefined();
  }
  expect(switchRequestDiagnostic('POST', '/sessions/private/events', headers)).toBeUndefined();
  expect(switchRequestDiagnostic('GET', '/projects/private', headers)).toBeUndefined();
  expect(switchRequestDiagnostic('GET', '/sessions/private', headers)).toBeUndefined();
});
it('bounds volume and resets the budget after a minute', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const admit = createSwitchDiagnosticBudget();
  for (let i = 0; i < 120; i++) expect(admit()).toBe(true);
  expect(admit()).toBe(false);
  clock.mockReturnValue(60_000);
  expect(admit()).toBe(true);
});
