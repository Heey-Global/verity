import { fireEvent, render, screen } from '@testing-library/react-native';
import { LinkedSessionChips } from './LinkedSessionChips';

jest.mock('./Icon', () => ({ Icon: () => null }));
jest.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory(jest.requireActual('../theme/tokens').darkTheme),
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: jest.requireActual('../theme/tokens').darkTheme }),
}));

const link = { sessionId: 'other', name: 'KI Dokumentenmanagement', projectName: 'heey-docs' };

function setup() {
  const onOpen = jest.fn();
  const onDisconnect = jest.fn();
  render(<LinkedSessionChips links={[link]} onOpen={onOpen} onDisconnect={onDisconnect} />);
  return { onOpen, onDisconnect };
}

test('tapping the chip opens the linked session without disconnecting it', () => {
  const { onOpen, onDisconnect } = setup();
  fireEvent.press(screen.getByLabelText('Open linked session KI Dokumentenmanagement'));
  expect(onOpen).toHaveBeenCalledWith(link);
  expect(onDisconnect).not.toHaveBeenCalled();
});

// The x sits inside the chip; a tap meant to disconnect must never also
// navigate away from the current session.
test('tapping the x disconnects without opening the linked session', () => {
  const { onOpen, onDisconnect } = setup();
  fireEvent.press(screen.getByLabelText('Disconnect KI Dokumentenmanagement'));
  expect(onDisconnect).toHaveBeenCalledWith(link);
  expect(onOpen).not.toHaveBeenCalled();
});

test('renders nothing without links', () => {
  render(<LinkedSessionChips links={[]} onOpen={jest.fn()} onDisconnect={jest.fn()} />);
  expect(screen.queryByLabelText('Linked sessions')).toBeNull();
});
