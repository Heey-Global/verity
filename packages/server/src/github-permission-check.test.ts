import { describe, expect, it } from 'vitest';
import { checkCommitStatusPermission } from './github-permission-check.js';
import type { HttpFetch, HttpResponse } from './github.js';

describe('commit-status permission diagnosis', () => {
  const run = (app: unknown, installation: unknown, status = 200) => {
    let calls = 0;
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: status === 200,
        status,
        json: async () => (++calls === 1 ? app : installation),
      } as HttpResponse);
    return checkCommitStatusPermission(fetch, 'https://api.github.com', 'secret', '123', 1000);
  };
  it('identifies missing App permission and the organization settings page', async () => {
    expect(
      await run(
        { permissions: {}, slug: 'verity', owner: { type: 'Organization', login: 'acme' } },
        { permissions: {} },
      ),
    ).toEqual({
      state: 'app_update_required',
      url: 'https://github.com/organizations/acme/settings/apps/verity/permissions',
    });
  });
  it('links a pending approval to the installation settings', async () => {
    expect(
      await run(
        { permissions: { statuses: 'read' } },
        { permissions: {}, html_url: 'https://github.com/settings/installations/123' },
      ),
    ).toEqual({
      state: 'approval_required',
      url: 'https://github.com/settings/installations/123',
    });
  });
  it.each(['read', 'write'])('accepts installation %s access', async (statuses) => {
    expect(await run({ permissions: { statuses } }, { permissions: { statuses } })).toEqual({
      state: 'ready',
    });
  });
  it('does not infer missing grants from a generic 403', async () => {
    expect(await run({}, {}, 403)).toEqual({ state: 'unknown' });
  });
  it('handles malformed metadata and network failure without leaking credentials', async () => {
    expect(await run({}, {})).toEqual({ state: 'unknown' });
    expect(
      await checkCommitStatusPermission(
        async () => {
          throw new Error('secret');
        },
        'https://api.github.com',
        'secret',
        '123',
        1000,
      ),
    ).toEqual({ state: 'unknown' });
  });
  it('does not expose an untrusted browser destination', async () => {
    expect(
      await run(
        { permissions: { statuses: 'read' } },
        { permissions: {}, html_url: 'https://evil.example/settings/installations/123' },
      ),
    ).toEqual({ state: 'approval_required' });
  });
});
