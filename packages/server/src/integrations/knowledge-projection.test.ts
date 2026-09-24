import { expect, it } from 'vitest';
import type { IntegrationEvent } from '@verity/store';
import { renderChatDay } from './knowledge-projection.js';

const message: IntegrationEvent = {
  accountId: '@verity:example.test',
  sourceId: '!room:example.test',
  eventId: '$message',
  targetEventId: null,
  kind: 'message',
  sender: '@person:example.test',
  occurredAt: new Date('2026-09-24T12:00:00.000Z'),
  body: 'First decision',
};

it('projects an edit and then a deletion without retaining the old message in the current source', () => {
  const source = { displayName: 'Project chat', sourceId: message.sourceId };
  const edit: IntegrationEvent = {
    ...message,
    eventId: '$edit',
    targetEventId: message.eventId,
    kind: 'edit',
    occurredAt: new Date('2026-09-25T10:00:00.000Z'),
    body: 'Revised decision',
  };
  const edited = renderChatDay(source, '2026-09-24', [message], [edit]);
  expect(edited).toContain('Revised decision');
  expect(edited).not.toContain('First decision');

  const redacted = renderChatDay(
    source,
    '2026-09-24',
    [message],
    [
      edit,
      {
        ...edit,
        eventId: '$redaction',
        kind: 'redaction',
        body: null,
        occurredAt: new Date('2026-09-26T10:00:00.000Z'),
      },
      {
        ...edit,
        eventId: '$late-edit',
        body: 'Should stay deleted',
        occurredAt: new Date('2026-09-26T11:00:00.000Z'),
      },
    ],
  );
  expect(redacted).toContain('[Message deleted]');
  expect(redacted).not.toContain('Revised decision');
  expect(redacted).not.toContain('First decision');
  expect(redacted).not.toContain('Should stay deleted');
});
