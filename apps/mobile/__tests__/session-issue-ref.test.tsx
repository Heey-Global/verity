import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Pressable } from 'react-native';

import { SessionIssueRef } from '../components/SessionIssueRef';

describe('SessionIssueRef', () => {
  it('opens the issue named by the branch without opening the session row', () => {
    const openRow = jest.fn();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(
      <Pressable onPress={openRow} accessibilityLabel="Open session">
        <SessionIssueRef
          branch="feat/1198-brokered-forwarding"
          repo={{ owner: 'acme', repo: 'verity' }}
        />
      </Pressable>,
    );

    expect(screen.getByText('#1198')).toBeTruthy();
    const stopPropagation = jest.fn();
    fireEvent.press(screen.getByLabelText('Issue 1198. Open on GitHub.'), { stopPropagation });

    // Without it, the tap on web bubbles into the row's link and opens the session.
    expect(stopPropagation).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://github.com/acme/verity/issues/1198');
    expect(openRow).not.toHaveBeenCalled();
  });

  it('stays plain text when the repo is unknown, so no broken link is offered', () => {
    render(<SessionIssueRef branch="fix/42-keyboard-gap" repo={undefined} />);

    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing for a branch without an issue number', () => {
    render(<SessionIssueRef branch="agent/d0626bd8" repo={{ owner: 'acme', repo: 'verity' }} />);

    expect(screen.toJSON()).toBeNull();
  });
});
