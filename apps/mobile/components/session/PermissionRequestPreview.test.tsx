import { fireEvent, render, screen } from '@testing-library/react-native';

import { PermissionRequestPreview } from './PermissionRequestPreview';

const deleteCard = {
  action: 'delete',
  folderId: 'f1',
  path: 'old-kickoff.md',
  kind: 'file',
  expectedVersion: 'v1',
  networkShare: {
    action: 'delete',
    kind: 'file',
    share: 'Studio NAS',
    location: 'Studio NAS › Projects › Briefs › old-kickoff.md',
  },
};

it('shows a network share change in words, with the request one tap away', () => {
  render(<PermissionRequestPreview tool="verity_network_shares" input={deleteCard} />);
  expect(screen.getByText('Studio NAS › Projects › Briefs › old-kickoff.md')).toBeTruthy();
  expect(screen.getByText(/Verity keeps no copy/)).toBeTruthy();
  expect(screen.queryByTestId('permission-request-details')).toBeNull();
  fireEvent.press(screen.getByText('Show full request'));
  expect(screen.getByTestId('permission-request-details').props.children).toContain(
    '"expectedVersion": "v1"',
  );
});

it('shows the destination of a move and a replacement preview', () => {
  render(
    <PermissionRequestPreview
      tool="verity_network_shares"
      input={{
        networkShare: {
          action: 'move',
          kind: 'folder',
          share: 'Studio NAS',
          location: 'Studio NAS › Briefs › Reviews',
          destination: 'Studio NAS › Archive › Reviews',
        },
      }}
    />,
  );
  expect(screen.getByText('To')).toBeTruthy();
  expect(screen.getByText('Studio NAS › Archive › Reviews')).toBeTruthy();
  expect(screen.queryByText(/Verity keeps no copy/)).toBeNull();
});

it('keeps the full request for anything it cannot describe', () => {
  render(<PermissionRequestPreview tool="verity_network_shares" input={{ folderId: 'f1' }} />);
  expect(screen.getByTestId('permission-request-details')).toBeTruthy();
  screen.unmount();
  render(<PermissionRequestPreview tool="verity_other" input={deleteCard} />);
  expect(screen.getByTestId('permission-request-details')).toBeTruthy();
});
