import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import * as Reanimated from 'react-native-reanimated';
import { Platform, Text } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';

import {
  favoriteAction,
  isFullSwipe,
  mixColor,
  SessionContextMenu,
  SwipeableSessionRow,
} from '../components/SessionRowActions';
import { exportGestureDiagnostics, setGestureDiagnosticsEnabled } from '../lib/gestureDiagnostics';

function renderMenu(favorite: boolean) {
  const handlers = {
    onClose: jest.fn(),
    onToggleFavorite: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  };
  render(
    <SessionContextMenu
      at={{ x: 40, y: 80 }}
      title="Fix login"
      leading={favoriteAction(favorite, handlers.onToggleFavorite)}
      onClose={handlers.onClose}
      onEdit={handlers.onEdit}
      onDelete={handlers.onDelete}
    />,
  );
  return handlers;
}

describe('SessionContextMenu', () => {
  // A task row has no favorite; its menu must not offer one it cannot keep.
  it('leaves out the leading action for a row without one', () => {
    render(
      <SessionContextMenu
        at={{ x: 40, y: 80 }}
        title="Fix login"
        leading={undefined}
        onClose={jest.fn()}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
      />,
    );
    expect(screen.queryByLabelText('Add to favorites')).toBeNull();
    expect(screen.getByLabelText('Edit…')).toBeTruthy();
  });

  it('offers to add a session that is not a favorite yet', () => {
    const { onToggleFavorite, onClose } = renderMenu(false);

    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.queryByLabelText('Remove from favorites')).toBeNull();
    fireEvent.press(screen.getByLabelText('Add to favorites'));

    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers to remove an existing favorite', () => {
    const { onToggleFavorite } = renderMenu(true);

    expect(screen.queryByLabelText('Add to favorites')).toBeNull();
    fireEvent.press(screen.getByLabelText('Remove from favorites'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('routes Edit to the session settings and Delete to the delete confirmation', () => {
    const { onEdit, onDelete, onToggleFavorite, onClose } = renderMenu(false);

    fireEvent.press(screen.getByLabelText('Edit…'));
    fireEvent.press(screen.getByLabelText('Delete…'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes without acting when the backdrop is tapped', () => {
    const { onClose, onToggleFavorite, onEdit, onDelete } = renderMenu(false);

    fireEvent.press(screen.getByLabelText('Close menu'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect([onToggleFavorite, onEdit, onDelete].some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });
});

describe('SwipeableSessionRow', () => {
  function renderRow(favorite: boolean, disabled = false) {
    const handlers = { onToggleFavorite: jest.fn(), onDelete: jest.fn(), onEdit: jest.fn() };
    render(
      <SwipeableSessionRow favorite={favorite} label="Fix login" disabled={disabled} {...handlers}>
        <Text>row content</Text>
      </SwipeableSessionRow>,
    );
    return handlers;
  }

  it('drops queued swipe actions while a row drag owns the touch', () => {
    const handlers = renderRow(false, true);
    fireEvent.press(screen.getByLabelText('Favorite'));
    fireEvent.press(screen.getByLabelText('Delete'));
    fireEvent.press(screen.getByLabelText('Edit'));
    expect(handlers.onToggleFavorite).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(handlers.onEdit).not.toHaveBeenCalled();
  });

  it('fires favorite and delete from their swipe actions', () => {
    const { onToggleFavorite, onDelete } = renderRow(false);

    expect(screen.getByText('row content')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Favorite'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('opens the session settings from the Edit action beside Delete', () => {
    const { onEdit, onDelete, onToggleFavorite } = renderRow(false);

    fireEvent.press(screen.getByLabelText('Edit'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it('labels the leading action as unfavorite for a favorite', () => {
    renderRow(true);

    expect(screen.getByLabelText('Unfavorite')).toBeTruthy();
    expect(screen.queryByLabelText('Favorite')).toBeNull();
  });
});

describe('SwipeableSessionRow gesture diagnostics', () => {
  afterEach(() => act(() => setGestureDiagnosticsEnabled(false)));

  type Observer = {
    handlerName: string;
    config: { enabled?: boolean };
    handlers: Record<string, ((event: unknown, manager?: unknown) => void) | undefined>;
  };
  const observers = () =>
    screen
      .UNSAFE_getAllByType(GestureDetector)
      .map((detector) => detector.props.gesture as Observer)
      .filter((gesture) => gesture.handlerName === 'ManualGestureHandler');
  const renderRow = () =>
    render(
      <SwipeableSessionRow
        favorite={false}
        label="Fix login"
        onToggleFavorite={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
        diagnostics={{ rowKey: 'session:private-id', projectKind: 'local' }}
      >
        <Text>row content</Text>
      </SwipeableSessionRow>,
    );

  it('keeps the browser row mounted when recording is toggled', () => {
    const original = Platform.OS;
    Platform.OS = 'web';
    try {
      renderRow();
      const content = screen.getByText('row content');
      act(() => setGestureDiagnosticsEnabled(true));
      expect(screen.getByText('row content')).toBe(content);
      expect(observers()).toHaveLength(0);
      act(() => setGestureDiagnosticsEnabled(false));
      expect(screen.getByText('row content')).toBe(content);
    } finally {
      Platform.OS = original;
    }
  });

  it('records lock changes, which a locked row cannot report through touches', () => {
    const row = (disabled: boolean) => (
      <SwipeableSessionRow
        favorite={false}
        label="Fix login"
        onToggleFavorite={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
        disabled={disabled}
        diagnostics={{ rowKey: 'session:private-id', projectKind: 'local' }}
      >
        <Text>row content</Text>
      </SwipeableSessionRow>
    );
    const view = render(row(false));
    act(() => setGestureDiagnosticsEnabled(true));
    view.rerender(row(true));
    view.rerender(row(false));
    expect(exportGestureDiagnostics().events.map((event) => event.event)).toEqual([
      'locked',
      'unlocked',
    ]);
  });

  it('keeps native content mounted and disables the observer outside recording', () => {
    const mounted = jest.fn();
    const unmounted = jest.fn();
    function Content() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <Text>persistent content</Text>;
    }
    render(
      <SwipeableSessionRow
        favorite={false}
        label="row"
        onToggleFavorite={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
      >
        <Content />
      </SwipeableSessionRow>,
    );
    expect(observers()[0]!.config.enabled).toBe(false);
    act(() => setGestureDiagnosticsEnabled(true));
    expect(observers()[0]!.config.enabled).toBe(true);
    act(() => setGestureDiagnosticsEnabled(false));
    expect(observers()[0]!.config.enabled).toBe(false);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('crosses to JS only for new movement thresholds and rejects queued old recordings', () => {
    const queued: (() => void)[] = [];
    const bridge = jest.spyOn(Reanimated, 'runOnJS').mockImplementation(
      (callback) =>
        ((...args: unknown[]) => {
          queued.push(() => callback(...args));
        }) as typeof callback,
    );
    renderRow();
    act(() => setGestureDiagnosticsEnabled(true));
    const [observer] = observers();
    const touch = (x: number) => ({ allTouches: [{ absoluteX: x, absoluteY: 50 }] });
    try {
      act(() => {
        observer!.handlers.onTouchesDown?.(touch(100));
        for (let x = 101; x <= 105; x++) observer!.handlers.onTouchesMove?.(touch(x));
      });
      expect(bridge).toHaveBeenCalledTimes(1);
      act(() => observer!.handlers.onTouchesMove?.(touch(114)));
      expect(bridge).toHaveBeenCalledTimes(3);
      act(() => observer!.handlers.onTouchesMove?.(touch(115)));
      expect(bridge).toHaveBeenCalledTimes(3);
      act(() => {
        setGestureDiagnosticsEnabled(false);
        setGestureDiagnosticsEnabled(true);
        queued.forEach((deliver) => deliver());
      });
      expect(exportGestureDiagnostics().events).toEqual([]);
    } finally {
      bridge.mockRestore();
    }
  });

  it('records touches the row receives, labelled by project kind but not by session', () => {
    renderRow();
    act(() => setGestureDiagnosticsEnabled(true));
    const [observer] = observers();
    expect(observer).toBeDefined();
    const fail = jest.fn();
    const touch = (x: number, y = 50) => ({ allTouches: [{ absoluteX: x, absoluteY: y }] });
    act(() => {
      observer!.handlers.onTouchesDown?.(touch(100));
      observer!.handlers.onTouchesMove?.(touch(114));
      observer!.handlers.onTouchesCancelled?.(
        { changedTouches: [{ absoluteX: 114, absoluteY: 50 }], numberOfTouches: 0 },
        { fail },
      );
    });
    const { events } = exportGestureDiagnostics();
    expect(events.map((event) => event.event)).toEqual([
      'touch-down',
      'move-6',
      'move-12',
      'touch-cancelled',
    ]);
    expect(events[0]).toMatchObject({ source: 'row', projectKind: 'local', row: 1 });
    expect(events[3]).toMatchObject({ dx: 14, dy: 0 });
    expect(JSON.stringify(events)).not.toContain('private-id');
    // A manual gesture left pending would sit in the arbitration it measures.
    expect(fail).toHaveBeenCalledTimes(1);
  });
});

describe('full swipe direction', () => {
  it('arms only the action in the swipe direction', () => {
    expect(isFullSwipe('favorite', 200, 160)).toBe(true);
    expect(isFullSwipe('delete', 200, 160)).toBe(false);
    expect(isFullSwipe('favorite', -200, 160)).toBe(false);
    expect(isFullSwipe('delete', -200, 160)).toBe(true);
    expect(isFullSwipe('favorite', 100, 160)).toBe(false);
    expect(isFullSwipe('delete', -100, 160)).toBe(false);
  });
});

describe('mixColor', () => {
  it('blends to an opaque color, so lanes never let the row content show through', () => {
    // A translucent `#rrggbbaa` here is what let the title and a second tint
    // bleed through the delete lane.
    expect(mixColor('#ff5c8a', '#0a0b16', 0.16)).toBe('#311829');
    expect(mixColor('#ff5c8a', '#0a0b16', 1)).toBe('#ff5c8a');
    expect(mixColor('#ff5c8a', '#0a0b16', 0)).toBe('#0a0b16');
  });

  it('falls back to the base color for a token that is not #rrggbb', () => {
    expect(mixColor('rgba(255, 92, 138, 1)', '#0a0b16', 0.16)).toBe('#0a0b16');
    expect(mixColor('#f58', '#0a0b16', 0.16)).toBe('#0a0b16');
  });
});
