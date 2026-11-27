import { describe, expect, it } from 'vitest';
import { SessionReducer } from './reducer.js';

// Several prompts can wait at once: parallel tool calls, sub-agents, and gateway
// prompts (a secret run) that outlive their turn on the server.
describe('SessionReducer — several pending permissions', () => {
  it('keeps an older prompt when a second one arrives, and shows it once the first is answered', () => {
    // Two secret runs waited at once. The newer card replaced the older one, so
    // after the operator answered it the session showed nothing while Home still
    // listed the older prompt as open.
    const r = new SessionReducer();
    r.apply(1, { t: 'status', state: 'awaiting_input' });
    r.apply(2, {
      t: 'permission',
      id: 'first',
      tool: 'verity_secret_run',
      input: {},
      riskClass: 'ask',
    });
    r.apply(3, {
      t: 'permission',
      id: 'second',
      tool: 'verity_secret_run',
      input: {},
      riskClass: 'ask',
    });
    expect(r.pendingPermission?.toolUseId).toBe('first');
    r.resolvePermission('first');
    expect(r.pendingPermission?.toolUseId).toBe('second');
    // Still paused on the second prompt.
    expect(r.status).toBe('awaiting_input');
    r.resolvePermission('second');
    expect(r.pendingPermission).toBeUndefined();
    expect(r.status).toBe('running');
  });

  it('brings back a prompt a turn end dropped while the server still lists it', () => {
    // A gateway prompt (a secret run) outlives the turn on the server.
    const r = new SessionReducer();
    r.apply(1, {
      t: 'permission',
      id: 'gateway',
      tool: 'verity_secret_run',
      input: {},
      riskClass: 'ask',
    });
    r.apply(2, {
      t: 'result',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    expect(r.pendingPermission).toBeUndefined();
    r.reconcilePendingPermissions(['gateway']);
    expect(r.pendingPermission?.toolUseId).toBe('gateway');
    // Its result settles it for good; the live set cannot revive it afterwards.
    r.apply(3, { t: 'tool_result', id: 'gateway', output: 'ok', isError: false });
    expect(r.pendingPermission).toBeUndefined();
    r.reconcilePendingPermissions(['gateway']);
    expect(r.pendingPermission).toBeUndefined();
  });

  it('puts a revived gateway prompt ahead of one the next turn raised', () => {
    const r = new SessionReducer();
    r.apply(
      1,
      { t: 'permission', id: 'gateway', tool: 'verity_secret_run', input: {}, riskClass: 'ask' },
      100,
    );
    r.apply(2, { t: 'prompt', text: 'next' }, 200);
    r.apply(3, { t: 'permission', id: 'newer', tool: 'Bash', input: {}, riskClass: 'ask' }, 300);
    r.reconcilePendingPermissions(['gateway', 'newer'], undefined, 3);
    expect(r.pendingPermissionIds).toEqual(['gateway', 'newer']);
  });

  it('forgets a dropped prompt once a later live set no longer lists it', () => {
    const r = new SessionReducer();
    r.apply(1, { t: 'permission', id: 'gone', tool: 'Bash', input: {}, riskClass: 'ask' });
    r.apply(2, { t: 'prompt', text: 'next' });
    r.reconcilePendingPermissions([], undefined, 2);
    // A stale snapshot listing it again cannot bring it back once forgotten.
    r.reconcilePendingPermissions(['gone'], undefined, 2);
    expect(r.pendingPermission).toBeUndefined();
  });
});
