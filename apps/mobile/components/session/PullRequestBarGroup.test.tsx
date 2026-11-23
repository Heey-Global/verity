import { fireEvent, render, screen } from '@testing-library/react-native';
import type { BranchPullRequest } from '../../hooks/useBranches';
import { PullRequestBarGroup } from './PullRequestBarGroup';

const checks = { completed: 2, total: 3, successful: 2, failed: 0, pending: 1 };

function pull(name: string, pipeline: BranchPullRequest['pipeline']): BranchPullRequest {
  return {
    number: 42,
    title: `Update ${name}`,
    url: `https://github.com/team/${name}/pull/42`,
    phase: 'open',
    pipeline,
    checks: pipeline === 'failure' ? { ...checks, failed: 1 } : checks,
    mergeable: pipeline === 'success',
    repository: { id: name, name, repo: name, owner: 'team', isDefault: name === 'app' },
  };
}

it('expands into status-ordered repository rows and routes merge and dismiss independently', async () => {
  const ready = pull('app', 'success');
  const running = pull('worker', 'running');
  const failed = pull('api', 'failure');
  const closed = { ...pull('docs', 'success'), phase: 'closed' } as const;
  const onMerge = jest.fn().mockResolvedValue({ ok: true });
  const onDismiss = jest.fn();
  render(
    <PullRequestBarGroup
      pullRequests={[running, ready, closed, failed]}
      confirmHint={async () => true}
      onMerge={onMerge}
      onRefresh={jest.fn()}
      onDismiss={onDismiss}
      codeHost={undefined}
    />,
  );

  expect(screen.queryByText('api #42 · Update api')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: /4 pull requests/ }));
  expect(screen.getAllByRole('link').map((link) => link.props.accessibilityLabel)).toEqual([
    'Open api #42 on GitHub',
    'Open app #42 on GitHub',
    'Open worker #42 on GitHub',
    'Open docs #42 on GitHub',
  ]);
  expect(screen.getByText('2/3 checks run')).toBeTruthy();
  expect(screen.getByText(/closed ·/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Merge pull request 42', disabled: false }));
  fireEvent.press(screen.getByRole('button', { name: 'Hide pull request 42 status' }));
  await screen.findByRole('button', { name: 'Merge pull request 42', busy: false });
  expect(onMerge).toHaveBeenCalledWith(42, 'app', undefined);
  expect(onDismiss).toHaveBeenCalledWith(closed);
});
