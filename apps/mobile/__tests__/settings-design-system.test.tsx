import { fireEvent, render, screen } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
import DesignSystemCatalog from '../app/settings/design-system';
import { resetSettingsHarness } from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

// The catalog renders every building block; a component that throws on one of
// its states would break the reference everyone reviews against.
it('renders every building block and keeps the interactive examples working', () => {
  render(<DesignSystemCatalog />);
  for (const heading of [
    'Type',
    'Buttons',
    'Grouped list',
    'Cards',
    'Status',
    'Fields',
    'Sheets',
  ]) {
    expect(screen.getByRole('header', { name: heading })).toBeOnTheScreen();
  }
  const sharing = screen.getByRole('switch', { name: 'Online sharing' });
  expect(sharing.props.accessibilityState).toMatchObject({ checked: true });
  fireEvent.press(sharing);
  expect(
    screen.getByRole('switch', { name: 'Online sharing' }).props.accessibilityState,
  ).toMatchObject({ checked: false });
  fireEvent.press(screen.getByRole('button', { name: 'Remove subscription key' }));
  expect(screen.getByText('Remove subscription key?')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Remove key' })).toBeOnTheScreen();
});
