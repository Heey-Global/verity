import { render } from '@testing-library/react-native';
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
const mockAuthListeners = new Set<() => void>();

jest.mock('../lib/liveConnection', () => ({
  liveConnectionFor: jest.fn(() => mockConnection),
  stopLiveConnection: jest.fn(),
}));
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
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
  presentLiveAlert: jest.fn().mockResolvedValue(undefined),
}));

describe('LiveConnectionLifecycle', () => {
  const appListeners = new Set<(state: AppStateStatus) => void>();
  let initial: AppStateStatus;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.onAlert.mockReturnValue(() => undefined);
    mockToken = null;
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

  const setAppState = (state: AppStateStatus): void => {
    AppState.currentState = state;
    for (const listener of appListeners) listener(state);
  };

  it('waits for the bearer a biometric unlock loads after mount', () => {
    render(<LiveConnectionLifecycle />);
    expect(mockConnection.start).not.toHaveBeenCalled();

    mockToken = 'bearer';
    for (const listener of mockAuthListeners) listener();
    expect(mockConnection.start).toHaveBeenCalled();
    expect(mockConnection.resume).toHaveBeenCalled();
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(true);
  });

  it('leaves the server the moment the app goes to the background', () => {
    mockToken = 'bearer';
    render(<LiveConnectionLifecycle />);
    mockConnection.pause.mockClear();

    setAppState('background');
    expect(mockConnection.pause).toHaveBeenCalledTimes(1);

    setAppState('active');
    expect(mockConnection.resume).toHaveBeenCalled();
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(true);
  });

  it('is no longer the device in front of the user while inactive', () => {
    mockToken = 'bearer';
    render(<LiveConnectionLifecycle />);
    setAppState('inactive');
    expect(mockConnection.setForeground).toHaveBeenLastCalledWith(false);
  });

  it('presents the alerts the server routes to this device', () => {
    mockToken = 'bearer';
    const { presentLiveAlert } = jest.requireMock<{ presentLiveAlert: jest.Mock }>(
      '../lib/liveAlerts',
    );
    render(<LiveConnectionLifecycle />);
    const listener = mockConnection.onAlert.mock.calls[0]?.[0] as (alert: unknown) => void;
    const alert = { sessionId: 's1', kind: 'permission', categoryId: 'PERMISSION_PROMPT' };
    listener(alert);
    expect(presentLiveAlert).toHaveBeenCalledWith(alert);
  });

  it('pauses on unmount instead of stopping, so a remounted tree resumes the same connection', () => {
    mockToken = 'bearer';
    const { stopLiveConnection } = jest.requireMock<{ stopLiveConnection: jest.Mock }>(
      '../lib/liveConnection',
    );
    const view = render(<LiveConnectionLifecycle />);
    mockConnection.pause.mockClear();
    view.unmount();
    expect(mockConnection.pause).toHaveBeenCalledTimes(1);
    expect(stopLiveConnection).not.toHaveBeenCalled();
  });
});
