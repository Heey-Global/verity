import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('../../__tests__/support/settingsHarness').expoRouterMock());
import { makeClient, resetSettingsHarness } from '../../__tests__/support/settingsHarness';
import { StorageReclamation } from './StorageReclamation';
const idle = {
  supported: true,
  state: 'idle' as const,
  startedAt: null,
  completedAt: null,
  error: null,
  result: null,
  nativePending: false,
  nativeBuildkit: null,
};
afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});
it('describes host-wide effects before starting and reports retained resources', async () => {
  const result = {
    ...idle,
    state: 'completed' as const,
    result: {
      imagesRemoved: 2,
      containersRemoved: 1,
      dependenciesRemoved: 3,
      worktreesRetired: 0,
      filesystemFreeBytesChange: 1024 ** 3,
      retainedPins: [
        { imageId: 'kept', containers: ['recent'], reason: 'Stopped-container grace period' },
      ],
      blockers: ['Local dependency edits'],
    },
  };
  const start = jest.fn().mockResolvedValue(result);
  render(
    <StorageReclamation
      client={makeClient('unlocked', {
        getStorageReclamation: jest.fn().mockResolvedValue(idle),
        reclaimStorage: start,
      })}
    />,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reclaim now' })).toBeEnabled());
  fireEvent.press(screen.getByRole('button', { name: 'Reclaim now' }));
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByText(/Run storage cleanup across all projects/)).toBeOnTheScreen();
  fireEvent.press(screen.getAllByRole('button', { name: 'Reclaim now' }).at(-1)!);
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByText(/2 images, 1 containers and 3 dependency installations/),
  ).toBeOnTheScreen();
  expect(screen.getByText('Local dependency edits')).toBeOnTheScreen();
});
it('keeps the action unavailable when administrator status cannot be loaded', async () => {
  const start = jest.fn();
  render(
    <StorageReclamation
      client={makeClient('unlocked', {
        getStorageReclamation: jest.fn().mockRejectedValue(new Error('403')),
        reclaimStorage: start,
      })}
    />,
  );
  await screen.findByText(/requires administrator access/);
  expect(screen.getByRole('button', { name: 'Reclaim now' })).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
});

it('shows native receipt blockers while host maintenance is pending', async () => {
  render(
    <StorageReclamation
      client={makeClient('unlocked', {
        getStorageReclamation: jest.fn().mockResolvedValue({
          ...idle,
          nativePending: true,
          nativeBuildkit: {
            version: 1,
            observedAt: new Date(0).toISOString(),
            path: '/var/lib/verity-buildkit/runc-native',
            dryRun: true,
            eligible: false,
            state: 'blocked',
            allocatedBytes: null,
            overlayAllocatedBytes: null,
            reclaimableBytes: null,
            blockers: ['Native host receipt is missing'],
          },
        }),
      })}
    />,
  );
  expect(await screen.findByText('Native host receipt is missing')).toBeOnTheScreen();
});
