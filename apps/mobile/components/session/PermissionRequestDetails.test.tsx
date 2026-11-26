import { render, screen } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import { PermissionRequestDetails } from './PermissionRequestDetails';

it('keeps every unknown request field readable in the session', () => {
  const summary = 'Build investigation. '.repeat(40);
  const input = { summary, changes: [{ path: '/w/file', content: 'last field' }] };
  const view = render(<PermissionRequestDetails input={input} />);
  const details = screen.getByTestId('permission-request-details');
  expect(details.props.children).toBe(JSON.stringify(input, null, 2));
  expect(details.props.numberOfLines).toBeUndefined();
  expect(view.UNSAFE_getByType(ScrollView).props.nestedScrollEnabled).toBe(true);
});

it('renders malformed values without losing the approval card', () => {
  render(<PermissionRequestDetails input={{ summary: 'a\u202eb', size: 1n }} />);
  expect(screen.getByTestId('permission-request-details').props.children).toContain('fields:');
});

it('leaves scrolling to a pinned card that already scrolls its body', () => {
  const view = render(<PermissionRequestDetails input={{ summary: 'x' }} inline />);
  expect(screen.getByTestId('permission-request-details')).toBeTruthy();
  expect(view.UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
});
