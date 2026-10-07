import type { SessionModelState, VerityClient } from '@verity/mobile';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useSession, type UseSession } from './useSession';

interface MockModel {
  state: SessionModelState;
  onChange: (snapshot: SessionModelState) => void;
  start: jest.Mock;
  stop: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  setView: jest.Mock;
  refreshActivity: jest.Mock;
}
const mockModels: MockModel[] = [];
jest.mock('@verity/mobile', () => ({
  ...jest.requireActual<typeof import('@verity/mobile')>('@verity/mobile'),
  SessionModel: jest.fn().mockImplementation((options: { onChange: MockModel['onChange'] }) => {
    const model: MockModel = {
      state: { loaded: false, name: 'initial' } as SessionModelState,
      onChange: options.onChange,
      start: jest.fn(),
      stop: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      setView: jest.fn(),
      refreshActivity: jest.fn(),
    };
    mockModels.push(model);
    return model;
  }),
}));
const mockHintListeners: ((hints: { sessionId: string; topics: string[] }[]) => void)[] = [];
jest.mock('../lib/liveConnection', () => ({
  liveConnectionFor: jest.fn(() => ({})),
  useLiveHints: (_baseUrl: string, listener: (hints: unknown[]) => void) => {
    mockHintListeners.push(listener);
  },
  subscribeLiveRefresh: () => () => {},
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = require('react') as typeof import('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

function emit(model: MockModel, name: string): void {
  model.state = { ...model.state, name, loaded: true };
  model.onChange(model.state);
}

describe('useSession frame publication', () => {
  const frames = new Map<number, FrameRequestCallback>();
  const appListeners = new Set<(state: AppStateStatus) => void>();
  let nextFrame = 0;
  const client = {} as VerityClient;
  let initialAppState: AppStateStatus;

  beforeEach(() => {
    mockModels.length = 0;
    frames.clear();
    appListeners.clear();
    nextFrame = 0;
    initialAppState = AppState.currentState;
    AppState.currentState = 'active';
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
      if (typeof id === 'number') frames.delete(id);
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      appListeners.add(listener);
      return {
        remove: () => {
          appListeners.delete(listener);
        },
      };
    });
  });

  afterEach(() => {
    AppState.currentState = initialAppState;
    jest.restoreAllMocks();
  });

  function paint(): void {
    act(() => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(16);
      }
    });
  }

  it('publishes the newest snapshot once per frame without dropping later bursts', () => {
    const rendered: Array<string | null | undefined> = [];
    const hook = renderHook(() => {
      const session = useSession(client, 's1', 'http://host');
      rendered.push(session.name);
      return session;
    });
    const model = mockModels[0]!;
    const before = rendered.length;
    act(() => {
      emit(model, 'a');
      emit(model, 'ab');
      emit(model, 'abc');
    });
    // Token bursts must not force a screen render for every socket message.
    expect(rendered).toHaveLength(before);
    expect(frames.size).toBe(1);
    paint();
    expect(rendered).toHaveLength(before + 1);
    expect(hook.result.current.name).toBe('abc');
    act(() => emit(model, 'abcd'));
    paint();
    expect(hook.result.current.name).toBe('abcd');
    hook.unmount();
  });

  it('cancels pending publication and ignores late model callbacks on unmount', () => {
    const hook = renderHook(() => useSession(client, 's1', 'http://host'));
    const model = mockModels[0]!;
    act(() => emit(model, 'pending'));
    expect(frames.size).toBe(1);
    hook.unmount();
    expect(frames.size).toBe(0);
    act(() => emit(model, 'late'));
    expect(frames.size).toBe(0);
    expect(model.stop).toHaveBeenCalledTimes(1);
  });

  it('flushes the latest snapshot before native animation frames stop in background', () => {
    const hook = renderHook(() => useSession(client, 's1', 'http://host'));
    const model = mockModels[0]!;
    act(() => emit(model, 'tail'));
    act(() => appListeners.forEach((listener) => listener('background')));
    expect(hook.result.current.name).toBe('tail');
    expect(frames.size).toBe(0);
    expect(model.pause).toHaveBeenCalledTimes(1);
    act(() => appListeners.forEach((listener) => listener('active')));
    expect(model.resume).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('discards old-session frames and late callbacks when the session changes', () => {
    const hook = renderHook<UseSession, { id: string }>(
      ({ id }) => useSession(client, id, 'http://host'),
      {
        initialProps: { id: 's1' },
      },
    );
    const old = mockModels[0]!;
    act(() => emit(old, 'old tail'));
    hook.rerender({ id: 's2' });
    expect(frames.size).toBe(0);
    const current = mockModels[1]!;
    act(() => emit(old, 'late old tail'));
    expect(frames.size).toBe(0);
    act(() => emit(current, 'new tail'));
    paint();
    expect(hook.result.current.name).toBe('new tail');
    hook.unmount();
  });

  it('marks the session as viewed while focused, so its own notifications stay quiet', () => {
    const hook = renderHook(() => useSession(client, 's1', 'http://host'));
    const model = mockModels[0]!;
    expect(model.setView).toHaveBeenLastCalledWith(true);
    hook.unmount();
    expect(model.setView).toHaveBeenLastCalledWith(false);
  });

  it('refreshes the activity snapshot when a hint says it changed, not for every event', () => {
    mockHintListeners.length = 0;
    const hook = renderHook(() => useSession(client, 's1', 'http://host'));
    const model = mockModels[0]!;
    act(() => mockHintListeners.at(-1)?.([{ sessionId: 's1', topics: ['events'] }]));
    expect(model.refreshActivity).not.toHaveBeenCalled();
    act(() => mockHintListeners.at(-1)?.([{ sessionId: 's1', topics: ['events', 'status'] }]));
    expect(model.refreshActivity).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
