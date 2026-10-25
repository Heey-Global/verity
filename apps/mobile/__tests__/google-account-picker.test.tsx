import { act, fireEvent, render, screen } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import type { GoogleAccount } from '@verity/mobile';
import { useGoogleAccountPicker } from '../components/settings/GoogleAccountPicker';

const account = (id: string, displayName: string | null = null) =>
  ({ id, email: `${id}@example.test`, displayName, scopes: [] }) as unknown as GoogleAccount;

let choose: ReturnType<typeof useGoogleAccountPicker>[0];
function Harness() {
  const [chooseAccount, sheet] = useGoogleAccountPicker();
  choose = chooseAccount;
  return sheet;
}

it('asks only which account to use and marks the one in use', async () => {
  render(<Harness />);
  let result!: Promise<string | null>;
  act(() => {
    result = choose({
      accounts: [account('private'), account('work', 'Business')],
      title: 'Gmail account',
      selectedId: 'work',
    });
  });
  await screen.findByText('Gmail account');
  // Scope, disable and add-account actions crowded this sheet before; they
  // live on the chip and in Settings now, so only accounts may be offered.
  expect(screen.queryByText(/project default|disable|connect another/i)).toBeNull();
  expect(screen.getByLabelText('Business')).toHaveProperty(
    'props.accessibilityState.checked',
    true,
  );
  expect(screen.getByLabelText('private@example.test')).toHaveProperty(
    'props.accessibilityState.checked',
    false,
  );
  fireEvent.press(screen.getByText('private@example.test'));
  await expect(result).resolves.toBe('private');
});

it('skips the sheet when there is nothing to choose', async () => {
  render(<Harness />);
  await expect(choose({ accounts: [account('only')] })).resolves.toBe('only');
  await expect(choose({ accounts: [] })).resolves.toBeNull();
  expect(screen.queryByText('Choose Google account')).toBeNull();
});
