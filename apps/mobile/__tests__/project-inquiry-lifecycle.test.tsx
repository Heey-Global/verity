import { act, fireEvent, render } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { AppState, type AppStateStatus } from 'react-native';
import { ProjectInquiryCards } from '../components/project/ProjectInquiryCards';
import { registerPendingSession } from '../lib/pendingSessions';

let mockFocused = true;
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]);
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const initialAppState = AppState.currentState;
beforeEach(() => {
  jest.useFakeTimers();
  mockFocused = true;
  AppState.currentState = 'active';
});
afterEach(() => {
  AppState.currentState = initialAppState;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('waits for server creation before reading inquiries', async () => {
  const created = deferred<void>();
  registerPendingSession('creating-inquiries', created.promise);
  const listProjectInquiries = jest.fn().mockResolvedValue([]);
  const view = render(
    <ProjectInquiryCards
      client={{ listProjectInquiries } as unknown as VerityClient}
      sessionId="creating-inquiries"
    />,
  );
  await flush();
  expect(listProjectInquiries).not.toHaveBeenCalled();
  await act(async () => {
    created.resolve();
  });
  expect(listProjectInquiries).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('never reads after failed creation, including refocus', async () => {
  const created = deferred<void>();
  registerPendingSession('failed-inquiries', created.promise);
  const read = jest.fn().mockResolvedValue([]);
  const props = {
    client: { listProjectInquiries: read } as unknown as VerityClient,
    sessionId: 'failed-inquiries',
  };
  const view = render(<ProjectInquiryCards {...props} />);
  await act(async () => {
    created.reject(new Error('creation failed'));
  });
  mockFocused = false;
  view.rerender(<ProjectInquiryCards {...props} />);
  mockFocused = true;
  view.rerender(<ProjectInquiryCards {...props} />);
  await act(async () => {
    jest.advanceTimersByTime(180_000);
  });
  expect(read).not.toHaveBeenCalled();
});

it('refreshes once per minute and pauses on blur', async () => {
  const read = jest.fn().mockResolvedValue([]);
  const props = { client: { listProjectInquiries: read } as unknown as VerityClient };
  const view = render(<ProjectInquiryCards {...props} />);
  await flush();
  await act(async () => {
    jest.advanceTimersByTime(59_999);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(read).toHaveBeenCalledTimes(2);
  mockFocused = false;
  view.rerender(<ProjectInquiryCards {...props} />);
  await act(async () => {
    jest.advanceTimersByTime(180_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  mockFocused = true;
  view.rerender(<ProjectInquiryCards {...props} />);
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
});

it('keeps real errors visible without retrying until requested', async () => {
  const read = jest.fn().mockRejectedValueOnce(new Error('not found')).mockResolvedValue([]);
  const view = render(
    <ProjectInquiryCards client={{ listProjectInquiries: read } as unknown as VerityClient} />,
  );
  await flush();
  expect(view.getByText('not found')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(180_000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByText('Retry project requests'));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.queryByText('not found')).toBeNull();
});

it('does not query in the background and discards background responses', async () => {
  let onState!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onState = listener;
    return { remove: jest.fn() };
  });
  const pending = deferred<never[]>();
  const read = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
  render(
    <ProjectInquiryCards client={{ listProjectInquiries: read } as unknown as VerityClient} />,
  );
  act(() => onState('background'));
  await act(async () => {
    pending.reject(new Error('stale error'));
  });
  await act(async () => {
    jest.advanceTimersByTime(180_000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  act(() => onState('active'));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
});

it('discards late errors after session changes and coalesces refocus reads', async () => {
  const pending = deferred<never[]>();
  const read = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
  const client = { listProjectInquiries: read } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} sessionId="old" />);
  mockFocused = false;
  view.rerender(<ProjectInquiryCards client={client} sessionId="old" />);
  mockFocused = true;
  view.rerender(<ProjectInquiryCards client={client} sessionId="old" />);
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender(<ProjectInquiryCards client={client} sessionId="new" />);
  await act(async () => {
    pending.reject(new Error('obsolete'));
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.queryByText('obsolete')).toBeNull();
});

it('does not read when creation finishes after leaving the screen', async () => {
  const created = deferred<void>();
  registerPendingSession('abandoned-inquiries', created.promise);
  const read = jest.fn().mockResolvedValue([]);
  const view = render(
    <ProjectInquiryCards
      client={{ listProjectInquiries: read } as unknown as VerityClient}
      sessionId="abandoned-inquiries"
    />,
  );
  view.unmount();
  await act(async () => {
    created.resolve();
  });
  expect(read).not.toHaveBeenCalled();
});

it('waits for foreground before the first query', async () => {
  AppState.currentState = 'background';
  let onState!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onState = listener;
    return { remove: jest.fn() };
  });
  const read = jest.fn().mockResolvedValue([]);
  render(
    <ProjectInquiryCards
      client={{ listProjectInquiries: read } as unknown as VerityClient}
      projectId="project"
    />,
  );
  await act(async () => {
    jest.advanceTimersByTime(180_000);
  });
  expect(read).not.toHaveBeenCalled();
  act(() => onState('active'));
  await flush();
  expect(read).toHaveBeenCalledWith(undefined, 'project');
});

it('retries errors on refocus but not on app foreground alone', async () => {
  let onState!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onState = listener;
    return { remove: jest.fn() };
  });
  const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  const props = { client: { listProjectInquiries: read } as unknown as VerityClient };
  const view = render(<ProjectInquiryCards {...props} />);
  await flush();
  act(() => {
    onState('background');
    onState('active');
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  mockFocused = false;
  view.rerender(<ProjectInquiryCards {...props} />);
  mockFocused = true;
  view.rerender(<ProjectInquiryCards {...props} />);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.queryByText('offline')).toBeNull();
});

it('refreshes an approved inquiry when an older pending poll fails', async () => {
  const inquiry = {
    id: 'overlap',
    sourceSessionId: 'source',
    targetSessionId: 'target',
    sourceProjectId: 'app',
    targetProjectId: 'cluster',
    title: 'Overlapping approval',
    body: 'Change request',
    kind: 'change',
    status: 'pending',
    createdAt: '2026-11-06',
    answer: null,
  };
  const poll = deferred<never[]>();
  const read = jest
    .fn()
    .mockResolvedValueOnce([inquiry])
    .mockReturnValueOnce(poll.promise)
    .mockResolvedValue([]);
  const decideProjectInquiry = jest.fn().mockResolvedValue(undefined);
  const view = render(
    <ProjectInquiryCards
      client={{ listProjectInquiries: read, decideProjectInquiry } as unknown as VerityClient}
      sessionId="target"
    />,
  );
  await flush();
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  fireEvent.press(view.getByText('Approve change'));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    poll.reject(new Error('old poll failed'));
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(view.queryByText('Overlapping approval')).toBeNull();
  expect(view.queryByText('old poll failed')).toBeNull();
});
