import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { FileActionMenu } from './FileActionMenu';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileNameDialog } from './FileNameDialog';

describe('FileActionMenu', () => {
  it('puts the destructive action last, after every safe one', () => {
    // Listed first by the caller on purpose: the menu, not the call site, decides
    // that delete is never the item a hurried tap lands on.
    render(
      <FileActionMenu
        title="a.md"
        actions={[
          {
            key: 'delete',
            label: 'Delete…',
            icon: 'trash-2',
            destructive: true,
            onPress: () => {},
          },
          { key: 'rename', label: 'Rename…', icon: 'edit-3', onPress: () => {} },
        ]}
        onDismiss={() => {}}
      />,
    );

    const items = screen.getAllByRole('menuitem').map((item) => item.props.accessibilityLabel);
    expect(items).toEqual(['Rename…', 'Delete…']);
  });

  it('closes before running the chosen action', () => {
    const calls: string[] = [];
    render(
      <FileActionMenu
        title="a.md"
        actions={[
          { key: 'rename', label: 'Rename…', icon: 'edit-3', onPress: () => calls.push('rename') },
        ]}
        onDismiss={() => calls.push('dismiss')}
      />,
    );

    fireEvent.press(screen.getByLabelText('Rename…'));
    // An action that opens its own dialog must not find the menu still on top.
    expect(calls).toEqual(['dismiss', 'rename']);
  });
});

describe('FileBreadcrumb', () => {
  it('navigates to the root and to every folder but the current one', () => {
    const visited: number[] = [];
    render(
      <FileBreadcrumb
        rootIcon="book-open"
        rootLabel="Shared"
        segments={[
          { key: 'insights', name: 'insights' },
          { key: 'insights/uplink', name: 'uplink' },
        ]}
        onNavigate={(index) => visited.push(index)}
      />,
    );

    fireEvent.press(screen.getByLabelText('Back to Shared'));
    fireEvent.press(screen.getByLabelText('Back to insights'));
    fireEvent.press(screen.getByLabelText('uplink'));
    expect(visited).toEqual([-1, 0]);
  });
});

describe('FileNameDialog', () => {
  const dialog = (onSubmit: (name: string) => Promise<void>) =>
    render(
      <FileNameDialog
        title="Rename file"
        initialName="a.md"
        confirmLabel="Rename"
        validate={(name) => (name === 'b.md' ? '"b.md" already exists here.' : null)}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

  it('preselects the stem through the cross-platform selection prop', () => {
    // Web inputs have no native setSelection method; autofocus must not call it.
    dialog(async () => {});
    fireEvent(screen.getByLabelText('File name'), 'focus');
    expect(screen.getByLabelText('File name').props.selection).toEqual({ start: 0, end: 1 });
    fireEvent(screen.getByLabelText('File name'), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 1 } },
    });
    expect(screen.getByLabelText('File name').props.selection).toBeUndefined();
  });

  it('offers no rename until the name changes to a valid one', async () => {
    const submitted: string[] = [];
    dialog(async (name) => {
      submitted.push(name);
    });

    fireEvent.press(screen.getByLabelText('Rename'));
    fireEvent.changeText(screen.getByLabelText('File name'), 'b.md');
    expect(screen.getByText('"b.md" already exists here.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Rename'));
    expect(submitted).toEqual([]);

    fireEvent.changeText(screen.getByLabelText('File name'), 'c.md');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Rename'));
    });
    expect(submitted).toEqual(['c.md']);
  });

  it('keeps a refused name editable and says why', async () => {
    // The agent can take the name between the check and the request; the
    // server's 409 must not close the dialog and lose what was typed.
    dialog(() => Promise.reject(new Error('"c.md" already exists')));

    fireEvent.changeText(screen.getByLabelText('File name'), 'c.md');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Rename'));
    });

    expect(screen.getByText('"c.md" already exists')).toBeTruthy();
    expect(screen.getByLabelText('File name')).toHaveDisplayValue('c.md');
  });
});
