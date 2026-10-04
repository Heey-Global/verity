import type { SessionAutomation } from '@verity/mobile';

import {
  automationLastRunText,
  automationNextRunText,
  automationRunTime,
  automationScheduleLabel,
  isSameAutomation,
} from './automationText';

jest.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: true }] }));

const now = new Date(2026, 9, 5, 8, 0);
const base: SessionAutomation = {
  id: 'a1',
  sessionId: 's1',
  name: 'Morning review',
  status: 'enabled',
  schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 },
  prompt: 'Summarize the open pull requests.',
  script: null,
  model: null,
  consecutiveErrorCount: 0,
  lastRunAt: null,
  lastOutcome: null,
  lastDetail: null,
  nextRunAt: new Date(2026, 9, 5, 9, 0).toISOString(),
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

describe('automationScheduleLabel', () => {
  it.each([
    [{ kind: 'daily', hour: 7, minute: 30 }, 'Every day at 07:30'],
    [{ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, 'Every Monday at 09:00'],
    [{ kind: 'interval', everyMinutes: 15 }, 'Every 15 minutes'],
    [{ kind: 'interval', everyMinutes: 60 }, 'Every hour'],
    [{ kind: 'interval', everyMinutes: 180 }, 'Every 3 hours'],
    [{ kind: 'interval', everyMinutes: 1440 }, 'Every day'],
  ] as const)('describes %j as %s', (schedule, label) => {
    expect(automationScheduleLabel(schedule)).toBe(label);
  });
});

describe('automation run sentences', () => {
  it('names nearby days instead of dates', () => {
    expect(automationRunTime(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe('today at 09:00');
    expect(automationRunTime(new Date(2026, 9, 6, 9, 0).toISOString(), now)).toBe(
      'tomorrow at 09:00',
    );
    expect(automationRunTime(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe(
      'Mon 12.10. at 09:00',
    );
  });

  it('explains a pause caused by repeated failures', () => {
    expect(automationNextRunText({ ...base, status: 'paused' }, now)).toBe(
      'Paused. It will not run until you resume it.',
    );
    expect(
      automationNextRunText({ ...base, status: 'paused', consecutiveErrorCount: 5 }, now),
    ).toBe('Paused after several failed runs. Resume it to try again.');
    expect(automationNextRunText(base, now)).toBe('Next run today at 09:00.');
  });

  it('describes the last run without technical outcome names', () => {
    expect(automationLastRunText(base, now)).toBe('Has not run yet.');
    const ranAt = new Date(2026, 9, 4, 9, 0).toISOString();
    expect(automationLastRunText({ ...base, lastRunAt: ranAt, lastOutcome: 'acted' }, now)).toBe(
      'Last ran yesterday at 09:00.',
    );
    expect(
      automationLastRunText(
        {
          ...base,
          lastRunAt: ranAt,
          lastOutcome: 'error',
          lastDetail: 'The check failed with exit code 2.',
        },
        now,
      ),
    ).toBe('Could not run yesterday at 09:00. The check failed with exit code 2.');
  });
});

describe('isSameAutomation', () => {
  const proposal = {
    name: base.name,
    schedule: base.schedule,
    prompt: base.prompt,
  };
  it('matches only an identical configuration', () => {
    expect(isSameAutomation(base, proposal)).toBe(true);
    expect(isSameAutomation(null, proposal)).toBe(false);
    expect(isSameAutomation(base, { ...proposal, script: 'exit 0' })).toBe(false);
    expect(isSameAutomation(base, { ...proposal, model: 'codex/default' })).toBe(false);
    expect(
      isSameAutomation(base, { ...proposal, schedule: { kind: 'daily', hour: 9, minute: 0 } }),
    ).toBe(false);
  });
});
