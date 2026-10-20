import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { Linking } from 'react-native';
import { GithubPermissionNotice } from '../components/GithubPermissionNotice';

it('explains missing access, opens GitHub, and clears after rechecking', async () => {
  const url = 'https://github.com/settings/apps/verity/permissions';
  const validateGithubApp = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      commitStatusPermission: { state: 'app_update_required', url },
    })
    .mockResolvedValueOnce({ ok: true, commitStatusPermission: { state: 'ready' } });
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  render(<GithubPermissionNotice client={{ validateGithubApp } as unknown as VerityClient} />);
  expect(await screen.findByText('Complete CI checks')).toBeOnTheScreen();
  expect(screen.getByText(/does not allow changes/)).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Enable permission in GitHub'));
  expect(open).toHaveBeenCalledWith(url);
  fireEvent.press(screen.getByText('Check again'));
  await waitFor(() => expect(screen.queryByText('Complete CI checks')).toBeNull());
  open.mockRestore();
});

it('offers installation approval when the App already requests access', async () => {
  const validateGithubApp = jest.fn().mockResolvedValue({
    ok: true,
    commitStatusPermission: {
      state: 'approval_required',
      url: 'https://github.com/settings/installations/123',
    },
  });
  render(<GithubPermissionNotice client={{ validateGithubApp } as unknown as VerityClient} />);
  expect(await screen.findByText('Approve new permission in GitHub')).toBeOnTheScreen();
});

it('does not claim a missing grant after a failed check', async () => {
  const validateGithubApp = jest.fn().mockRejectedValue(new Error('network'));
  render(<GithubPermissionNotice client={{ validateGithubApp } as unknown as VerityClient} />);
  expect(await screen.findByText('Could not check commit-status access')).toBeOnTheScreen();
  expect(screen.queryByText('Enable permission in GitHub')).toBeNull();
});
