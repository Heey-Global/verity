import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SERVER_MAINTENANCE_MESSAGE } from '@verity/mobile';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());

import { ConnectionStatusBar } from '../components/ConnectionStatusBar';
import { hidesConnectionError, RECOVERED_NOTICE_MS } from '../hooks/useServerConnection';
import { serverConnection } from '../lib/serverConnection';

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
