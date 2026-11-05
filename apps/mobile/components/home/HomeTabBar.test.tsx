import { fireEvent, render, screen } from '@testing-library/react-native';

import { StyleSheet } from 'react-native';

import { HomeTabBar } from './HomeTabBar';

it('switches between Home and the project list and names what waits on Home', () => {
  const onChange = jest.fn();
  render(<HomeTabBar tab="projects" onChange={onChange} count={3} bottomInset={0} />);
  const home = screen.getByRole('tab', { name: 'Home, 3 need you' });
  expect(screen.getByRole('tab', { name: 'Projects' }).props.accessibilityState).toEqual({
    selected: true,
  });
  fireEvent.press(home);
  expect(onChange).toHaveBeenCalledWith('home');
});

it('shows no count when nothing needs the operator', () => {
  render(<HomeTabBar tab="home" onChange={jest.fn()} count={0} bottomInset={0} />);
  expect(screen.getByRole('tab', { name: 'Home' })).toBeTruthy();
  expect(screen.queryByText('0')).toBeNull();
});

it('lays the count over the icon so Home and Projects share one centre line', () => {
  // A badge in the flow widens Home's icon row, and its label is then centred
  // under icon and badge together — visibly off the Projects label beside it.
  render(<HomeTabBar tab="projects" onChange={jest.fn()} count={10} bottomInset={0} />);
  const badge = StyleSheet.flatten(screen.getByTestId('home-tab-badge').props.style);
  expect(badge.position).toBe('absolute');
});
