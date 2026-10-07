import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { LiveConnectionLifecycle } from './LiveConnectionLifecycle';

const mockConnection = {
  start: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
  setForeground: jest.fn(),
  onAlert: jest.fn(),
};
let mockToken: string | null = null;
let mockBaseUrl = 'https://core.example';
let mockPresentation = true;
const mockBaseUrlListeners = new Set<() => void>();
const mockAuthListeners = new Set<() => void>();

jest.mock('../lib/liveConnection', () => ({
  liveConnectionFor: jest.fn(() => mockConnection),
  stopLiveConnection: jest.fn(),
}));
jest.mock('../lib/client', () => ({
  getVerityBaseUrl: () => mockBaseUrl,
  subscribeVerityBaseUrl: (listener: () => void) => {
    mockBaseUrlListeners.add(listener);
    return () => mockBaseUrlListeners.delete(listener);
  },
}));
jest.mock('../lib/demoMode', () => ({ isDemoMode: () => false }));
jest.mock('../lib/authToken', () => ({
  getAuthToken: () => mockToken,
  subscribeAuthToken: (listener: () => void) => {
    mockAuthListeners.add(listener);
    return () => mockAuthListeners.delete(listener);
  },
}));
jest.mock('../lib/liveAlerts', () => ({
  browserCanPresentAlerts: () => false,
  nativeCanPresentAlerts: async () => mockPresentation,
  presentLiveAlert: jest.fn().mockResolvedValue(undefined),
}));

describe('LiveConnectionLifecycle', () => {
  const appListeners = new Set<(state: AppStateStatus) => void>();
  let initial: AppStateStatus;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.onAlert.mockReturnValue(() => undefined);
    mockToken = null;
    mockBaseUrl = 'https://core.example';
    mockPresentation = true;
    mockBaseUrlListeners.clear();
    mockAuthListeners.clear();
    appListeners.clear();
    initial = AppState.currentState;
    AppState.currentState = 'active';
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    });
  });
  afterEach(() => {
    AppState.currentState = initial;
    jest.restoreAllMocks();
  });

  const setAppState = async (state: AppStateStatus): Promise<void> => {
    AppState.currentState = state;
    await act(async () => {
      for (const listener of appListeners) listener(state);
    });
  };

  it('waits for the bearer a biometric unlock loads after mount', async () => {
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockConnection.start).not.toHaveBeenCalled();

    mockToken = 'bearer';
    for (const listener of mockAuthListeners) listener();
    expect(mockConnection.start).toHaveBeenCalled();
    expect(mockConnection.resume).toHaveBeenCalled();
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(true);
  });

  it('reauthenticates when an already loaded bearer changes', async () => {
    mockToken = 'first';
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    mockConnection.pause.mockClear();
    mockConnection.resume.mockClear();
    mockToken = 'second';
    for (const listener of mockAuthListeners) listener();
    expect(mockConnection.pause).toHaveBeenCalledTimes(1);
    expect(mockConnection.resume).toHaveBeenCalledTimes(1);
    expect(mockConnection.pause.mock.invocationCallOrder[0]).toBeLessThan(
      mockConnection.resume.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves the server the moment the app goes to the background', async () => {
    mockToken = 'bearer';
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    mockConnection.pause.mockClear();
    mockConnection.start.mockClear();
    mockConnection.resume.mockClear();

    await setAppState('background');
    expect(mockConnection.pause).toHaveBeenCalled();
    expect(mockConnection.start).not.toHaveBeenCalled();
    expect(mockConnection.resume).not.toHaveBeenCalled();

    await setAppState('active');
    expect(mockConnection.resume).toHaveBeenCalled();
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(true);
  });

  it('is no longer the device in front of the user while inactive', async () => {
    mockToken = 'bearer';
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    await setAppState('inactive');
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(false);
  });

  it('presents the alerts the server routes to this device', async () => {
    mockToken = 'bearer';
    const { presentLiveAlert } = jest.requireMock<{ presentLiveAlert: jest.Mock }>(
      '../lib/liveAlerts',
    );
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    const listener = mockConnection.onAlert.mock.calls[0]?.[0] as (alert: unknown) => void;
    const alert = { sessionId: 's1', kind: 'permission', categoryId: 'PERMISSION_PROMPT' };
    listener(alert);
    expect(presentLiveAlert).toHaveBeenCalledWith(alert);
  });

  it('pauses on unmount instead of stopping, so a remounted tree resumes the same connection', async () => {
    mockToken = 'bearer';
    const { stopLiveConnection } = jest.requireMock<{ stopLiveConnection: jest.Mock }>(
      '../lib/liveConnection',
    );
    const view = render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    mockConnection.pause.mockClear();
    view.unmount();
    expect(mockConnection.pause).toHaveBeenCalledTimes(1);
    expect(stopLiveConnection).not.toHaveBeenCalled();
  });

  it('opens the new endpoint immediately when its URL changes', async () => {
    mockToken = 'bearer';
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    const { liveConnectionFor, stopLiveConnection } = jest.requireMock<{
      liveConnectionFor: jest.Mock;
      stopLiveConnection: jest.Mock;
    }>('../lib/liveConnection');
    mockConnection.start.mockClear();
    mockBaseUrl = 'https://other.example';
    act(() => {
      for (const listener of mockBaseUrlListeners) listener();
    });
    expect(stopLiveConnection).toHaveBeenCalledWith('https://core.example');
    expect(liveConnectionFor).toHaveBeenLastCalledWith('https://other.example');
    expect(mockConnection.start).toHaveBeenCalled();
  });

  it('does not claim foreground alert presentation when native notifications are denied', async () => {
    mockToken = 'bearer';
    mockPresentation = false;
    render(<LiveConnectionLifecycle />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(false);
  });
});
