import { fireEvent, render, screen } from '@testing-library/react-native';
import { WikiDetails } from './WikiDetails';

it('keeps both recovery routes behind Details and preserves the Wiki return route', () => {
  const navigate = jest.fn();
  const { rerender } = render(
    <WikiDetails root="documents" documentSession disabled={false} navigate={navigate} />,
  );
  expect(screen.queryByText('Current session files')).toBeNull();
  expect(screen.queryByText('Files from other sessions')).toBeNull();
  fireEvent.press(screen.getByText('Details'));
  fireEvent.press(screen.getByText('Current session files'));
  expect(navigate).toHaveBeenLastCalledWith('worktree');
  fireEvent.press(screen.getByText('Files from other sessions'));
  expect(navigate).toHaveBeenLastCalledWith('drafts');
  rerender(<WikiDetails root="drafts" documentSession disabled={false} navigate={navigate} />);
  fireEvent.press(screen.getByText('Back to Wiki'));
  expect(navigate).toHaveBeenLastCalledWith('documents');
});

it('keeps generated files quiet but reports unsupported files before opening Details', () => {
  const props = {
    root: 'documents' as const,
    documentSession: false,
    disabled: false,
    navigate: jest.fn(),
  };
  const { rerender } = render(
    <WikiDetails
      {...props}
      status={{
        running: false,
        pending: false,
        excludedEntries: [{ path: '__pycache__', reason: 'generated' }],
      }}
    />,
  );
  expect(screen.queryByText(/Some files could not/)).toBeNull();
  fireEvent.press(screen.getByText('Details'));
  expect(screen.getByText(/__pycache__: Generated files/)).toBeOnTheScreen();
  rerender(
    <WikiDetails
      {...props}
      status={{
        running: false,
        pending: true,
        excludedEntries: [{ path: 'link', reason: 'unsupported' }],
      }}
    />,
  );
  expect(screen.getByText(/Some files could not/)).toBeOnTheScreen();
});

it('hides Wiki controls in Code and Raw Sources and reports unknown save status', () => {
  const props = { documentSession: false, disabled: false, navigate: jest.fn() };
  const { rerender } = render(<WikiDetails {...props} root="worktree" />);
  expect(screen.queryByText('Details')).toBeNull();
  rerender(<WikiDetails {...props} root="sources" />);
  expect(screen.queryByText('Details')).toBeNull();
  rerender(
    <WikiDetails
      {...props}
      root="documents"
      status={{ running: false, pending: true, inspectionError: true }}
    />,
  );
  expect(screen.getByText(/save status could not be checked/)).toBeOnTheScreen();
});

it('keeps request errors and conflicts visible without exposing technical errors until expanded', () => {
  render(
    <WikiDetails
      root="documents"
      documentSession={false}
      disabled={false}
      navigate={jest.fn()}
      error="EACCES: private path"
      hasConflicts
    />,
  );
  expect(screen.getByText(/request could not be completed/)).toBeOnTheScreen();
  expect(screen.getByText(/Open the Conflicts folder/)).toBeOnTheScreen();
  expect(screen.queryByText('EACCES: private path')).toBeNull();
  fireEvent.press(screen.getByText('Details'));
  expect(screen.getByText('EACCES: private path')).toBeOnTheScreen();
});

it('explains unavailable knowledge and hides recovery routes that require it', () => {
  render(
    <WikiDetails
      root="documents"
      documentSession={false}
      disabled={false}
      navigate={jest.fn()}
      error="this session has no knowledge folder"
    />,
  );
  expect(screen.getByText(/Open the Wiki from the project page/)).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Details'));
  expect(screen.queryByText('Files from other sessions')).toBeNull();
});

it.each([
  'This session is not linked to a project. Open the Wiki from a project.',
  'Knowledge storage is not configured. Ask your administrator to configure it.',
  'Session not found. Reopen the session and try again.',
])('shows actionable knowledge availability errors: %s', (error) => {
  render(
    <WikiDetails
      root="documents"
      documentSession={false}
      disabled={false}
      navigate={jest.fn()}
      error={error}
    />,
  );
  expect(screen.getByText(error)).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Details'));
  expect(screen.queryByText('Files from other sessions')).toBeNull();
});
