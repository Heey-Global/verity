import { parse } from 'graphql';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubForgeAdapter,
  type ForgeAction,
  type ForgeRequest,
} from './brokered-forge-github.js';

const binding = { projectId: 'p', containerGeneration: 'g', owner: 'acme', repo: 'app' };
const actions = new Set<ForgeAction>([
  'git-read',
  'git-write',
  'issues-read',
  'issues-write',
  'pulls-read',
  'pulls-write',
]);
function graph(query: string, variables: Record<string, unknown> = {}): ForgeRequest {
  return {
    hostname: 'api.github.com',
    method: 'POST',
    path: '/graphql',
    body: Buffer.from(JSON.stringify({ query, variables })),
  };
}
function harness(repo = 'acme/app', type = 'Issue') {
  const mint = vi.fn(async () => 'server-token');
  const transport = vi.fn<BrokeredHttpStreamTransport>(
    async () =>
      Object.assign(
        Readable.from([
          JSON.stringify({
            data: {
              node: { __typename: type, nameWithOwner: repo, repository: { nameWithOwner: repo } },
            },
          }),
        ]),
        { statusCode: 200, headers: {} },
      ) as IncomingMessage,
  );
  return { adapter: createGitHubForgeAdapter({ mint, transport }), mint, transport };
}

describe('GitHub forge policy', () => {
  it.each<ForgeRequest>([
    { hostname: 'example.com', method: 'GET', path: '/repos/acme/app/issues' },
    { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/other/issues' },
    { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/app/actions/secrets' },
    { hostname: 'github.com', method: 'GET', path: '/acme/app.git/info/refs?service=git-archive' },
    {
      hostname: 'github.com',
      method: 'GET',
      path: '/acme/other.git/info/refs?service=git-upload-pack',
    },
    { hostname: 'api.github.com', method: 'GET', path: '//example.com/repos/acme/app/issues' },
    { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/app/%2e%2e/other/issues' },
    graph('query{repository(owner:"acme",name:"other"){id}}'),
    graph('query{repository(owner:"acme",name:"app"){actions{secrets}}}'),
    graph('query{repository(owner:"acme",name:"app"){parent{issues(first:1){nodes{id}}}}}'),
    graph('query{__schema{types{name}}}'),
    graph('query{__type(name:"User"){fields{name}}}'),
    graph('query{__type(name:"PullRequest"){kind}}'),
    graph('query{node(id:"foreign"){... on User{email}}}'),
    graph('query{search(query:"repo:acme/app",type:ISSUE){issueCount}}'),
    graph(
      'query{repository(owner:"acme",name:"app"){id}} query Other{repository(owner:"acme",name:"other"){id}}',
    ),
    graph('query{...R} fragment R on Query {repository(owner:"acme",name:"other"){id}}'),
    graph('mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id}}}', {
      input: { repositoryId: 'R_app', assigneeIds: ['other-user'] },
    }),
  ])('rejects unknown or broadened targets before credential resolution: %j', async (request) => {
    const h = harness();
    await expect(
      h.adapter.authorize(request, binding, actions, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });
  it.each([
    '/releases',
    '/releases/latest',
    '/releases/tags/v1.56.0',
    '/releases/123/assets',
    '/actions/runs?per_page=20',
    '/actions/runs/123/jobs',
    '/actions/runs/123/artifacts',
    '/actions/workflows/release.yml/runs',
    '/actions/jobs/123',
  ])('permits repository-bound evidence reads with explicit permission: %s', async (suffix) => {
    const h = harness();
    const request = { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/app' + suffix };
    const permission = suffix.startsWith('/releases') ? 'releases-read' : 'actions-read';
    await expect(
      h.adapter.authorize(request, binding, actions, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
    const allowed = new Set<ForgeAction>([permission]);
    await expect(
      h.adapter.authorize(request, binding, allowed, new AbortController().signal),
    ).resolves.toMatchObject({ action: permission });
    for (const denied of [
      { ...request, method: 'POST' },
      { ...request, path: request.path.replace('/acme/app', '/acme/other') },
    ]) {
      h.mint.mockClear();
      await expect(
        h.adapter.authorize(denied, binding, allowed, new AbortController().signal),
      ).rejects.toThrow();
      expect(h.mint).not.toHaveBeenCalled();
    }
  });
  it('bounds cyclic and exponentially expanded fragments before credential resolution', async () => {
    const h = harness();
    const fragments = Array.from(
      { length: 25 },
      (_, index) =>
        `fragment F${index} on Repository { ${index === 24 ? 'id' : `...F${index + 1} ...F${index + 1}`} }`,
    ).join(' ');
    for (const query of [
      `query{repository(owner:"acme",name:"app"){...F0}} ${fragments}`,
      'query{repository(owner:"acme",name:"app"){...F}} fragment F on Repository {issue(number:1){...F}}',
    ]) {
      await expect(
        h.adapter.authorize(graph(query), binding, actions, new AbortController().signal),
      ).rejects.toThrow();
    }
    expect(h.mint).not.toHaveBeenCalled();
  });
  it('checks a mutation node against GitHub rather than trusting the sandbox repository claim', async () => {
    const h = harness('acme/other');
    const request = graph(
      'mutation($input:CloseIssueInput!){closeIssue(input:$input){issue{id}}}',
      { input: { issueId: 'foreign-issue' } },
    );
    await expect(
      h.adapter.authorize(request, binding, actions, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledOnce();
    const sent = h.transport.mock.calls[0]?.[0]?.body;
    if (!Buffer.isBuffer(sent)) throw new Error('expected a buffered GraphQL verification request');
    expect(JSON.parse(sent.toString())).toMatchObject({
      variables: { id: 'foreign-issue' },
    });
  });
  it('authorizes an issue mutation only after verifying its repository', async () => {
    const h = harness();
    const request = graph(
      'mutation($input:CloseIssueInput!){closeIssue(input:$input){issue{id}}}',
      { input: { issueId: 'bound-issue' } },
    );
    expect(
      await h.adapter.authorize(request, binding, actions, new AbortController().signal),
    ).toMatchObject({ action: 'issues-write', authorization: 'Bearer server-token' });
  });
  it('enforces read/write actions for Git and GraphQL and accounts for PRs on the Issues REST API', async () => {
    const h = harness();
    const readOnly = new Set<ForgeAction>(['git-read', 'issues-read']);
    for (const request of [
      { hostname: 'github.com', method: 'POST', path: '/acme/app.git/git-receive-pack' },
      graph('query{repository(owner:"acme",name:"app"){pullRequests(first:1){nodes{id}}}}'),
      graph('mutation{closeIssue(input:{issueId:"I_1"}){issue{id}}}'),
      { hostname: 'api.github.com', method: 'GET', path: '/repos/acme/app/issues' },
    ])
      await expect(
        h.adapter.authorize(request, binding, readOnly, new AbortController().signal),
      ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
  });
  it.each([
    'query{repository(owner:"acme",name:"app"){issue(number:1){projectItems(first:10){nodes{project{items(first:10){nodes{content{... on PullRequest{title body}}}}}}}}}}',
    'query{repository(owner:"acme",name:"app"){issue(number:1){timelineItems(first:10){nodes{... on CrossReferencedEvent{source{... on PullRequest{title body}}}}}}}}',
    'query{repository(owner:"acme",name:"app"){issue(number:1){author{... on User{issues(first:10){nodes{title body}}}}}}}',
    'query{repository(owner:"acme",name:"app"){parent{defaultBranchRef{target{... on Commit{history(first:10){nodes{message}}}}}}}}',
    'query{repository(owner:"acme",name:"app"){owner{... on User{issues(first:1){nodes{body}}}}}}',
    'mutation{closeIssue(input:{issueId:"I_1"}){issue{repository{defaultBranchRef{target{... on Commit{history(first:10){nodes{message}}}}}}}}}',
  ])('rejects metadata and mutation response discovery before minting: %s', async (query) => {
    parse(query);
    const h = harness();
    await expect(
      h.adapter.authorize(graph(query), binding, actions, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
  });
  it('rejects commit-associated PR discovery through fragments and aliases', async () => {
    const query = graph(`query {
      repository(owner:"acme",name:"app") {
        defaultBranchRef { target { ...CommitReads } }
      }
    }
    fragment CommitReads on Commit {
      prs: associatedPullRequests(first:10) { nodes { title body } }
    }`);
    const h = harness();
    await expect(
      h.adapter.authorize(
        query,
        binding,
        new Set<ForgeAction>(['git-read']),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });
  it('requires PR write authority for a comment on a pull request', async () => {
    const h = harness('acme/app', 'PullRequest');
    await expect(
      h.adapter.authorize(
        graph('mutation{addComment(input:{subjectId:"PR_1",body:"hello"}){commentEdge{node{id}}}}'),
        binding,
        new Set<ForgeAction>(['issues-write']),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
