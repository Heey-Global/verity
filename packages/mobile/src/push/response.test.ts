import { describe, expect, it, vi } from 'vitest';
import { VerityApiError } from '../api.js';
import { subscribeSessionStatusMutations } from '../liveStatusMutation.js';
import { subscribeSettledPermissions } from '../permissionSettlement.js';
import { subscribePullRequestStatusMutations } from '../pullRequestStatusMutation.js';
import { PUSH_ACTION } from './categories.js';
import {
  DEFAULT_ACTION_IDENTIFIER,
  createPushReplyPerformer,
  resolvePushResponse,
} from './response.js';

describe('resolvePushResponse', () => {
  const permission = { sessionId: 's1', kind: 'permission', toolUseId: 't1' } as const;

  it('routes a plain tap to open the session (no network)', () => {
    expect(
      resolvePushResponse({ actionIdentifier: DEFAULT_ACTION_IDENTIFIER, payload: permission }),
    ).toEqual({ type: 'open-session', sessionId: 's1' });
  });

  it('maps allow / deny to a permission decision', () => {
    expect(
      resolvePushResponse({ actionIdentifier: PUSH_ACTION.allow, payload: permission }),
    ).toEqual({
      type: 'decide-permission',
      sessionId: 's1',
      toolUseId: 't1',
      decision: { behavior: 'allow' },
    });
    expect(
      resolvePushResponse({ actionIdentifier: PUSH_ACTION.deny, payload: permission }),
    ).toEqual({
      type: 'decide-permission',
      sessionId: 's1',
      toolUseId: 't1',
      decision: { behavior: 'deny' },
    });
  });

  it('refuses an allow/deny on a payload without a toolUseId', () => {
    const bad = { sessionId: 's1', kind: 'completed' } as const;
    expect(resolvePushResponse({ actionIdentifier: PUSH_ACTION.allow, payload: bad })).toBeNull();
  });

  it('maps a non-empty text reply to a turn', () => {
    expect(
      resolvePushResponse({
        actionIdentifier: PUSH_ACTION.reply,
        payload: { sessionId: 's1', kind: 'question' },
        userText: '  ship it  ',
      }),
    ).toEqual({ type: 'send-turn', sessionId: 's1', prompt: 'ship it' });
  });

  it('drops an empty / whitespace-only text reply', () => {
    expect(
      resolvePushResponse({
        actionIdentifier: PUSH_ACTION.reply,
        payload: { sessionId: 's1', kind: 'question' },
        userText: '   ',
      }),
    ).toBeNull();
    expect(
      resolvePushResponse({
        actionIdentifier: PUSH_ACTION.reply,
        payload: { sessionId: 's1', kind: 'question' },
      }),
    ).toBeNull();
  });

  it('returns null for an unknown action', () => {
    expect(
      resolvePushResponse({ actionIdentifier: 'SOMETHING_ELSE', payload: permission }),
    ).toBeNull();
  });

  it('routes PR-ready merge and open actions', () => {
    const payload = {
      sessionId: 's1',
      kind: 'pull_request_ready',
      pullRequestNumber: 831,
    } as const;
    expect(
      resolvePushResponse({ actionIdentifier: PUSH_ACTION.mergePullRequest, payload }),
    ).toEqual({ type: 'merge-pull-request', sessionId: 's1', pullRequestNumber: 831 });
    expect(resolvePushResponse({ actionIdentifier: PUSH_ACTION.openSession, payload })).toEqual({
      type: 'open-session',
      sessionId: 's1',
    });
    expect(
      resolvePushResponse({
        actionIdentifier: PUSH_ACTION.mergePullRequest,
        payload: permission,
      }),
    ).toBeNull();
  });
});

describe('createPushReplyPerformer', () => {
  const permissionAction = {
    type: 'decide-permission',
    sessionId: 's1',
    toolUseId: 't1',
    decision: { behavior: 'allow' },
  } as const;

  it('delivers a permission decision and reports done', async () => {
    const decidePermission = vi.fn().mockResolvedValue({ decided: true });
    const sendTurn = vi.fn();
    const perform = createPushReplyPerformer({
      decidePermission,
      sendTurn,
      mergePullRequest: vi.fn(),
    });
    expect(await perform(permissionAction, 'r1')).toBe('done');
    expect(decidePermission).toHaveBeenCalledWith('s1', 't1', { behavior: 'allow' });
  });

  it('delivers a turn and reports done', async () => {
    const decidePermission = vi.fn();
    const sendTurn = vi.fn().mockResolvedValue({ accepted: true });
    const perform = createPushReplyPerformer({
      decidePermission,
      sendTurn,
      mergePullRequest: vi.fn(),
    });
    expect(await perform({ type: 'send-turn', sessionId: 's1', prompt: 'hi' }, 'reply-9')).toBe(
      'done',
    );
    // The clientReplyId is threaded so the server can dedupe a re-flushed reply.
    expect(sendTurn).toHaveBeenCalledWith('s1', { prompt: 'hi', clientReplyId: 'reply-9' });
  });

  it('treats a 4xx (already resolved) as stale — drop, do not retry', async () => {
    const settled = vi.fn();
    const statusChanged = vi.fn();
    const unsubscribe = subscribeSettledPermissions(settled);
    const unsubscribeStatus = subscribeSessionStatusMutations(statusChanged);
    const decidePermission = vi.fn().mockRejectedValue(new VerityApiError(409, 'already decided'));
    const perform = createPushReplyPerformer({
      decidePermission,
      sendTurn: vi.fn(),
      mergePullRequest: vi.fn(),
    });
    expect(await perform(permissionAction, 'r1')).toBe('stale');
    expect(settled).toHaveBeenCalledWith('s1', 't1');
    expect(statusChanged).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribeStatus();
  });

  it('retries a 5xx, a 429, and a transport error', async () => {
    const perform500 = createPushReplyPerformer({
      decidePermission: vi.fn().mockRejectedValue(new VerityApiError(503, 'down')),
      sendTurn: vi.fn(),
      mergePullRequest: vi.fn(),
    });
    expect(await perform500(permissionAction, 'r1')).toBe('retry');

    const perform429 = createPushReplyPerformer({
      decidePermission: vi.fn().mockRejectedValue(new VerityApiError(429, 'slow down')),
      sendTurn: vi.fn(),
      mergePullRequest: vi.fn(),
    });
    expect(await perform429(permissionAction, 'r1')).toBe('retry');

    const performNet = createPushReplyPerformer({
      decidePermission: vi.fn().mockRejectedValue(new Error('network down')),
      sendTurn: vi.fn(),
      mergePullRequest: vi.fn(),
    });
    expect(await performNet(permissionAction, 'r1')).toBe('retry');
  });

  it('retries an unauthenticated 401/403 (bearer not loaded yet) — never drops it', async () => {
    // The outbox can flush before the bearer is rehydrated on a biometric-unlock
    // launch; dropping the reply here would lose the operator's queued answer.
    for (const status of [401, 403, 408]) {
      const perform = createPushReplyPerformer({
        decidePermission: vi.fn().mockRejectedValue(new VerityApiError(status, 'unauthorized')),
        sendTurn: vi.fn(),
        mergePullRequest: vi.fn(),
      });
      expect(await perform(permissionAction, 'r1')).toBe('retry');
    }
  });

  it('reports open-session as done without touching the network', async () => {
    const decidePermission = vi.fn();
    const sendTurn = vi.fn();
    const mergePullRequest = vi.fn();
    const perform = createPushReplyPerformer({ decidePermission, sendTurn, mergePullRequest });
    expect(await perform({ type: 'open-session', sessionId: 's1' }, 'r1')).toBe('done');
    expect(decidePermission).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('merges a pull request and treats a stale 409 as done-for-outbox', async () => {
    const mutations = vi.fn();
    const unsubscribe = subscribePullRequestStatusMutations(mutations);
    const mergePullRequest = vi.fn().mockResolvedValue({ merged: true });
    const perform = createPushReplyPerformer({
      decidePermission: vi.fn(),
      sendTurn: vi.fn(),
      mergePullRequest,
    });
    const action = { type: 'merge-pull-request', sessionId: 's1', pullRequestNumber: 831 } as const;
    expect(await perform(action, 'r1')).toBe('done');
    expect(mergePullRequest).toHaveBeenCalledWith('s1', 831);

    mergePullRequest.mockRejectedValueOnce(new VerityApiError(409, 'no longer mergeable'));
    expect(await perform(action, 'r2')).toBe('stale');
    expect(mutations).toHaveBeenCalledTimes(2);

    mergePullRequest.mockRejectedValueOnce(new VerityApiError(404, 'not found'));
    expect(await perform(action, 'r3')).toBe('stale');
    expect(mutations).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
