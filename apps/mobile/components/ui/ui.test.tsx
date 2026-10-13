import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { Button, ConfirmSheet, Row, StatusDot, StatusTag, TextField, ToggleRow } from './index';
import { darkTheme, lightTheme } from '../../theme/tokens';
import { tint } from './tint';

describe('Button', () => {
  // A second tap on a loading button would run the action twice.
  it('locks while loading and keeps its label next to the spinner', () => {
    const onPress = jest.fn();
    render(<Button label="Activate" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Activate' });
    expect(button).toBeDisabled();
    expect(button.props.accessibilityState).toMatchObject({ busy: true });
    expect(screen.getByText('Activate')).toBeOnTheScreen();
    expect(screen.getByTestId('button-spinner')).toBeOnTheScreen();
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('does not run while disabled', () => {
    const onPress = jest.fn();
    render(<Button label="Copy" onPress={onPress} disabled variant="secondary" />);
    fireEvent.press(screen.getByRole('button', { name: 'Copy' }));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Row', () => {
  // The chevron promises navigation; a row that only acts in place must not show it.
  it('shows the chevron only for rows that navigate', () => {
    // Count the drawn glyph (the mocked Feather host), not the wrappers around it.
    const chevrons = () =>
      screen
        .UNSAFE_queryAllByProps({ name: 'chevron-right' })
        .filter((node) => (node.type as unknown) === 'Feather');
    const { rerender } = render(<Row title="Copy last recording" onPress={jest.fn()} />);
    expect(chevrons()).toHaveLength(0);
    rerender(<Row title="Diagnostics" onPress={jest.fn()} navigates />);
    expect(chevrons()).toHaveLength(1);
  });

  // VoiceOver hears a pressable row as one element; a status left out of its
  // label is a state nobody hears.
  it('speaks the subtitle and trailing status as part of a pressable row', () => {
    render(
      <Row
        title="Server update"
        subtitle="4.36.0 available"
        trailing={<StatusTag intent="needsSetup" label="Update" />}
        onPress={jest.fn()}
        navigates
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Server update, 4.36.0 available, Update' }),
    ).toBeOnTheScreen();
  });

  // VoiceOver hears a pressable row as one element, so a button inside it is
  // an action nobody using VoiceOver can reach.
  it('warns about a button inside a pressable row', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <Row
        title="Recording"
        onPress={jest.fn()}
        trailing={<Button label="Copy" size="compact" onPress={jest.fn()} />}
      />,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be reached by VoiceOver'));
    warn.mockRestore();
  });

  // A single-choice list must read as one control: the selected option is
  // announced as checked, and no option promises navigation.
  it('announces an option of a single-choice list as a checked or unchecked radio', () => {
    render(
      <>
        <Row title="Claude" selected onPress={jest.fn()} navigates />
        <Row title="Codex" selected={false} onPress={jest.fn()} trailing="Default" />
      </>,
    );
    expect(screen.getByRole('radio', { name: 'Claude' }).props.accessibilityState).toMatchObject({
      checked: true,
    });
    // An unselected option shows nothing trailing, so the check mark is the only mark.
    expect(screen.getByRole('radio', { name: 'Codex' }).props.accessibilityState).toMatchObject({
      checked: false,
    });
    expect(screen.queryByText('Default')).toBeNull();
    const glyphs = (name: string) =>
      screen
        .UNSAFE_queryAllByProps({ name })
        .filter((node) => (node.type as unknown) === 'Feather');
    expect(glyphs('check')).toHaveLength(1);
    expect(glyphs('chevron-right')).toHaveLength(0);
  });

  // Cyan marks what can be tapped (docs/design-system.md § 2): a row icon in
  // the action color on a row that does nothing would promise an action.
  it('colors the icon of a tappable row and leaves an inert row grey', () => {
    const iconColor = (icon: string) =>
      screen
        .UNSAFE_queryAllByProps({ name: icon })
        .find((node) => (node.type as unknown) === 'Feather')?.props.color as string;
    render(
      <>
        <Row title="Diagnostics" leading={{ icon: 'activity' }} onPress={jest.fn()} />
        <Row title="Version" leading={{ icon: 'info' }} />
        <Row
          title="Verity Premium"
          leading={{ icon: 'zap', signature: true }}
          onPress={jest.fn()}
        />
      </>,
    );
    // Whichever theme the test renderer runs, the icon takes that theme's role.
    const role = (key: 'action' | 'textMuted' | 'signature') => [
      lightTheme.colors[key],
      darkTheme.colors[key],
    ];
    expect(role('action')).toContain(iconColor('activity'));
    expect(role('textMuted')).toContain(iconColor('info'));
    expect(role('signature')).toContain(iconColor('zap'));
  });

  // A long status ("Starting secure workspace…") once took the whole row and left
  // the title as a column of single letters.
  it('keeps the trailing side from crowding out the title', () => {
    render(
      <Row
        title="Sandbox"
        trailing={<StatusDot intent="transient" label="Starting secure workspace…" />}
        onPress={jest.fn()}
        navigates
      />,
    );
    const word = screen.getByText('Starting secure workspace…');
    expect(word.props.numberOfLines).toBe(1);
    // The trailing container is capped and may shrink.
    const trailing = screen.UNSAFE_getAllByType(require('react-native').View).find((node) => {
      const flat = require('react-native').StyleSheet.flatten(node.props.style) ?? {};
      return flat.maxWidth === '45%';
    });
    expect(trailing).toBeDefined();
  });

  it('renders a plain trailing value as muted text', () => {
    render(<Row title="Tasks" trailing="On" />);
    expect(screen.getByText('On')).toBeOnTheScreen();
  });
});

describe('ToggleRow', () => {
  it('is one switch for the whole row and reports its state', () => {
    const onValueChange = jest.fn();
    render(<ToggleRow title="Online sharing" value onValueChange={onValueChange} />);
    const row = screen.getByRole('switch', { name: 'Online sharing' });
    expect(row.props.accessibilityState).toMatchObject({ checked: true });
    fireEvent.press(row);
    expect(onValueChange).toHaveBeenCalledWith(false);
  });

  it('cannot be flipped again while the server confirms the last change', () => {
    const onValueChange = jest.fn();
    render(<ToggleRow title="Remote access" value onValueChange={onValueChange} switching />);
    fireEvent.press(screen.getByRole('switch', { name: 'Remote access' }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('TextField', () => {
  // The spec keeps invalid input in place so it can be corrected.
  it('keeps the entered text and explains the error in a hint box', () => {
    render(
      <TextField
        label="Uplink subscription key"
        value="sk-9c10"
        onChangeText={jest.fn()}
        error={{ title: 'Key not recognized', message: 'Check it in your account.' }}
      />,
    );
    expect(screen.getByLabelText('Uplink subscription key').props.value).toBe('sk-9c10');
    // One alert element, so VoiceOver reads title and sentence together.
    expect(
      screen.getByRole('alert', { name: 'Key not recognized. Check it in your account.' }),
    ).toBeOnTheScreen();
  });

  // Autocorrect rewrites keys and addresses; it must stay on for prose.
  it('turns off autocorrect only for literal input', () => {
    render(
      <>
        <TextField label="Notes" value="" onChangeText={jest.fn()} multiline />
        <TextField label="Server address" value="" onChangeText={jest.fn()} keyboardType="url" />
      </>,
    );
    expect(screen.getByLabelText('Notes').props.autoCorrect).toBeUndefined();
    expect(screen.getByLabelText('Server address').props.autoCorrect).toBe(false);
  });

  // A pasted certificate corrected or capitalized by the keyboard no longer verifies.
  it('turns off autocorrect for literal multiline input', () => {
    render(<TextField label="Private key" value="" onChangeText={jest.fn()} multiline literal />);
    expect(screen.getByLabelText('Private key').props.autoCorrect).toBe(false);
    expect(screen.getByLabelText('Private key').props.autoCapitalize).toBe('none');
    expect(screen.getByLabelText('Private key').props.spellCheck).toBe(false);
  });

  // Two fields both labelled "Token" would be indistinguishable to VoiceOver,
  // including the control that reveals one of them.
  it('speaks the override label for the field and its reveal control', () => {
    render(
      <TextField
        label="Token"
        accessibilityLabel="Transcription token"
        value="t"
        onChangeText={jest.fn()}
        secret
      />,
    );
    expect(screen.getByLabelText('Transcription token')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show Transcription token' })).toBeOnTheScreen();
  });

  // A subscription key offered to the password manager ends up stored as a
  // password; the platform at least has to be told not to.
  it('masks a secret, asks the platform to keep it out of autofill and reveals it', () => {
    render(<TextField label="Key" value="secret" onChangeText={jest.fn()} secret />);
    const input = screen.getByLabelText('Key');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.textContentType).toBe('none');
    expect(input.props.autoComplete).toBe('off');
    expect(input.props.importantForAutofill).toBe('no');
    fireEvent.press(screen.getByRole('button', { name: 'Show Key' }));
    expect(screen.getByLabelText('Key').props.secureTextEntry).toBe(false);
  });
});

describe('Status', () => {
  it('always names the state in words, not just in color', () => {
    render(
      <>
        <StatusTag intent="ready" label="Active" />
        <StatusDot intent="needsSetup" label="Rejected" />
      </>,
    );
    expect(screen.getByText('Active')).toBeOnTheScreen();
    expect(screen.getByLabelText('Active, ready')).toBeOnTheScreen();
    expect(screen.getByText('Rejected')).toBeOnTheScreen();
    expect(screen.getByLabelText('Rejected, needs attention')).toBeOnTheScreen();
  });

  it('shows a spinner for transient states instead of a colored tag', () => {
    render(<StatusTag intent="transient" label="Connecting" />);
    expect(screen.getByLabelText('Connecting, in progress')).toBeOnTheScreen();
    expect(screen.UNSAFE_getByType(require('react-native').ActivityIndicator)).toBeTruthy();
  });
});

describe('ConfirmSheet', () => {
  function renderSheet(onConfirm: () => void | Promise<void>, onCancel = jest.fn()) {
    render(
      <ConfirmSheet
        visible
        title="Turn off Online sharing?"
        message="Active public links will be revoked."
        confirmLabel="Turn off"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return onCancel;
  }

  // Dismissing must never be read as consent to the destructive action.
  it('cancels when dismissed through the scrim and never confirms', () => {
    const onConfirm = jest.fn();
    const onCancel = renderSheet(onConfirm);
    fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('announces the question when it opens', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    renderSheet(jest.fn());
    expect(announce).toHaveBeenCalledWith(
      'Turn off Online sharing? Active public links will be revoked.',
    );
    announce.mockRestore();
  });

  // Two taps in the same frame both see the unlocked state; only one may run.
  it('starts the action once for two taps before the next render', () => {
    const onConfirm = jest.fn(() => new Promise<void>(() => undefined));
    renderSheet(onConfirm);
    // The Button component's own handler, called twice without a render between.
    const press = screen.UNSAFE_getByProps({ label: 'Turn off' }).props.onPress as () => void;
    // One act(): both taps land before React renders again.
    act(() => {
      press();
      press();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('locks itself while the action runs and reopens for another try after a failure', async () => {
    let fail!: (error: Error) => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const onCancel = renderSheet(onConfirm);
    fireEvent.press(screen.getByRole('button', { name: 'Turn off' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeDisabled();
    fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      fail(new Error('offline'));
    });
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled();
  });
});

describe('tint', () => {
  // A role that is not six-digit hex would turn `${color}24` into an invalid color.
  // Components tint roles inside StyleSheet.create; a role that cannot be
  // tinted would crash every screen as soon as that theme is active. The roles
  // are read from the components, so a newly tinted role is covered too.
  const tintedRoles = [
    ...new Set(
      readdirSync(__dirname)
        .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
        .flatMap((file) =>
          [
            ...readFileSync(join(__dirname, file), 'utf8').matchAll(
              /tint\(\s*theme\.colors\.(\w+)/g,
            ),
          ].map((match) => match[1] as keyof typeof darkTheme.colors),
        ),
    ),
  ];

  it('finds the tinted roles', () => {
    expect(tintedRoles.length).toBeGreaterThan(0);
  });

  it.each([
    ['dark', darkTheme],
    ['light', lightTheme],
  ])('can tint every role the components tint in the %s theme', (_, theme) => {
    for (const role of tintedRoles) {
      expect(() => tint(theme.colors[role] as string, 'fill')).not.toThrow();
    }
  });

  it.each([
    ['neutral', '0f', 6],
    ['fill', '24', 14],
    ['ring', '33', 20],
    ['border', '59', 35],
  ] as const)(
    'preserves hex output and supports web variables at %s strength',
    (strength, alpha, percentage) => {
      expect(tint('#18c8f5', strength)).toBe(`#18c8f5${alpha}`);
      expect(tint('#ABCDEF', strength)).toBe(`#ABCDEF${alpha}`);
      expect(tint('var(--colors-action)', strength)).toBe(
        `color-mix(in srgb, var(--colors-action) ${percentage}%, transparent)`,
      );
    },
  );

  it.each([
    'rgba(3,4,8,0.72)',
    'red',
    '#abc',
    '#12345678',
    'var()',
    'var(colors-action)',
    'var(--x) trailing',
  ])('rejects unsupported color %s', (color) => {
    expect(() => tint(color, 'fill')).toThrow(/six-digit hex role color or CSS variable reference/);
  });
});
