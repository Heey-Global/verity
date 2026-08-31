import { describe, expect, it } from 'vitest';

import {
  RECENT_SESSION_MESSAGES_DEFAULT,
  RECENT_SESSION_MESSAGES_MAX,
  publishSessionProgressRequestSchema,
  recentSessionMessagesRequestSchema,
  sessionProgressRequestSchema,
} from './session-observation-tool.js';

describe('session observation tool schemas', () => {
  it('requires one exact progress target', () => {
    expect(sessionProgressRequestSchema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
    expect(() => sessionProgressRequestSchema.parse({ project: 'acme/repo' })).toThrow();
  });

  it('bounds every recent-message approval window', () => {
    expect(
      recentSessionMessagesRequestSchema.parse({ sessionId: 'session-1', purpose: 'Diagnose CI' }),
    ).toEqual({ sessionId: 'session-1', purpose: 'Diagnose CI' });
    expect(RECENT_SESSION_MESSAGES_DEFAULT).toBe(20);
    expect(RECENT_SESSION_MESSAGES_MAX).toBe(50);
    expect(() =>
      recentSessionMessagesRequestSchema.parse({
        sessionId: 'session-1',
        purpose: 'Diagnose CI',
        count: 51,
      }),
    ).toThrow();
    expect(
      recentSessionMessagesRequestSchema.parse({
        sessionId: 'session-1',
        purpose: 'Read the next approved page',
        beforeSeq: 123,
      }),
    ).toMatchObject({ beforeSeq: 123 });
  });

  it('makes outcome delivery explicit in bounded published progress', () => {
    expect(
      publishSessionProgressRequestSchema.parse({
        summary: 'Tests are green.',
        outcomeDelivered: true,
      }),
    ).toEqual({ summary: 'Tests are green.', outcomeDelivered: true });
    expect(() => publishSessionProgressRequestSchema.parse({ summary: 'Still working' })).toThrow();
  });
});
