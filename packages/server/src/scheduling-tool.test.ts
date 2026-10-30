import { describe, expect, it, vi } from 'vitest';
import type { SchedulingRequest } from '@verity/store';
import type { SchedulingService } from './scheduling-service.js';
import { createSchedulingTool, schedulingHasStandingAuthorization } from './scheduling-tool.js';

const SCOPES = [
  'calendar.calendarlist.readonly',
  'calendar.events',
  'gmail.readonly',
  'gmail.compose',
  'gmail.settings.basic',
].map((scope) => `https://www.googleapis.com/auth/${scope}`);

function tool(stored: Partial<SchedulingRequest> | undefined) {
  const send = vi.fn();
  const created = createSchedulingTool({
    store: {
      getSession: async () => ({ projectId: 'p' }) as never,
      getGoogleServiceCredentials: async () =>
        ({ accountId: 'a', accountEmail: 'me@example.test', scopes: SCOPES }) as never,
      scheduling: {
        get: async () =>
          stored
            ? ({ sessionId: 's1', state: 'draft', ...stored } as SchedulingRequest)
            : undefined,
      } as never,
    },
    service: () => ({ send }) as unknown as SchedulingService,
  });
  return { created, send };
}

const send = {
  action: 'send',
  requestId: '00000000-0000-4000-8000-000000000001',
  digest: 'a'.repeat(64),
};

describe('scheduling tool', () => {
  it('needs a card for sending and withdrawing, not for preparing or reading', () => {
    expect(schedulingHasStandingAuthorization(send)).toBe(false);
    expect(
      schedulingHasStandingAuthorization({ action: 'revoke', requestId: send.requestId }),
    ).toBe(false);
    expect(schedulingHasStandingAuthorization({ action: 'list' })).toBe(true);
    expect(
      schedulingHasStandingAuthorization({ action: 'status', requestId: send.requestId }),
    ).toBe(true);
  });

  it('refuses before any card when the request is not this session’s draft', async () => {
    const input = { projectId: 'p', sessionId: 's1', request: send };
    await expect(tool(undefined).created.authorize(input)).rejects.toThrow('not found');
    await expect(tool({ sessionId: 'other' }).created.authorize(input)).rejects.toThrow(
      'not found',
    );
    await expect(tool({ state: 'open' }).created.authorize(input)).rejects.toThrow('already open');
    await expect(tool({}).created.authorize(input)).resolves.toMatchObject({ action: 'send' });
  });

  it('rejects arguments the schema does not know, so an agent cannot inject card content', () => {
    const { created } = tool({});
    return expect(
      created.authorize({ projectId: 'p', sessionId: 's1', request: { ...send, scheduling: {} } }),
    ).rejects.toThrow();
  });
});
