import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { SERVER_MAINTENANCE_MESSAGE, VerityApiError, type VerityClient } from '@verity/mobile';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());

import { ConnectionStatusBar } from '../components/ConnectionStatusBar';
import { SettingsScaffold } from '../components/settings/SettingsChrome';
import {
  hidesConnectionError,
  RECOVERED_NOTICE_MS,
  RECOVERY_GRACE_MS,
  useHidesConnectionError,
} from '../hooks/useServerConnection';
import { serverConnection } from '../lib/serverConnection';
import { loadVeritySettings, resetVeritySettingsStore } from '../lib/settingsStore';

const TLS_DUMP =
  'Uplink probe (Pinned TLS transport failed [NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE]; tunnel local=2) and direct Core request failed';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => serverConnection.reset());
  jest.useRealTimers();
});

describe('ConnectionStatusBar', () => {
  it('stays out of the way while the server answers', () => {
    render(<ConnectionStatusBar />);
    expect(screen.toJSON()).toBeNull();
  });

  it('shows a server update once, as an update rather than an error', () => {
    render(<ConnectionStatusBar />);
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    expect(screen.getByText('Server is updating')).toBeOnTheScreen();
    expect(screen.getByText(/Reconnecting automatically · 0:00/)).toBeOnTheScreen();
    // Nothing to do during an update: no retry button, and never the raw 503 text.
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(screen.queryByText(SERVER_MAINTENANCE_MESSAGE)).toBeNull();
    act(() => jest.advanceTimersByTime(84_000));
    expect(screen.getByText(/Reconnecting automatically · 1:24/)).toBeOnTheScreen();
  });

  it('keeps the transport dump behind the details of an outage', () => {
    render(<ConnectionStatusBar />);
    act(() => serverConnection.reportFailure('unreachable', TLS_DUMP));
    expect(screen.getByText('Can’t reach your server')).toBeOnTheScreen();
    expect(screen.getByText('Retrying in 2 s')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try now' })).toBeOnTheScreen();
    expect(screen.queryByText(TLS_DUMP)).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: /Can’t reach your server/ }));
    // The failure in words first: both routes the dump names failed.
    expect(screen.getByText('Remote Control')).toBeOnTheScreen();
    expect(screen.getByText('Direct connection')).toBeOnTheScreen();
    expect(screen.queryByText(TLS_DUMP)).toBeNull();
    fireEvent.press(screen.getByText('Technical details'));
    expect(screen.getByText(TLS_DUMP)).toBeOnTheScreen();
  });

  it('does not open the details by itself at the next disruption', () => {
    render(<ConnectionStatusBar />);
    act(() => serverConnection.reportFailure('unreachable', TLS_DUMP));
    fireEvent.press(screen.getByRole('button', { name: /Can’t reach your server/ }));
    expect(screen.getByText('Direct connection')).toBeOnTheScreen();
    act(() => serverConnection.reportSuccess());
    act(() => jest.advanceTimersByTime(RECOVERED_NOTICE_MS));
    act(() => serverConnection.reportFailure('unreachable', TLS_DUMP));
    expect(screen.getByText('Can’t reach your server')).toBeOnTheScreen();
    expect(screen.queryByText('Direct connection')).toBeNull();
  });

  it('says "Connected" briefly when the server is back, then disappears', () => {
    render(<ConnectionStatusBar />);
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    act(() => serverConnection.reportSuccess());
    expect(screen.getByText('Connected')).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(RECOVERED_NOTICE_MS));
    expect(screen.toJSON()).toBeNull();
  });
});

describe('hidesConnectionError', () => {
  const disrupted = () => {
    serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    return serverConnection.getState();
  };

  it('hides a screen’s copy of the failure the bar already shows', () => {
    const state = disrupted();
    expect(hidesConnectionError(`Projects: ${SERVER_MAINTENANCE_MESSAGE}`, state)).toBe(true);
    expect(hidesConnectionError(TLS_DUMP, state)).toBe(true);
  });

  it('keeps errors that are the screen’s own', () => {
    expect(hidesConnectionError('Could not save decision.', disrupted())).toBe(false);
  });

  it('keeps a connection error the bar is not showing', () => {
    // The monitor never saw it (e.g. a stream outside the request path): if the
    // screen hid it too, the failure would be shown nowhere.
    expect(hidesConnectionError(TLS_DUMP, serverConnection.getState())).toBe(false);
  });

  it('keeps hiding the leftover error while the reload after recovery runs', () => {
    disrupted();
    serverConnection.reportSuccess();
    const state = serverConnection.getState();
    const recoveredAt = state.kind === 'connected' ? state.recoveredAt! : 0;
    expect(hidesConnectionError(SERVER_MAINTENANCE_MESSAGE, state, recoveredAt + 5_000)).toBe(true);
    expect(hidesConnectionError(SERVER_MAINTENANCE_MESSAGE, state, recoveredAt + 60_000)).toBe(
      false,
    );
  });
});

describe('useHidesConnectionError', () => {
  // A connection error the reload did not clear must come back on screen when
  // the grace ends; nothing else may be needed to re-render the screen.
  it('shows a leftover error again once the grace after recovery ends', () => {
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    const { result } = renderHook(() => useHidesConnectionError(SERVER_MAINTENANCE_MESSAGE));
    expect(result.current).toBe(true);
    act(() => serverConnection.reportSuccess());
    expect(result.current).toBe(true);
    act(() => jest.advanceTimersByTime(RECOVERY_GRACE_MS));
    expect(result.current).toBe(false);
  });
});

describe('Settings after an outage', () => {
  const scaffold = (error: string, onRetry: () => void) => (
    <SettingsScaffold title="Settings" state={{ error, saving: false }} onRetry={onRetry}>
      {null}
    </SettingsScaffold>
  );

  // `onRetry` may repeat a save. A save that failed because the server was
  // updating may already have been applied: recovery must never replay it.
  it('hides the outage but never retries from the banner by itself', () => {
    const onRetry = jest.fn();
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    render(scaffold(SERVER_MAINTENANCE_MESSAGE, onRetry));
    expect(screen.queryByText(SERVER_MAINTENANCE_MESSAGE)).toBeNull();
    act(() => serverConnection.reportSuccess());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('keeps an error of its own on screen', () => {
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    render(scaffold('Save rejected: name already taken', jest.fn()));
    expect(screen.getByText('Save rejected: name already taken')).toBeOnTheScreen();
  });

  it('reloads settings whose load failed once the server is back', async () => {
    const getVeritySettings = jest
      .fn()
      .mockRejectedValueOnce(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE))
      .mockResolvedValue({});
    const client = {
      getVeritySettings,
      getSecretStatus: jest.fn().mockResolvedValue({ state: 'unlocked' }),
    } as unknown as VerityClient;
    await act(() => loadVeritySettings(client));
    expect(getVeritySettings).toHaveBeenCalledTimes(1);
    act(() => serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE));
    act(() => serverConnection.reportSuccess());
    expect(getVeritySettings).toHaveBeenCalledTimes(2);
    resetVeritySettingsStore();
  });
});
