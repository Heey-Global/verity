import { describe, expect, it, vi } from 'vitest';
import type { GitOutput } from './branches.js';
import type { HttpFetch, HttpResponse } from './github.js';
import { createGitHubTaskService, githubGraphQL } from './github-tasks.js';

const ok = (body: unknown): HttpResponse => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});
const fail = (status: number): HttpResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
});
/** A 200 carrying a GraphQL `data` (and optional partial `errors`). */
const gql = (data: unknown, errors?: unknown): HttpResponse =>
  ok(errors === undefined ? { data } : { data, errors });

/** A fetch fake returning queued responses in order (repeating the last), recording
 *  each call. A queued thunk that throws models a network error. */
function fakeFetch(...responses: (HttpResponse | (() => Promise<HttpResponse>))[]): {
  fetch: HttpFetch;
  calls: { url: string; method?: string; body?: string; headers?: Record<string, string> }[];
} {
  const calls: { url: string; method?: string; body?: string; headers?: Record<string, string> }[] =
    [];
  let i = 0;
  const fetch: HttpFetch = (url, init) => {
    calls.push({
      url,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body ? { body: init.body } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : Promise.resolve(r as HttpResponse);
  };
  return { fetch, calls };
}

const githubRemote: GitOutput = () =>
  Promise.resolve('git@github.com:Example-Org/Example-Repo.git\n');
const gitlabRemote: GitOutput = () => Promise.resolve('git@gitlab.com:o/r.git\n');

/** A board where the project resolved under the ORG branch (user branch errored). */
const orgBoard = (items: unknown[], fields: unknown[] = []): unknown => ({
  organization: {
    projectV2: {
      id: 'PVT_1',
      number: 7,
      title: 'Roadmap',
      fields: { nodes: fields },
      items: { nodes: items },
    },
  },
  user: null,
});

const priorityField = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'FIELD_prio',
  name: 'Priority',
  options: [
    { id: 'OPT_p1', name: 'P1' },
    { id: 'OPT_p2', name: 'P2' },
  ],
};

const issueItem = {
  id: 'PVTI_issue',
  fieldValues: {
    nodes: [
      {
        __typename: 'ProjectV2ItemFieldSingleSelectValue',
        name: 'P1',
        field: { name: 'Priority' },
      },
      { __typename: 'ProjectV2ItemFieldNumberValue', number: 3, field: { name: 'Estimate' } },
      { __typename: 'ProjectV2ItemFieldTextValue', text: 'ignored', field: {} }, // no field name → dropped
    ],
  },
  content: {
    __typename: 'Issue',
    id: 'I_1',
    number: 42,
    title: 'Fix login',
    body: 'body',
    url: 'https://github.com/x/1',
    state: 'OPEN',
  },
};
const draftItem = {
  id: 'PVTI_draft',
  fieldValues: { nodes: [] },
  content: { __typename: 'DraftIssue', id: 'DI_1', title: 'An idea', body: 'notes' },
};

describe('githubGraphQL', () => {
  it('POSTs the query + variables with a bearer header and returns data', async () => {
    const { fetch, calls } = fakeFetch(gql({ hello: 'world' }));
    const res = await githubGraphQL(fetch, 'tok', 'query{x}', { a: 1 }, 5000);
    expect(res).toEqual({ ok: true, status: 200, data: { hello: 'world' } });
    expect(calls[0]?.url).toBe('https://api.github.com/graphql');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ query: 'query{x}', variables: { a: 1 } });
  });

  it('passes partial data + errors through (does not treat errors as fatal)', async () => {
    const { fetch } = fakeFetch(gql({ organization: null }, [{ message: 'not an org' }]));
    const res = await githubGraphQL(fetch, 'tok', 'q', {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ organization: null });
    expect(res.errors).toEqual([{ message: 'not an org' }]);
  });

  it('degrades to ok:false on a non-2xx and on a transport error', async () => {
    expect((await githubGraphQL(fakeFetch(fail(401)).fetch, 't', 'q', {}, 5000)).ok).toBe(false);
    const thrower = fakeFetch(() => Promise.reject(new Error('network')));
    expect((await githubGraphQL(thrower.fetch, 't', 'q', {}, 5000)).ok).toBe(false);
  });
});

describe('createGitHubTaskService.getBoard', () => {
  it('parses the board, its item order and field values (org branch)', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([issueItem, draftItem])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'tok',
      git: githubRemote,
      fetch,
    });
    const board = await svc.getBoard();
    expect(board?.projectId).toBe('PVT_1');
    expect(board?.items.map((i) => i.id)).toEqual(['PVTI_issue', 'PVTI_draft']); // stored order
    const issue = board?.items[0];
    expect(issue).toMatchObject({ type: 'ISSUE', number: 42, contentId: 'I_1', state: 'OPEN' });
    expect(issue?.fields).toEqual([
      { field: 'Priority', value: 'P1' },
      { field: 'Estimate', value: '3' },
    ]);
    expect(board?.items[1]).toMatchObject({
      type: 'DRAFT_ISSUE',
      number: null,
      url: '',
      contentId: 'DI_1',
    });
    // Variables carry the owner from the origin remote + the configured number.
    expect(JSON.parse(calls[0]?.body ?? '{}').variables).toEqual({
      owner: 'Example-Org',
      number: 7,
    });
  });

  it('resolves the project from the user branch when the owner is a user', async () => {
    const userBoard = {
      organization: null,
      user: { projectV2: { id: 'PVT_u', number: 7, title: 'T', items: { nodes: [] } } },
    };
    const { fetch } = fakeFetch(
      gql(userBoard, [{ message: 'Could not resolve to an Organization' }]),
    );
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'tok',
      git: githubRemote,
      fetch,
    });
    expect((await svc.getBoard())?.projectId).toBe('PVT_u');
  });

  it('drops garbled items rather than crashing the board', async () => {
    const { fetch } = fakeFetch(
      gql(orgBoard([issueItem, { id: 'x', content: null }, { nope: true }])),
    );
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'tok',
      git: githubRemote,
      fetch,
    });
    expect((await svc.getBoard())?.items.map((i) => i.id)).toEqual(['PVTI_issue']);
  });

  it('is inert (null, no fetch) without a token or on a non-GitHub origin', async () => {
    const noTok = fakeFetch(gql(orgBoard([])));
    const a = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      git: githubRemote,
      fetch: noTok.fetch,
    });
    expect(await a.getBoard()).toBeNull();
    expect(noTok.calls).toHaveLength(0);

    const gl = fakeFetch(gql(orgBoard([])));
    const b = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'tok',
      git: gitlabRemote,
      fetch: gl.fetch,
    });
    expect(await b.getBoard()).toBeNull();
    expect(gl.calls).toHaveLength(0);
  });

  it('caches within the TTL and serves the last good board through a transient failure', async () => {
    let t = 1000;
    const { fetch, calls } = fakeFetch(
      gql(orgBoard([issueItem])),
      fail(502),
      gql(orgBoard([draftItem])),
    );
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      now: () => t,
    });
    expect((await svc.getBoard())?.items[0]?.id).toBe('PVTI_issue');
    await svc.getBoard(); // within TTL → cache hit, no new call
    expect(calls).toHaveLength(1);
    t += 200; // TTL expired → refetch hits the 502
    expect((await svc.getBoard())?.items[0]?.id).toBe('PVTI_issue'); // last good served
    expect(calls).toHaveLength(2);
    t += 200; // refetch succeeds with the new board
    expect((await svc.getBoard())?.items[0]?.id).toBe('PVTI_draft');
  });
});

describe('createGitHubTaskService token source (least-privilege mint, ADR 0007)', () => {
  it('prefers the dedicated asyncToken over the shared sync token', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'shared-tok',
      asyncToken: () => Promise.resolve('scoped-tok'),
      git: githubRemote,
      fetch,
    });

    await svc.getBoard();
    expect(calls[0]?.headers?.Authorization).toBe('Bearer scoped-tok');
  });

  it('prefers the installation-wide board token for board reads', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const asyncToken = vi.fn(() => Promise.resolve('repo-scoped-tok'));
    const asyncBoardToken = vi.fn(() => Promise.resolve('board-wide-tok'));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'shared-tok',
      asyncToken,
      asyncBoardToken,
      git: githubRemote,
      fetch,
    });

    await svc.getBoard();
    expect(asyncBoardToken).toHaveBeenCalledOnce();
    expect(asyncToken).not.toHaveBeenCalled();
    expect(calls[0]?.headers?.Authorization).toBe('Bearer board-wide-tok');
  });

  it('falls back to the shared sync token when asyncToken yields undefined', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'shared-tok',
      asyncToken: () => Promise.resolve(undefined),
      git: githubRemote,
      fetch,
    });

    await svc.getBoard();
    expect(calls[0]?.headers?.Authorization).toBe('Bearer shared-tok');
  });

  it('is inert (no fetch) when neither token source yields a token', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      asyncToken: () => Promise.resolve(undefined),
      git: githubRemote,
      fetch,
    });

    expect(await svc.getBoard()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('degrades a REJECTING asyncToken to the sync fallback (never throws → no 500)', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      token: 'shared-tok',
      asyncToken: () => Promise.reject(new Error('mint failed: HTTP 422')),
      git: githubRemote,
      fetch,
    });

    // The rejection must not propagate; it falls back to the shared token.
    await expect(svc.getBoard()).resolves.not.toBeNull();
    expect(calls[0]?.headers?.Authorization).toBe('Bearer shared-tok');
  });

  it('returns null (no throw, no fetch) when a rejecting asyncToken has no fallback', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      asyncToken: () => Promise.reject(new Error('mint failed: HTTP 500')),
      git: githubRemote,
      fetch,
    });

    await expect(svc.getBoard()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('createGitHubTaskService writes', () => {
  const base = { repoDir: '/r', projectNumber: 7, token: 'tok', git: githubRemote } as const;

  it('repositoryId resolves the origin repo node id', async () => {
    const { fetch, calls } = fakeFetch(gql({ repository: { id: 'R_1' } }));
    const svc = createGitHubTaskService({ ...base, fetch });
    expect(await svc.repositoryId()).toBe('R_1');
    expect(JSON.parse(calls[0]?.body ?? '{}').variables).toEqual({
      owner: 'Example-Org',
      name: 'Example-Repo',
    });
  });

  it('repositoryIdFor resolves a specific owner/repo node id (repo picker)', async () => {
    const { fetch, calls } = fakeFetch(gql({ repository: { id: 'R_widgets' } }));
    const svc = createGitHubTaskService({ ...base, fetch });
    expect(await svc.repositoryIdFor({ owner: 'acme', repo: 'widgets' })).toBe('R_widgets');
    expect(JSON.parse(calls[0]?.body ?? '{}').variables).toEqual({
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('repositoryIdFor uses a token minted for the chosen repo', async () => {
    const { fetch, calls } = fakeFetch(gql({ repository: { id: 'R_widgets' } }));
    const asyncToken = vi.fn((repo?: { owner: string; repo: string }) =>
      Promise.resolve(repo ? `${repo.owner}/${repo.repo}` : 'missing'),
    );
    const svc = createGitHubTaskService({ ...base, token: undefined, asyncToken, fetch });

    expect(await svc.repositoryIdFor({ owner: 'acme', repo: 'widgets' })).toBe('R_widgets');
    expect(asyncToken).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
    expect(calls[0]?.headers?.Authorization).toBe('Bearer acme/widgets');
  });

  it('createDraft resolves the board then adds the draft item', async () => {
    const draftResp = gql({ addProjectV2DraftIssue: { projectItem: draftItem } });
    const { fetch, calls } = fakeFetch(gql(orgBoard([])), draftResp);
    const svc = createGitHubTaskService({ ...base, fetch });
    const item = await svc.createDraft({ title: 'An idea', body: 'notes' });
    expect(item).toMatchObject({ id: 'PVTI_draft', type: 'DRAFT_ISSUE', title: 'An idea' });
    // second call is the mutation, carrying the resolved projectId + title/body
    expect(JSON.parse(calls[1]?.body ?? '{}').variables).toEqual({
      projectId: 'PVT_1',
      title: 'An idea',
      body: 'notes',
    });
  });

  it('convertDraftToIssue returns the new issue number + url', async () => {
    const resp = gql({
      convertProjectV2DraftIssueItemToIssue: {
        item: { id: 'PVTI_draft', content: { number: 99, url: 'u99' } },
      },
    });
    const { fetch } = fakeFetch(resp);
    const svc = createGitHubTaskService({ ...base, fetch });
    expect(await svc.convertDraftToIssue({ itemId: 'PVTI_draft', repositoryId: 'R_1' })).toEqual({
      itemId: 'PVTI_draft',
      number: 99,
      url: 'u99',
    });
  });

  it('convertDraftToIssue uses the chosen repo token', async () => {
    const { fetch, calls } = fakeFetch(
      gql({
        convertProjectV2DraftIssueItemToIssue: {
          item: { id: 'PVTI_draft', content: { number: 99, url: 'u99' } },
        },
      }),
    );
    const asyncToken = vi.fn((repo?: { owner: string; repo: string }) =>
      Promise.resolve(repo ? `${repo.owner}/${repo.repo}` : 'missing'),
    );
    const svc = createGitHubTaskService({ ...base, token: undefined, asyncToken, fetch });

    await expect(
      svc.convertDraftToIssue({
        itemId: 'PVTI_draft',
        repositoryId: 'R_widgets',
        repo: { owner: 'acme', repo: 'widgets' },
      }),
    ).resolves.toMatchObject({ itemId: 'PVTI_draft', number: 99 });
    expect(asyncToken).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
    expect(calls[0]?.headers?.Authorization).toBe('Bearer acme/widgets');
  });

  it('createIssue creates then adds to the board, returning both node ids', async () => {
    const { fetch, calls } = fakeFetch(
      gql(orgBoard([])), // getBoard
      gql({ createIssue: { issue: { id: 'I_new', number: 100, url: 'u100' } } }),
      gql({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } }),
    );
    const svc = createGitHubTaskService({ ...base, fetch });
    expect(await svc.createIssue({ repositoryId: 'R_1', title: 'New' })).toEqual({
      issueId: 'I_new',
      itemId: 'PVTI_new',
      number: 100,
      url: 'u100',
    });
    expect(JSON.parse(calls[2]?.body ?? '{}').variables).toEqual({
      projectId: 'PVT_1',
      contentId: 'I_new',
    });
  });

  it('createIssue uses the chosen repo token for issue writes and board add', async () => {
    const { fetch, calls } = fakeFetch(
      gql(orgBoard([])), // getBoard
      gql({ createIssue: { issue: { id: 'I_new', number: 100, url: 'u100' } } }),
      gql({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } }),
    );
    const asyncToken = vi.fn((repo?: { owner: string; repo: string }) =>
      Promise.resolve(repo ? `${repo.owner}/${repo.repo}` : 'missing'),
    );
    const svc = createGitHubTaskService({ ...base, token: undefined, asyncToken, fetch });

    expect(
      await svc.createIssue({
        repositoryId: 'R_widgets',
        repo: { owner: 'acme', repo: 'widgets' },
        title: 'New',
      }),
    ).toMatchObject({ issueId: 'I_new', itemId: 'PVTI_new' });
    expect(asyncToken).toHaveBeenNthCalledWith(1, { owner: 'acme', repo: 'widgets' });
    expect(asyncToken).toHaveBeenNthCalledWith(2, { owner: 'Example-Org', repo: 'Example-Repo' });
    expect(calls[0]?.headers?.Authorization).toBe('Bearer Example-Org/Example-Repo');
    expect(calls[1]?.headers?.Authorization).toBe('Bearer acme/widgets');
    expect(calls[2]?.headers?.Authorization).toBe('Bearer acme/widgets');
  });

  it('updateIssue reports success and passes only the given fields', async () => {
    const { fetch, calls } = fakeFetch(gql({ updateIssue: { issue: { id: 'I_1' } } }));
    const svc = createGitHubTaskService({ ...base, fetch });
    expect(await svc.updateIssue({ issueId: 'I_1', state: 'CLOSED' })).toBe(true);
    expect(JSON.parse(calls[0]?.body ?? '{}').variables).toEqual({
      id: 'I_1',
      title: null,
      body: null,
      state: 'CLOSED',
    });
  });

  it('updateIssue uses the installation-wide board token when configured', async () => {
    const { fetch, calls } = fakeFetch(gql({ updateIssue: { issue: { id: 'I_1' } } }));
    const asyncToken = vi.fn(() => Promise.resolve('repo-scoped-tok'));
    const asyncBoardToken = vi.fn(() => Promise.resolve('board-wide-tok'));
    const svc = createGitHubTaskService({
      ...base,
      token: undefined,
      asyncToken,
      asyncBoardToken,
      fetch,
    });

    expect(await svc.updateIssue({ issueId: 'I_1', state: 'CLOSED' })).toBe(true);
    expect(asyncBoardToken).toHaveBeenCalledOnce();
    expect(asyncToken).not.toHaveBeenCalled();
    expect(calls[0]?.headers?.Authorization).toBe('Bearer board-wide-tok');
  });

  it('reorder moves an item after another and treats GraphQL errors as failure', async () => {
    const good = fakeFetch(
      gql(orgBoard([])),
      gql({ updateProjectV2ItemPosition: { clientMutationId: null } }),
    );
    const svc = createGitHubTaskService({ ...base, fetch: good.fetch });
    expect(await svc.reorder({ itemId: 'PVTI_draft', afterId: 'PVTI_issue' })).toBe(true);
    expect(JSON.parse(good.calls[1]?.body ?? '{}').variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'PVTI_draft',
      afterId: 'PVTI_issue',
    });

    const bad = fakeFetch(
      gql(orgBoard([])),
      gql({ updateProjectV2ItemPosition: null }, [{ message: 'nope' }]),
    );
    const svc2 = createGitHubTaskService({ ...base, fetch: bad.fetch });
    expect(await svc2.reorder({ itemId: 'x' })).toBe(false);
  });

  it('removeItem deletes a Projects v2 item from the board', async () => {
    const good = fakeFetch(
      gql(orgBoard([])),
      gql({ deleteProjectV2Item: { deletedItemId: 'PVTI_issue' } }),
    );
    const svc = createGitHubTaskService({ ...base, fetch: good.fetch });
    expect(await svc.removeItem({ itemId: 'PVTI_issue' })).toBe(true);
    expect(JSON.parse(good.calls[1]?.body ?? '{}').variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'PVTI_issue',
    });

    const bad = fakeFetch(gql(orgBoard([])), gql({ deleteProjectV2Item: null }));
    expect(
      await createGitHubTaskService({ ...base, fetch: bad.fetch }).removeItem({
        itemId: 'PVTI_issue',
      }),
    ).toBe(false);
  });

  it('every read + write is inert without a token', async () => {
    const { fetch, calls } = fakeFetch(gql({}));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      git: githubRemote,
      fetch,
    });
    expect(await svc.getBoard()).toBeNull();
    expect(await svc.repositoryId()).toBeNull();
    expect(await svc.createDraft({ title: 't' })).toBeNull();
    expect(await svc.convertDraftToIssue({ itemId: 'i', repositoryId: 'r' })).toBeNull();
    expect(await svc.createIssue({ repositoryId: 'r', title: 't' })).toBeNull();
    expect(await svc.updateIssue({ issueId: 'i' })).toBe(false);
    expect(await svc.reorder({ itemId: 'i' })).toBe(false);
    expect(await svc.removeItem({ itemId: 'i' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('getBoard serves null on a hard failure with no prior cache, and createDraft null when the write returns no item', async () => {
    const base = { repoDir: '/r', projectNumber: 7, token: 'tok', git: githubRemote } as const;
    // Transient failure, cold cache → null (the `cache?.board ?? null` right side).
    expect(
      await createGitHubTaskService({ ...base, fetch: fakeFetch(fail(500)).fetch }).getBoard(),
    ).toBeNull();
    // Board ok, mutation 200 but no projectItem → toTaskItem(undefined) → null.
    const noItem = fakeFetch(gql(orgBoard([])), gql({ addProjectV2DraftIssue: {} }));
    expect(
      await createGitHubTaskService({ ...base, fetch: noItem.fetch }).createDraft({ title: 't' }),
    ).toBeNull();
  });
});

describe('githubGraphQL — response edge branches', () => {
  it('treats a null / non-object JSON body as a failure', async () => {
    expect((await githubGraphQL(fakeFetch(ok(null)).fetch, 't', 'q', {}, 5000)).ok).toBe(false);
    expect((await githubGraphQL(fakeFetch(ok('nope')).fetch, 't', 'q', {}, 5000)).ok).toBe(false);
  });

  it('drops an empty errors array and tolerates a data-less (errors-only) reply', async () => {
    const empty = await githubGraphQL(
      fakeFetch(ok({ data: { x: 1 }, errors: [] })).fetch,
      't',
      'q',
      {},
      5000,
    );
    expect(empty).toEqual({ ok: true, status: 200, data: { x: 1 } });
    const errOnly = await githubGraphQL(
      fakeFetch(ok({ errors: [{ message: 'boom' }] })).fetch,
      't',
      'q',
      {},
      5000,
    );
    expect(errOnly.ok).toBe(true);
    expect(errOnly.data).toBeUndefined();
    expect(errOnly.errors).toEqual([{ message: 'boom' }]);
  });
});

describe('createGitHubTaskService.getBoard — parsing edge branches', () => {
  const base = { repoDir: '/r', projectNumber: 7, token: 'tok', git: githubRemote } as const;

  it('parses date field values and drops null / valueless field-value nodes', async () => {
    const item = {
      id: 'PVTI_x',
      fieldValues: {
        nodes: [
          null, // non-object node → dropped
          { __typename: 'ProjectV2ItemFieldTextValue', text: 'note', field: { name: 'Notes' } },
          { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-07-04', field: { name: 'Due' } },
          { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Empty' } }, // name, no value → dropped
        ],
      },
      content: { __typename: 'DraftIssue', id: 'DI', title: 't', body: '' },
    };
    const { fetch } = fakeFetch(gql(orgBoard([item])));
    const board = await createGitHubTaskService({ ...base, fetch }).getBoard();
    expect(board?.items[0]?.fields).toEqual([
      { field: 'Notes', value: 'note' },
      { field: 'Due', value: '2026-07-04' },
    ]);
  });

  it('drops non-object / id-less / unknown-type / null-content items', async () => {
    const items = [
      null,
      42,
      { content: { __typename: 'Issue', id: 'I' } }, // no id
      { id: 'a', content: { __typename: 'Nope', id: 'x' } }, // unknown typename
      { id: 'b', content: null },
      issueItem, // the only survivor
    ];
    const { fetch } = fakeFetch(gql(orgBoard(items)));
    const board = await createGitHubTaskService({ ...base, fetch }).getBoard();
    expect(board?.items.map((i) => i.id)).toEqual(['PVTI_issue']);
  });

  it('defaults missing content fields and a missing fieldValues list', async () => {
    const bare = { id: 'PVTI_bare', content: { __typename: 'Issue' } };
    const { fetch } = fakeFetch(gql(orgBoard([bare])));
    const board = await createGitHubTaskService({ ...base, fetch }).getBoard();
    expect(board?.items[0]).toEqual({
      id: 'PVTI_bare',
      type: 'ISSUE',
      number: null,
      title: '',
      body: '',
      url: '',
      state: null,
      contentId: null,
      fields: [],
    });
  });

  it('returns null for a null root / missing project / bad id+number, and defaults title + non-array items', async () => {
    const board = (body: unknown) =>
      createGitHubTaskService({ ...base, fetch: fakeFetch(gql(body)).fetch }).getBoard();
    expect(await board(null)).toBeNull(); // root null
    expect(await board({ organization: null, user: null })).toBeNull(); // no project on either probe
    expect(
      await board({ organization: { projectV2: { id: 1, number: 'x' } }, user: null }),
    ).toBeNull(); // bad id/number types
    expect(
      await board({
        organization: { projectV2: { id: 'P', number: 7, items: { nodes: 'nope' } } },
        user: null,
      }),
    ).toMatchObject({ projectId: 'P', number: 7, title: '', items: [] }); // missing title → '', non-array nodes → []
  });
});

describe('createGitHubTaskService — write/lookup edge branches', () => {
  const base = { repoDir: '/r', projectNumber: 7, token: 'tok', git: githubRemote } as const;
  const noProject = { organization: null, user: null };

  it('repositoryId is null when the repo id is absent', async () => {
    const svc = createGitHubTaskService({
      ...base,
      fetch: fakeFetch(gql({ repository: null })).fetch,
    });
    expect(await svc.repositoryId()).toBeNull();
  });

  it('createDraft returns null when the board is unavailable or the write fails', async () => {
    const noBoard = fakeFetch(gql(noProject));
    expect(
      await createGitHubTaskService({ ...base, fetch: noBoard.fetch }).createDraft({ title: 't' }),
    ).toBeNull();
    expect(noBoard.calls).toHaveLength(1); // short-circuits after the board read

    // board resolves, mutation fails (non-2xx) and body is defaulted to '' (omitted).
    const writeFail = fakeFetch(gql(orgBoard([])), fail(500));
    expect(
      await createGitHubTaskService({ ...base, fetch: writeFail.fetch }).createDraft({
        title: 't',
      }),
    ).toBeNull();
  });

  it('convertDraftToIssue returns null on failure and defaults missing content number/url', async () => {
    const fail1 = fakeFetch(gql({ convertProjectV2DraftIssueItemToIssue: { item: { id: null } } }));
    expect(
      await createGitHubTaskService({ ...base, fetch: fail1.fetch }).convertDraftToIssue({
        itemId: 'x',
        repositoryId: 'r',
      }),
    ).toBeNull();

    const ok2 = fakeFetch(
      gql({ convertProjectV2DraftIssueItemToIssue: { item: { id: 'PVTI', content: {} } } }),
    );
    expect(
      await createGitHubTaskService({ ...base, fetch: ok2.fetch }).convertDraftToIssue({
        itemId: 'x',
        repositoryId: 'r',
      }),
    ).toEqual({ itemId: 'PVTI', number: null, url: '' });
  });

  it('createIssue handles a null board, a create failure, and an add-to-board failure', async () => {
    const noBoard = fakeFetch(gql(noProject));
    expect(
      await createGitHubTaskService({ ...base, fetch: noBoard.fetch }).createIssue({
        repositoryId: 'r',
        title: 't',
      }),
    ).toBeNull();

    const createFail = fakeFetch(gql(orgBoard([])), gql({ createIssue: { issue: null } }));
    expect(
      await createGitHubTaskService({ ...base, fetch: createFail.fetch }).createIssue({
        repositoryId: 'r',
        title: 't',
      }),
    ).toBeNull();

    // create succeeds, add-to-board yields no item id → itemId null, other fields defaulted.
    const addFail = fakeFetch(
      gql(orgBoard([])),
      gql({ createIssue: { issue: { id: 'I' } } }),
      gql({ addProjectV2ItemById: { item: {} } }),
    );
    expect(
      await createGitHubTaskService({ ...base, fetch: addFail.fetch }).createIssue({
        repositoryId: 'r',
        title: 't',
        body: 'b',
      }),
    ).toEqual({ issueId: 'I', itemId: null, number: null, url: '' });
  });

  it('updateIssue returns false when the write is not confirmed (passes provided title/body)', async () => {
    const f = fakeFetch(gql({ updateIssue: { issue: null } }));
    expect(
      await createGitHubTaskService({ ...base, fetch: f.fetch }).updateIssue({
        issueId: 'I',
        title: 'x',
        body: 'y',
      }),
    ).toBe(false);
  });

  it('reorder returns false when the board is unavailable', async () => {
    const noBoard = fakeFetch(gql(noProject));
    expect(
      await createGitHubTaskService({ ...base, fetch: noBoard.fetch }).reorder({ itemId: 'x' }),
    ).toBe(false);
  });
});

describe('createGitHubTaskService — fields + setField', () => {
  const base = { repoDir: '/r', projectNumber: 7, token: 'tok', git: githubRemote } as const;

  it('getBoard parses single-select field definitions + options', async () => {
    const titleField = { __typename: 'ProjectV2Field', id: 'FIELD_title', name: 'Title' };
    const { fetch } = fakeFetch(gql(orgBoard([], [priorityField, titleField])));
    const board = await createGitHubTaskService({ ...base, fetch }).getBoard();
    expect(board?.fields).toEqual([
      {
        id: 'FIELD_prio',
        name: 'Priority',
        options: [
          { id: 'OPT_p1', name: 'P1' },
          { id: 'OPT_p2', name: 'P2' },
        ],
      },
      { id: 'FIELD_title', name: 'Title', options: [] },
    ]);
  });

  it('setField resolves field + option by name (case-insensitive) and runs the mutation', async () => {
    const setOk = gql({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_x' } } });
    const f = fakeFetch(gql(orgBoard([], [priorityField])), setOk);
    const svc = createGitHubTaskService({ ...base, fetch: f.fetch });
    expect(await svc.setField({ itemId: 'PVTI_x', field: 'priority', option: 'p1' })).toBe(true);
    expect(JSON.parse(f.calls[1]?.body ?? '{}').variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'PVTI_x',
      fieldId: 'FIELD_prio',
      optionId: 'OPT_p1',
    });
  });

  it('setField returns false for an unknown field or option (no mutation)', async () => {
    const noField = fakeFetch(gql(orgBoard([], [priorityField])));
    expect(
      await createGitHubTaskService({ ...base, fetch: noField.fetch }).setField({
        itemId: 'x',
        field: 'Nope',
        option: 'P1',
      }),
    ).toBe(false);
    expect(noField.calls).toHaveLength(1); // only the board read; no set mutation

    const noOption = fakeFetch(gql(orgBoard([], [priorityField])));
    expect(
      await createGitHubTaskService({ ...base, fetch: noOption.fetch }).setField({
        itemId: 'x',
        field: 'Priority',
        option: 'P9',
      }),
    ).toBe(false);
  });

  it('setField is inert without a token', async () => {
    const { fetch, calls } = fakeFetch(gql(orgBoard([], [priorityField])));
    const svc = createGitHubTaskService({
      repoDir: '/r',
      projectNumber: 7,
      git: githubRemote,
      fetch,
    });
    expect(await svc.setField({ itemId: 'x', field: 'Priority', option: 'P1' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
