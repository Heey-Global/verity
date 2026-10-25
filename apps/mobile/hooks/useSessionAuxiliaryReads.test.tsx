import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { SessionGoogleStatus, VerityClient } from '@verity/mobile';
import { useSessionGoogleStatus } from './useSessionGoogleStatus';
import { useFocusedSessionRead } from './useFocusedSessionRead';
import { useGoogleAccountAvailability } from './useGoogleAccountAvailability';
import { subscribeLiveRefresh } from '../lib/liveConnection';
import { readFileSync } from 'node:fs';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../lib/liveConnection', () => ({ subscribeLiveRefresh: jest.fn(() => jest.fn()) }));
// Keep account discovery real; native OAuth is never invoked by these read hooks.
jest.mock('../lib/googleDrive', () => ({ runGoogleAccountAuth: jest.fn() }));
beforeEach(() => jest.clearAllMocks());
const connection = {
  enabled: true,
  connected: true,
  accountEmail: 'a@example.test',
  clientId: null,
  source: 'project' as const,
  mode: 'inherit' as const,
};
const summary: SessionGoogleStatus = {
  gmail: connection,
  calendar: connection,
  contacts: connection,
  workspaceFile: {
    assignmentId: 'assigned',
    fileId: 'doc',
    name: 'Document',
    kind: 'docs',
    webViewLink: 'https://docs.google.com/document/d/doc',
    revisionId: null,
  },
};
function client() {
  return {
    getSessionGoogleStatus: jest.fn().mockResolvedValue(summary),
    getSessionGmailConnection: jest.fn().mockResolvedValue(connection),
    getSessionCalendarConnection: jest.fn().mockResolvedValue(connection),
    getSessionContactsConnection: jest.fn().mockResolvedValue(connection),
    getSessionGoogleWorkspaceFile: jest.fn().mockResolvedValue(summary.workspaceFile),
    listGoogleAccounts: jest.fn().mockResolvedValue([{ id: 'account' }]),
  } as unknown as VerityClient;
}

it('shows grants and document from session details without a standalone Google or account read', () => {
  const api = client();
  const hook = renderHook(() => useSessionGoogleStatus(api, 's1', summary, true, false));
  expect(hook.result.current.status).toEqual(summary);
  for (const read of Object.values(api)) expect(read).not.toHaveBeenCalled();
});

it('refreshes compact status on live change and aborts delivery after navigation', async () => {
  const api = client();
  const hook = renderHook(
    ({ id }: { id: string }) => useSessionGoogleStatus(api, id, summary, true, true),
    {
      initialProps: { id: 's1' },
    },
  );
  const refresh = jest.mocked(subscribeLiveRefresh).mock.calls[0]![1];
  const changed = { ...summary, gmail: { ...connection, enabled: false } };
  jest.mocked(api.getSessionGoogleStatus).mockResolvedValueOnce(changed);
  await act(async () => {
    await refresh();
  });
  expect(hook.result.current.status?.gmail.enabled).toBe(false);
  expect(api.listGoogleAccounts).not.toHaveBeenCalled();
  let resolve!: (status: SessionGoogleStatus) => void;
  jest.mocked(api.getSessionGoogleStatus).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: unknown;
  act(() => {
    pending = refresh();
  });
  const signal = jest.mocked(api.getSessionGoogleStatus).mock.calls.at(-1)![1]!;
  hook.rerender({ id: 's2' });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolve(changed);
    await pending;
  });
  expect(hook.result.current.status?.gmail.enabled).toBe(true);
});

it('uses four sequential legacy status reads only after readiness, never a catalog or new watcher', async () => {
  const api = client();
  const hook = renderHook(
    ({ ready }: { ready: boolean }) => useSessionGoogleStatus(api, 'old', undefined, true, ready),
    { initialProps: { ready: false } },
  );
  expect(api.getSessionGmailConnection).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  await waitFor(() => expect(hook.result.current.status?.workspaceFile?.name).toBe('Document'));
  for (const method of [
    'getSessionGmailConnection',
    'getSessionCalendarConnection',
    'getSessionContactsConnection',
    'getSessionGoogleWorkspaceFile',
  ] as const)
    expect(api[method]).toHaveBeenCalledTimes(1);
  expect(api.listGoogleAccounts).not.toHaveBeenCalled();
  expect(subscribeLiveRefresh).not.toHaveBeenCalled();
});

it('discards a status response that started before a local grant mutation', async () => {
  const api = client();
  let resolve!: (value: SessionGoogleStatus) => void;
  jest.mocked(api.getSessionGoogleStatus).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { result } = renderHook(() => useSessionGoogleStatus(api, 's1', summary, true, true));
  let pending!: unknown;
  act(() => {
    pending = jest.mocked(subscribeLiveRefresh).mock.calls[0]![1]();
  });
  act(() => result.current.invalidate());
  await act(async () => {
    resolve({ ...summary, workspaceFile: null });
    await pending;
  });
  expect(result.current.status?.workspaceFile).not.toBeNull();
});

it('does not discover accounts until the menu opens, surfaces errors, and cancels on close', async () => {
  const api = client();
  const hook = renderHook(
    ({ open }: { open: boolean }) => useGoogleAccountAvailability(api, 's1', open),
    {
      initialProps: { open: false },
    },
  );
  expect(api.listGoogleAccounts).not.toHaveBeenCalled();
  jest.mocked(api.listGoogleAccounts).mockRejectedValueOnce(new Error('offline'));
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.error).toContain('Could not load'));
  const signal = jest.mocked(api.listGoogleAccounts).mock.calls[0]![0]!;
  hook.rerender({ open: false });
  expect(signal.aborted).toBe(true);
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.connected).toBe(true));
});

it('keeps visible link and approval reads focused and deferred, with abort on cleanup', async () => {
  const api = client();
  const read = jest.fn(async (_signal: AbortSignal) => {});
  const hook = renderHook(
    ({ ready }: { ready: boolean }) =>
      useFocusedSessionRead(api, 's1', 'linked-message-approvals', ready, read),
    { initialProps: { ready: false } },
  );
  expect(subscribeLiveRefresh).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  const [, refresh, filter, resources, options] = jest.mocked(subscribeLiveRefresh).mock.calls[0]!;
  expect(filter?.('/sessions/s1/linked-message-approvals')).toBe(true);
  expect(resources).toEqual([{ path: '/sessions/s1/linked-message-approvals' }]);
  expect(options).toEqual({ initial: true });
  await refresh();
  hook.unmount();
  expect(read.mock.calls[0]![0].aborted).toBe(true);
});

it('wires the production chat to deferred links, compact Google status and demand-only models', () => {
  const source = readFileSync(__dirname + '/../app/session/[id].tsx', 'utf8');
  expect(source).toContain('useSessionGoogleStatus(');
  expect(source).toContain('useModels(client, enginePickerOpen, projectId)');
  expect(source).toContain("'linked-message-approvals',");
  expect(source).toContain('useGoogleAccountAvailability(client, sessionId, attachMenuOpen)');
  expect(source).not.toContain('hasConnectedGoogleAccount(client, sessionId)');
});

it('stops a legacy fallback chain on navigation and isolates server identities', async () => {
  const api = client();
  let resolve!: (value: typeof connection) => void;
  jest.mocked(api.getSessionGmailConnection).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const next = client();
  const hook = renderHook(
    ({ current }: { current: VerityClient }) =>
      useSessionGoogleStatus(current, 'same-id', undefined, true, true),
    { initialProps: { current: api } },
  );
  hook.rerender({ current: next });
  await act(async () => {
    resolve(connection);
  });
  expect(api.getSessionCalendarConnection).not.toHaveBeenCalled();
  await waitFor(() => expect(next.getSessionGoogleWorkspaceFile).toHaveBeenCalledTimes(1));
});

it('does not restart compact status when detail metadata changes and invalidates mutation ownership on navigation', () => {
  const api = client();
  const hook = renderHook(
    ({ id, detail }: { id: string; detail: SessionGoogleStatus }) =>
      useSessionGoogleStatus(api, id, detail, true, true),
    { initialProps: { id: 's1', detail: summary } },
  );
  const subscriptions = jest.mocked(subscribeLiveRefresh).mock.calls.length;
  let current!: () => boolean;
  act(() => {
    current = hook.result.current.invalidate();
  });
  expect(current()).toBe(true);
  hook.rerender({ id: 's1', detail: { ...summary } });
  expect(subscribeLiveRefresh).toHaveBeenCalledTimes(subscriptions);
  hook.rerender({ id: 's2', detail: summary });
  expect(current()).toBe(false);
});
