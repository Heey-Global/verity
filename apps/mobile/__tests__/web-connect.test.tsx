// The browser sign-in must submit from the keyboard: without onSubmitEditing,
// Return in the pairing link field silently does nothing and the page looks stuck.
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockPairBrowser = jest.fn<Promise<string>, [string]>();
jest.mock('../lib/browserSession', () => ({
  pairBrowser: (code: string) => mockPairBrowser(code),
  authenticateBrowser: jest.fn(),
}));
jest.mock('../lib/client', () => ({ createVerityClient: () => null }));
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { replace: (path: string) => mockReplace(path) },
  useLocalSearchParams: () => ({}),
}));

import WebConnectScreen from '../app/web-connect';

it('pairs the browser when Return is pressed in the pairing link field', async () => {
  mockPairBrowser.mockResolvedValue('authenticated');
  render(<WebConnectScreen />);
  const field = screen.getByLabelText('Pairing link');
  fireEvent.changeText(field, ' ABC-123 ');
  await act(async () => {
    fireEvent(field, 'submitEditing');
  });
  expect(mockPairBrowser).toHaveBeenCalledWith(' ABC-123 ');
  expect(mockReplace).toHaveBeenCalledWith('/');
});
