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

it('preserves a structured submission notice even when its text resembles a legacy approval', () => {
  const reducer = new SessionReducer();
  const id = '12345678-1234-1234-1234-123456789abc';
  reducer.apply(1, { t: 'permission', id, tool: 'verity_secret_run', input: {}, riskClass: 'ask' });
  const event = {
    t: 'notice',
    text: `Secret tool approval ${id} was denied. Nothing was executed by answering the card. Do not retry this operation without a new user instruction.`,
    changeSubmission: { action: 'submitted', userId: 'author' },
  } as const;
  reducer.apply(2, event);
  expect(reducer.pendingPermissionIds).toEqual([id]);
  expect(reducer.messages).toEqual([expect.objectContaining({ kind: 'agent-event', event })]);
});

it('hides legacy broker chatter during replay while retaining errors and turn state', () => {
  const reducer = new SessionReducer();
  const id = '12345678-1234-1234-1234-123456789abc';
  reducer.apply(1, {
    t: 'permission',
    id,
    tool: 'verity_secret_run',
    input: {},
    riskClass: 'ask',
  });
  reducer.apply(2, {
    t: 'notice',
    text: `Secret tool approval ${id} was approved. Nothing was executed by answering the card. If the operation is still needed, retry the exact original tool request; its approval is single-use and valid for five minutes.`,
  });
  expect(reducer.pendingPermissionIds).toEqual([]);
  reducer.apply(3, { t: 'prompt', text: 'Check staging too.' });
  reducer.apply(4, { t: 'prompt', text: `Continue after approval of verity_secret_run (${id}).` });
  expect(reducer.running).toBe(true);
  expect(reducer.messages).toEqual([expect.objectContaining({ text: 'Check staging too.' })]);

  reducer.apply(5, {
    t: 'notice',
    text: 'The requested reusable secret approval could not be saved.',
  });
  reducer.apply(6, { t: 'prompt', text: `Continue after approval of verity_secret_run (${id}).` });
  expect(reducer.messages.map(({ kind }) => kind)).toEqual([
    'user-text',
    'agent-text',
    'user-text',
  ]);
});

it.each([false, true])('preserves unrelated permission after a turn boundary (%s)', (turnEnded) => {
  const reducer = new SessionReducer();
  const id = '12345678-1234-1234-1234-123456789abc';
  reducer.apply(1, { t: 'permission', id, tool: 'Bash', input: {}, riskClass: 'ask' });
  if (turnEnded) reducer.apply(2, { t: 'prompt', text: 'New turn' });
  reducer.apply(3, {
    t: 'notice',
    text: `Secret tool approval ${id} was denied. Nothing was executed by answering the card. Do not retry this operation without a new user instruction.`,
  });
  reducer.reconcilePendingPermissions([id]);
  expect(reducer.pendingPermissionIds).toEqual([id]);
});

it('keeps prompts with the wrong tool or a stale legacy approval ID', () => {
  const reducer = new SessionReducer();
  const id = '12345678-1234-1234-1234-123456789abc';
  reducer.apply(1, { t: 'permission', id, tool: 'verity_secret_run', input: {}, riskClass: 'ask' });
  reducer.apply(2, {
    t: 'notice',
    text: `Secret tool approval ${id} was approved. Nothing was executed by answering the card. The selected session approval was saved; continue only the original authorized action.`,
  });
  reducer.apply(3, {
    t: 'prompt',
    text: `Continue after approval of verity_http_request (${id}).`,
  });
  reducer.apply(
    4,
    { t: 'prompt', text: `Continue after approval of verity_secret_run (${id}).` },
    300_003,
  );
  expect(reducer.messages.map(({ kind }) => kind)).toEqual(['user-text', 'user-text']);
});
