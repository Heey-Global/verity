import { describe, expect, it } from 'vitest';
import { VerityClient } from './api.js';
import { projectInquirySchema, projectRepositorySchema } from './projectCollaboration.js';

describe('project collaboration API', () => {
  it('addresses the target project and request when deciding', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch: async (input, init) => {
        calls.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          ...(init ? { init } : {}),
        });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    // A pending request has no target session yet, so the project is the address.
    await client.decideProjectInquiry('target/project', 'request/id', 'approve_always');
    expect(calls[0]?.url).toBe(
      'http://host/projects/target%2Fproject/project-inquiries/request%2Fid/decision',
    );
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ decision: 'approve_always' }));
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('retains local default workspaces and removed repository history', () => {
    const repo = projectRepositorySchema.parse({
      id: 'r',
      projectId: 'p',
      name: 'Local',
      kind: 'local',
      owner: 'local',
      repo: 'app',
      forgeConnectionId: null,
      defaultBranch: null,
      isDefault: true,
      removedAt: null,
    });
    expect(repo.kind).toBe('local');
    expect(
      projectRepositorySchema.parse({ ...repo, kind: 'github', removedAt: '2026-11-06T00:00:00Z' })
        .removedAt,
    ).not.toBeNull();
  });

  it('rejects unknown approval states instead of displaying them as safe', () => {
    expect(
      projectInquirySchema.safeParse({
        id: 'i',
        sourceSessionId: 's',
        targetSessionId: 't',
        sourceProjectId: 'p',
        targetProjectId: 'q',
        title: 'Change',
        body: 'Scope',
        kind: 'change',
        status: 'silently_allowed',
        createdAt: '2026-11-06',
        answer: null,
      }).success,
    ).toBe(false);
  });
});
