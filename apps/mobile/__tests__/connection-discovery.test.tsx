import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ConnectionDiscoveryHint } from '../components/ConnectionDiscoveryHint';

beforeEach(async () => {
  await AsyncStorage.clear();
});

it('opens setup only on request and remembers dismissal on this device', async () => {
  const connect = jest.fn();
  const first = render(<ConnectionDiscoveryHint id="drive.project-1" onConnect={connect} />);
  fireEvent.press(await screen.findByText('Connect a folder'));
  expect(connect).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Hide Google Drive suggestion'));
  await waitFor(() =>
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'verity.connection-hint.drive.project-1',
      'hidden',
    ),
  );
  first.unmount();
  render(<ConnectionDiscoveryHint id="drive.project-1" onConnect={connect} />);
  await waitFor(() =>
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('verity.connection-hint.drive.project-1'),
  );
  expect(screen.queryByText('Connect a folder')).toBeNull();
  expect(connect).toHaveBeenCalledTimes(1);
});

it('does not hide discovery for a different project', async () => {
  await AsyncStorage.setItem('verity.connection-hint.drive.project-1', 'hidden');
  render(<ConnectionDiscoveryHint id="drive.project-2" onConnect={jest.fn()} />);
  expect(await screen.findByText('Connect a folder')).toBeTruthy();
});
