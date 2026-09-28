import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { StaticPreviewSheet } from '../components/project/StaticPreviewSheet';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));

it('creates and shows a static share for the folder selected in the session worktree', async () => {
  const share = {
    id: 'share-one',
    projectId: 'project-one',
    sessionId: 'session-one',
    targetKind: 'static-folder' as const,
    staticPath: 'site/dist',
    state: 'active' as const,
    publicOrigin: 'https://preview.example',
    expiresAt: '2030-01-01T01:00:00Z',
  };
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) =>
      path === 'site' ? ['dist'] : ['site'],
    ),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(async () => share),
    stopPublicPreviewShare: jest.fn(async () => undefined),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByText('📁 site'));
  fireEvent.press(await screen.findByLabelText('Select site/dist'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  fireEvent.press(screen.getByText('Create link'));

  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: 'site/dist',
      pin: '123456',
      ttlSeconds: 3600,
    }),
  );
  expect(await screen.findByText('https://preview.example')).toBeTruthy();
  expect(screen.getByText(/Available until/)).toBeTruthy();
});

it('ignores a child-folder response after returning to the session root', async () => {
  let resolveChild!: (directories: string[]) => void;
  let rootLoads = 0;
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) => {
      if (path === 'site') {
        return await new Promise<string[]>((resolve) => {
          resolveChild = resolve;
        });
      }
      rootLoads += 1;
      return rootLoads === 1 ? ['site'] : ['other'];
    }),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByText('📁 site'));
  fireEvent.press(screen.getByText('.. Parent folder'));
  expect(await screen.findByText('📁 other')).toBeTruthy();
  await act(async () => resolveChild(['dist']));
  expect(screen.queryByText('📁 dist')).toBeNull();
  expect(screen.getByText('📁 other')).toBeTruthy();
});

it('does not offer folders from the previous location when navigation fails', async () => {
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) => {
      if (path === 'site') throw new Error('Folder unavailable');
      return ['site'];
    }),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByText('📁 site'));
  expect(await screen.findByText('Folder unavailable')).toBeTruthy();
  expect(screen.queryByText('📁 site')).toBeNull();
  expect(screen.queryByLabelText('Select site/site')).toBeNull();
});
