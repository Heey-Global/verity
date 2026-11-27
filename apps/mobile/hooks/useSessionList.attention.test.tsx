import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { SessionListModel, type LiveTopicSink, type VerityClient } from '@verity/mobile';
import { useSessionList } from './useSessionList';

const mockSinks = new Map<string, LiveTopicSink>();
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: () => () => undefined,
  useLiveHints: () => undefined,
  liveConnectionFor: () => ({
    connectionState: 'connected',
    resourceWatching: true,
    followsTopic: () => false,
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      return () => mockSinks.delete(topic);
    },
  }),
}));
jest.mock('../lib/sessionSwitchTiming', () => ({ beginClientActivity: () => () => undefined }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockSinks.clear();
});

afterEach(() => jest.restoreAllMocks());

describe('useSessionList server attention', () => {
  // Home followed the server's conditions only through its list read; an
  // administrator must see a sealed server or a silent Updater as it happens.
  it('shows the signals the server topic announces, and reads the list on resync', () => {
    jest.spyOn(SessionListModel.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(SessionListModel.prototype, 'stop').mockImplementation(() => {});
    jest.spyOn(SessionListModel.prototype, 'refresh').mockResolvedValue(undefined);
    const applyHints = jest.spyOn(SessionListModel.prototype, 'applyHints');
    // One client for every render: a new one would make a new model each time.
    const client = {} as VerityClient;
    const hook = renderHook(() => useSessionList(client));
    const sink = mockSinks.get('server:attention');
    expect(sink).toBeDefined();
    act(() =>
      sink!.event({
        t: 'server.attention',
        rev: 1,
        attention: [{ code: 'secret_sealed', message: 'The server is sealed.' }],
      }),
    );
    expect(hook.result.current.serverAttention).toMatchObject({ code: 'secret_sealed' });
    applyHints.mockClear();
    // Missed changes: the list read reports the signals as they are now.
    act(() => sink!.resync());
    expect(applyHints).toHaveBeenCalledWith([]);
    hook.unmount();
    expect(mockSinks.has('server:attention')).toBe(false);
  });
});
