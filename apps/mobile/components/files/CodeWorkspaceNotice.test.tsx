import { fireEvent, render, screen } from '@testing-library/react-native';

import { CodeWorkspaceNotice } from './CodeWorkspaceNotice';
import { FileRootTabs } from './FileRootTabs';

it('offers a restore for a missing checkout instead of switching to Documents', () => {
  const restore = jest.fn();
  const documents = jest.fn();
  render(
    <CodeWorkspaceNotice
      restoring={false}
      failure={null}
      onRestore={restore}
      onOpenDocuments={documents}
    />,
  );
  expect(screen.getByText('Code workspace unavailable')).toBeTruthy();
  fireEvent.press(screen.getByText('Restore'));
  fireEvent.press(screen.getByText('Open Documents'));
  expect(restore).toHaveBeenCalledTimes(1);
  expect(documents).toHaveBeenCalledTimes(1);
});

it('keeps the cause of a failed restore under Details', () => {
  render(
    <CodeWorkspaceNotice
      restoring={false}
      failure="project clone is not a Git repository"
      onRestore={jest.fn()}
      onOpenDocuments={undefined}
    />,
  );
  expect(screen.queryByText('Open Documents')).toBeNull();
  fireEvent.press(screen.getByText('Details'));
  expect(screen.getByText('project clone is not a Git repository')).toBeTruthy();
});

it('shows the restore in progress without a second Restore action', () => {
  render(
    <CodeWorkspaceNotice
      restoring
      failure={null}
      onRestore={jest.fn()}
      onOpenDocuments={undefined}
    />,
  );
  expect(screen.getByText('Restoring code workspace…')).toBeTruthy();
  expect(screen.queryByText('Restore')).toBeNull();
});

it('keeps the Code tab reachable while its checkout is missing', () => {
  const code = jest.fn();
  const drive = jest.fn();
  render(
    <FileRootTabs
      codeIcon="folder"
      codeActive
      codeDisabled={false}
      driveActive={false}
      drive
      disabled={false}
      onCode={code}
      onDrive={drive}
    />,
  );
  expect(screen.getByLabelText('Code').props.accessibilityState).toMatchObject({
    selected: true,
    disabled: false,
  });
  fireEvent.press(screen.getByLabelText('Google Drive'));
  expect(drive).toHaveBeenCalledTimes(1);
});
