import { expect, it } from 'vitest';

import { SessionReducer } from './reducer.js';

it.each(['once', 'session', 'project', 'denied', 'save_failed'] as const)(
  'replays the %s decision as a card and keeps genuine user messages',
  (decision) => {
    const reducer = new SessionReducer();
    const request = {
      id: 'receipt',
      tool: 'verity_http_request',
      input: { url: 'https://example.com', secretAlias: 'TOKEN' },
      secretSource: { project: 'example', config: 'stg' },
    };
    reducer.apply(1, { t: 'prompt', text: 'Check staging' });
    reducer.apply(2, { t: 'permission', riskClass: 'ask', ...request });
    expect(reducer.pendingPermissionIds).toEqual(['receipt']);

    const event = {
      t: 'notice',
      text: 'Secret request answered.',
      secretApproval: { ...request, decision },
    } as const;
    reducer.apply(3, event);
    expect(reducer.pendingPermissionIds).toEqual([]);
    expect(reducer.messages[1]).toMatchObject({ kind: 'agent-event', event });

    if (decision === 'denied') return;
    if (decision === 'save_failed') {
      reducer.apply(4, { t: 'notice', text: 'Approval could not be saved.', role: 'agent' });
      expect(reducer.messages[2]).toMatchObject({
        kind: 'agent-text',
        text: 'Approval could not be saved.',
      });
      return;
    }

    reducer.apply(4, { t: 'status', state: 'completed' });
    reducer.apply(5, {
      t: 'prompt',
      origin: 'secret-approval',
      text: 'Continue approved request',
      initiatedBy: { userId: 'approver' },
    });
    expect(reducer.running).toBe(true);
    expect(reducer.messages.filter((message) => message.kind === 'user-text')).toEqual([
      expect.objectContaining({ text: 'Check staging' }),
    ]);
  },
);

it('hydrates the binding for a pending request replayed from an older server', () => {
  const reducer = new SessionReducer();
  const input = { url: 'https://example.com', secretAlias: 'TOKEN' };
  reducer.apply(1, {
    t: 'permission',
    id: 'receipt',
    tool: 'verity_http_request',
    input,
    riskClass: 'ask',
  });
  const secretSource = { project: 'example', config: 'stg' };
  expect(reducer.pendingPermission?.secretSource).toBeUndefined();
  reducer.restorePendingPermission({
    toolUseId: 'receipt',
    tool: 'verity_http_request',
    input,
    riskClass: 'ask',
    createdAt: 1,
    secretSource,
  });
  expect(reducer.pendingPermission?.secretSource).toEqual(secretSource);
});
