// Several servers in one app (ADR 0023 §7): their projects in the one list,
// and managing the servers themselves.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';

jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  router: { push: jest.fn(), replace: jest.fn() },
}));
jest.mock('../lib/serverSwitch', () => ({ switchToServer: jest.fn() }));

import { OtherServerProjects } from '../components/home/OtherServerProjects';
import { ServersView } from '../app/settings/servers';
import type { VerityServerProfile } from '../lib/serverProfile';

const profile = (serverId: string, url: string, sharedBy?: string): VerityServerProfile => ({
  version: 1,
  serverId,
  identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  activeUrl: url,
  endpoints: [{ url, transport: 'direct', tlsPin: 'sha256-pin' }],
  ...(sharedBy === undefined ? {} : { sharedBy }),
});
const mine = profile('srv_mine_0123456789', 'https://10.0.0.2:8443');
const holgers = profile('srv_holger_0123456', 'https://10.0.0.7:8443', 'Holger');

it('lists a shared server’s projects with whose they are and opens one on its server', async () => {
  const open = jest.fn();
  const client = {
    listProjects: jest.fn().mockResolvedValue([
      { id: 'p1', name: 'verity', state: 'active' },
      { id: 'p2', name: 'Old', state: 'active', archived: true },
      { id: 'p3', name: 'Gone', state: 'revoked' },
    ]),
  } as unknown as VerityClient;
  render(<OtherServerProjects profiles={[holgers]} clientFor={() => client} open={open} />);
  expect(await screen.findByText('verity')).toBeOnTheScreen();
  expect(screen.getByText('from Holger')).toBeOnTheScreen();
  // Archived or removed projects stay out of the list.
  expect(screen.queryByText('Old')).not.toBeOnTheScreen();
  expect(screen.queryByText('Gone')).not.toBeOnTheScreen();
  fireEvent.press(screen.getByText('verity'));
  expect(open).toHaveBeenCalledWith(holgers.serverId, 'p1');
});

it('offers a locked server as a whole instead of guessing its projects', () => {
  const open = jest.fn();
  render(<OtherServerProjects profiles={[holgers]} clientFor={() => null} open={open} />);
  fireEvent.press(screen.getByText('Holger'));
  expect(open).toHaveBeenCalledWith(holgers.serverId);
});

it('separates own and shared servers, switches and removes only the inactive one', async () => {
  const switchTo = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  render(
    <ServersView active={mine} initialOthers={[holgers]} switchTo={switchTo} remove={remove} />,
  );
  expect(screen.getByText('Your server')).toBeOnTheScreen();
  expect(screen.getByText('Shared with you')).toBeOnTheScreen();
  expect(screen.getByText('In use')).toBeOnTheScreen();

  // The server in use opens nothing: removing it would strand the app.
  fireEvent.press(screen.getByText('10.0.0.2'));
  expect(screen.queryByText('Remove from this app')).not.toBeOnTheScreen();

  fireEvent.press(screen.getByText('Holger'));
  fireEvent.press(await screen.findByText('Switch to this server'));
  await waitFor(() => expect(switchTo).toHaveBeenCalledWith(holgers.serverId));

  fireEvent.press(screen.getByText('Holger'));
  fireEvent.press(await screen.findByText('Remove from this app'));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.press(await screen.findByText('Remove', {}, { timeout: 3000 }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(holgers.serverId));
  await waitFor(() => expect(screen.queryByText('Shared with you')).not.toBeOnTheScreen());
});
