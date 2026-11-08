jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
import type { ProjectPullRequest, RepositoryPullRequests, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { RepositoriesPage } from './RepositoriesPage';

function pull(
  number: number,
  state: ProjectPullRequest['state'],
  origin: ProjectPullRequest['origin'],
): ProjectPullRequest {
  return {
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/team/site/pull/${String(number)}`,
    author: origin.kind === 'renovate' ? 'renovate[bot]' : 'someone',
    branch: `branch-${String(number)}`,
    headSha: `abc${String(number)}def0`,
    baseRef: 'main',
    fork: false,
    state,
    checks: { completed: 2, total: 2, successful: 2, failed: 0, pending: 0 },
    viewerCanMerge: true,
    origin,
  };
}

const SITE: RepositoryPullRequests = {
  id: 'default:p',
  name: 'team/site',
  kind: 'github',
  owner: 'team',
  repo: 'site',
  isDefault: true,
  status: 'ok',
  webUrl: 'https://github.com/team/site',
  pullRequests: [
    pull(1, 'conflict', { kind: 'renovate' }),
    pull(2, 'failing', { kind: 'session', sessionId: 's2', name: 'Stable order' }),
    pull(3, 'ready', { kind: 'renovate' }),
    pull(4, 'ready', { kind: 'session', sessionId: 's4', name: 'Task list' }),
  ],
};

const INFRA: RepositoryPullRequests = {
  id: 'infra',
  name: 'ops/infra',
  kind: 'forgejo',
  owner: 'ops',
  repo: 'infra',
  isDefault: false,
  status: 'unavailable',
  webUrl: null,
  pullRequests: [],
};

function renderPage(repositories: RepositoryPullRequests[] = [SITE, INFRA]) {
  const client = {
    getProjectPullRequests: jest.fn().mockResolvedValue(repositories),
    mergeProjectPullRequest: jest.fn().mockResolvedValue({ merged: true }),
    mergePullRequest: jest.fn().mockResolvedValue({ merged: true }),
    fixProjectPullRequest: jest.fn().mockResolvedValue({ sessionId: 'fix-1', created: true }),
  };
  render(<RepositoriesPage client={client as unknown as VerityClient} projectId="p" />);
  return client;
}

async function confirmMerge() {
  // The confirmation's button comes last, after the list's own Merge buttons.
  await act(async () => fireEvent.press(screen.getAllByRole('button', { name: 'Merge' }).at(-1)!));
}

it('offers Merge on green rows and Fix only where no session owns the failure', async () => {
  renderPage();
  const site = await screen.findByTestId('repository-default:p');
  // Conflicting Renovate PR: Fix. Failing session PR: its session fixes it, no button.
  expect(within(site).getAllByRole('button', { name: 'Fix' })).toHaveLength(1);
  expect(within(site).getAllByRole('button', { name: 'Merge' })).toHaveLength(2);
  // The unreachable host is marked, not dropped and not read as "no pull requests".
  const infra = screen.getByTestId('repository-infra');
  expect(within(infra).getByText('Unavailable')).toBeTruthy();
  expect(within(infra).queryByText('No open pull requests')).toBeNull();
});

it('merges a Renovate PR at the commit the list showed, after confirming', async () => {
  const client = renderPage([SITE]);
  const site = await screen.findByTestId('repository-default:p');
  fireEvent.press(within(site).getAllByRole('button', { name: 'Merge' })[0]!);
  expect(client.mergeProjectPullRequest).not.toHaveBeenCalled();
  expect(screen.getByText(/at commit abc3def/)).toBeTruthy();
  await confirmMerge();
  expect(client.mergeProjectPullRequest).toHaveBeenCalledWith('p', 'default:p', 3, {
    branch: 'branch-3',
    expectedHeadSha: 'abc3def0',
  });
  expect(client.mergePullRequest).not.toHaveBeenCalled();
});

it('merges a session-linked PR by repository, at the commit the list showed', async () => {
  const client = renderPage([SITE]);
  const site = await screen.findByTestId('repository-default:p');
  fireEvent.press(within(site).getAllByRole('button', { name: 'Merge' })[1]!);
  await confirmMerge();
  // A fix session may be pushing to this branch, and its own route would check the
  // session's branch rather than this pull request: only the commit shown merges.
  expect(client.mergeProjectPullRequest).toHaveBeenCalledWith('p', 'default:p', 4, {
    branch: 'branch-4',
    expectedHeadSha: 'abc4def0',
  });
  expect(client.mergePullRequest).not.toHaveBeenCalled();
});

it('starts the fix session and opens it', async () => {
  const client = renderPage([SITE]);
  const site = await screen.findByTestId('repository-default:p');
  await act(async () => fireEvent.press(within(site).getByRole('button', { name: 'Fix' })));
  expect(client.fixProjectPullRequest).toHaveBeenCalledWith('p', 'default:p', 1, 'branch-1');
  expect(router.push).toHaveBeenCalledWith({ pathname: '/session/[id]', params: { id: 'fix-1' } });
});

it('says why a merge was refused instead of failing silently', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const client = renderPage([SITE]);
  client.mergeProjectPullRequest.mockRejectedValue(new Error('changed since it was shown'));
  const site = await screen.findByTestId('repository-default:p');
  fireEvent.press(within(site).getAllByRole('button', { name: 'Merge' })[0]!);
  await confirmMerge();
  expect(alert).toHaveBeenCalledWith('Not merged', 'changed since it was shown');
});
