import { render, screen } from '@testing-library/react-native';
import { MatrixSendPreview } from '../components/ui/MatrixSendPreview';

it('shows exact account, stable room destination and the complete multiline text without truncation', () => {
  const body = 'First line\n' + 'x'.repeat(7_000) + '\nLast line';
  render(
    <MatrixSendPreview
      summary={{
        accountId: '@verity:example.test',
        endpoint: 'https://example.test',
        roomId: '!room:example.test',
        roomName: 'Room',
        bindingVersion: 1,
        body,
      }}
    />,
  );
  expect(screen.getByText('From: @verity:example.test')).toBeOnTheScreen();
  expect(screen.getByText('!room:example.test')).toBeOnTheScreen();
  expect(screen.getByText(body).props.numberOfLines).toBeUndefined();
  expect(screen.getByText(body).props.selectable).toBe(true);
  expect(screen.getByTestId('matrix-send-body').props.nestedScrollEnabled).toBe(true);
  expect(screen.getByText(/Approves this message only/)).toBeOnTheScreen();
});
