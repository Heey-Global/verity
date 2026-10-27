import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { BrowserAlertHost } from '../components/ui/BrowserAlertHost';
import {
  currentBrowserAlert,
  dismissBrowserAlert,
  installBrowserAlerts,
} from '../lib/browserAlerts';

const originalAlert = Alert.alert;
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'web');
  installBrowserAlerts();
});
afterEach(() => {
  while (currentBrowserAlert()) act(() => dismissBrowserAlert());
  Alert.alert = originalAlert;
  jest.restoreAllMocks();
});
it('shows attachment failures with shared controls and dismisses them', () => {
  render(<BrowserAlertHost />);
  act(() => Alert.alert('Could not attach', 'Load failed'));
  expect(screen.getByText('Could not attach')).toBeTruthy();
  expect(screen.getByText('Load failed')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByText('Could not attach')).toBeNull();
});
it('retains queued actions and cancellation callbacks', () => {
  const cancel = jest.fn();
  const proceed = jest.fn();
  render(<BrowserAlertHost />);
  act(() => {
    Alert.alert('First', 'Confirm', [{ text: 'Cancel', style: 'cancel', onPress: cancel }]);
    Alert.alert('Second', 'Continue', [{ text: 'Proceed', onPress: proceed }]);
  });
  fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Second')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Proceed' }));
  expect(proceed).toHaveBeenCalledTimes(1);
  expect(currentBrowserAlert()).toBeUndefined();
});
it('keeps noncancelable prompts open when the scrim is pressed', () => {
  render(<BrowserAlertHost />);
  act(() => Alert.alert('Required', 'Choose an action', undefined, { cancelable: false }));
  fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(screen.getByText('Required')).toBeTruthy();
});
