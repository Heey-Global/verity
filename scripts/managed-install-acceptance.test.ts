import { describe, expect, it } from 'vitest';
import {
  assertCompletedTurn,
  createApi,
  readHistory,
  runAcceptance,
} from './managed-install-acceptance.mjs';

const prompt = 'managed-install-before-restart';
const response = `Verity managed install: Grüße — größer 🚀\n${prompt}`;
const event = (seq: number, body: Record<string, unknown>) => ({ seq, event: body });
const completed = [
  event(1, { t: 'prompt', text: prompt }),
  event(2, { t: 'text', delta: response.slice(0, 17) }),
  event(3, { t: 'text', delta: response.slice(17) }),
  event(4, { t: 'result', stopReason: 'end_turn' }),
];

describe('managed first-use acceptance evidence', () => {
  it('requires an intact Unicode response and a successful completed turn', () => {
    expect(() => assertCompletedTurn(completed, prompt)).not.toThrow();
    expect(() => assertCompletedTurn(completed.slice(0, -1), prompt)).toThrow(/not completed/);
    expect(() =>
      assertCompletedTurn(
        [...completed.slice(0, -1), event(4, { t: 'result', stopReason: 'cancelled' })],
        prompt,
      ),
    ).toThrow(/finish normally/);
    expect(() =>
      assertCompletedTurn(
        [
          completed[0],
          event(2, { t: 'text', delta: response.replace('Grüße', 'Gr��e') }),
          completed[3],
        ],
        prompt,
      ),
    ).toThrow(/corrupted/);
  });

  it('cannot reuse a previous response to pass the post-restart turn', () => {
    const after = 'managed-install-after-restart';
    expect(() =>
      assertCompletedTurn(
        [
          ...completed,
          event(5, { t: 'prompt', text: after }),
          event(6, { t: 'result', stopReason: 'end_turn' }),
        ],
        after,
      ),
    ).toThrow(/corrupted/);
    expect(() => assertCompletedTurn(completed, after)).toThrow(/not persisted/);
    expect(() =>
      assertCompletedTurn(
        [...completed, event(5, { t: 'error', message: 'synthetic failure' })],
        prompt,
      ),
    ).toThrow(/reported an error/);
  });

  it('reads backward-paginated persisted history and refuses a stalled cursor', async () => {
    const paths: string[] = [];
    const api = async (path: string) => {
      paths.push(path);
      return {
        status: 200,
        body:
          paths.length === 1
            ? { events: completed.slice(2), hasMore: true }
            : { events: completed.slice(0, 2), hasMore: false },
      };
    };
    expect(await readHistory(api, 'synthetic-token', 'session')).toEqual(completed);
    expect(paths[1]).toContain('beforeSeq=3');
    await expect(
      readHistory(
        async () => ({
          status: 200,
          body: { events: completed, hasMore: true },
        }),
        'synthetic-token',
        'session',
      ),
    ).rejects.toThrow(/did not advance/);
  });

  it('refuses cleartext gateway verification', () => {
    expect(() =>
      createApi({ baseUrl: 'http://localhost:8082', ca: Buffer.from('unused') }),
    ).toThrow(/TLS gateway/);
  });

  it('fails initialization if broker activation fails without disclosing the response', async () => {
    const api = async (path: string) => {
      if (path === '/onboarding/status')
        return { status: 200, body: { sealed: true, masterPasswordSet: false, hasProject: false } };
      if (path === '/secret/status') return { status: 200, body: { status: 'uninitialized' } };
      if (path === '/settings') return { status: 401, body: {} };
      if (path === '/pair/redeem')
        return { status: 200, body: { bootstrapToken: 'synthetic-bootstrap' } };
      if (path === '/secret/init')
        return { status: 503, body: { error: 'sensitive-diagnostic-marker' } };
      throw new Error('unexpected route');
    };
    await expect(
      runAcceptance('initialize', { api, pairingCode: 'synthetic-pairing' }),
    ).rejects.toThrow('POST /secret/init: HTTP 503');
  });

  it('requires a real cold seal and saved session history before accepting reuse', async () => {
    const state = {
      token: 'synthetic-token',
      password: 'synthetic-password',
      sessionId: 'saved-session',
    };
    await expect(
      runAcceptance('verify-restart', {
        state,
        api: async () => ({ status: 200, body: { status: 'unlocked' } }),
      }),
    ).rejects.toThrow(/restart must seal/);
    const api = async (path: string) => {
      if (path === '/secret/status') return { status: 200, body: { status: 'sealed' } };
      if (path === '/secret/unlock')
        return { status: 200, body: { status: 'unlocked', token: 'new-synthetic-token' } };
      if (path === '/settings')
        return { status: 200, body: { settings: { advancedModeEnabled: true } } };
      if (path === '/sessions/saved-session')
        return { status: 200, body: { sessionId: 'saved-session', projectId: 'verity-control' } };
      return { status: 200, body: { events: [], hasMore: false } };
    };
    await expect(runAcceptance('verify-restart', { state, api })).rejects.toThrow(/not persisted/);
  });
});
