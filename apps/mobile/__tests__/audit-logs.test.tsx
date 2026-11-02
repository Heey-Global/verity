import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AuditOperationSummary } from '@verity/mobile';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import AuditLogsScreen from '../app/settings/audit-logs/index';
import AuditOperationScreen from '../app/settings/audit-logs/[operationId]';
import { auditStatus, auditTitle, groupAuditByDay } from '../lib/auditLabels';
import {
  makeClient,
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
  refocus,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const NOW = new Date('2026-10-27T15:00:00');

function op(overrides: Partial<AuditOperationSummary> = {}): AuditOperationSummary {
  return {
    operationId: 'op-1',
    kind: 'build',
    status: 'succeeded',
    startedAt: new Date('2026-10-27T14:12:00').toISOString(),
    finishedAt: new Date('2026-10-27T14:19:00').toISOString(),
    project: { id: 'p1', label: 'org/repo' },
    initiator: { kind: 'session', sessionId: 's1', name: 'Fix login' },
    imageId: 'sha256:3f9a',
    failedWrites: null,
    ...overrides,
  };
}

describe('audit labels', () => {
  // A finished build in its normal outcome reads as a fact and carries no word;
  // only deviations do, so problems stand out in a long list.
  it('words outcomes so only deviations carry a status', () => {
    expect(auditTitle(op())).toBe('Project image built');
    expect(auditStatus(op())).toBeUndefined();
    expect(auditTitle(op({ status: 'failed' }))).toBe('Project image build');
    expect(auditStatus(op({ status: 'failed' }))).toEqual({
      intent: 'needsSetup',
      label: 'Failed',
    });
    expect(auditStatus(op({ status: 'unknown' }))?.intent).toBe('unknown');
    expect(auditTitle(op({ kind: 'write_gap', failedWrites: 1 }))).toBe('1 event not recorded');
  });

  it('groups by local day, newest first', () => {
    const groups = groupAuditByDay(
      [
        op({ operationId: 'a' }),
        op({ operationId: 'b', startedAt: new Date('2026-10-26T23:40:00').toISOString() }),
        op({ operationId: 'c', startedAt: new Date('2026-10-20T08:00:00').toISOString() }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.title.length > 0, g.operations.map((o) => o.operationId)])).toEqual(
      [
        [true, ['a']],
        [true, ['b']],
        [true, ['c']],
      ],
    );
    expect(groups.slice(0, 2).map((g) => g.title)).toEqual(['Today', 'Yesterday']);
  });
});

describe('audit logs screen', () => {
  const event = (kind: string, eventId: string, minutes: number) => ({
    eventId,
    operationId: 'op-1',
    kind,
    domain: 'builds',
    recordedAt: new Date(Date.now() - minutes * 60000).toISOString(),
    project: { id: 'p1', label: 'org/repo' },
    imageId: null,
    payload: {},
  });
  it('shows each event of one build and opens details without collapsing rows', async () => {
    const auditEvents = jest.fn().mockResolvedValue({
      events: [event('build.failed', 'end', 1), event('build.requested', 'start', 5)],
      nextBefore: null,
      oldestRecordedAt: null,
    });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditEvents }));
    render(<AuditLogsScreen />);
    expect(await screen.findByText('Image build failed')).toBeOnTheScreen();
    expect(screen.getByText('Image build requested')).toBeOnTheScreen();
    expect(screen.getByText('Failed')).toBeOnTheScreen();
    expect(screen.getAllByText('Output')).toHaveLength(1);
    fireEvent.press(screen.getByText('Image build failed'));
    expect(await screen.findByText(/"eventId": "end"/)).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Open operation and build output'));
    expect(mockPush).toHaveBeenCalledWith('/settings/audit-logs/op-1');
  });
  it('preserves earlier event pages on return and filters the event query', async () => {
    const auditEvents = jest
      .fn()
      .mockResolvedValueOnce({
        events: [event('build.failed', 'end', 1)],
        nextBefore: 'cursor',
        oldestRecordedAt: null,
      })
      .mockResolvedValue({
        events: [event('build.requested', 'start', 5)],
        nextBefore: null,
        oldestRecordedAt: null,
      });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditEvents }));
    render(<AuditLogsScreen />);
    const older = await screen.findByText('Show older entries');
    act(() => {
      fireEvent.press(older);
      fireEvent.press(older);
    });
    expect(await screen.findByText('Image build requested')).toBeOnTheScreen();
    await act(async () => refocus());
    expect(auditEvents).toHaveBeenCalledTimes(2);
    expect(auditEvents).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor' }));
    fireEvent.press(screen.getByText('Builds'));
    await waitFor(() =>
      expect(auditEvents).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'builds' })),
    );
    fireEvent.changeText(screen.getByLabelText('Search logs'), 'org/repo');
    await waitFor(() =>
      expect(auditEvents).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'org/repo' })),
    );
  });
  it('explains administrator-only availability', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<AuditLogsScreen />);
    expect(await screen.findByText(/Audit logs unavailable/)).toBeOnTheScreen();
  });
});

describe('audit operation screen', () => {
  // A slow initial read must not replace the result of a newer focus refresh,
  // whether it eventually resolves or rejects.
  it.each(['resolve', 'reject'] as const)(
    'ignores an older request that later %ss',
    async (outcome) => {
      setSearchParams({ operationId: 'op-1' });
      const detail = {
        ...op(),
        server: { release: '4.57.3', generation: 14 },
        build: null,
        imageRef: null,
        gapWindow: null,
        events: [],
      };
      let resolveOld!: (value: typeof detail) => void;
      let rejectOld!: (error: Error) => void;
      const old = new Promise<typeof detail>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const auditOperation = jest.fn().mockReturnValueOnce(old).mockResolvedValue(detail);
      mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditOperation }));
      render(<AuditOperationScreen />);
      await act(async () => refocus());
      expect(await screen.findByText('Succeeded')).toBeOnTheScreen();
      await act(async () => {
        if (outcome === 'resolve') resolveOld({ ...detail, status: 'running' });
        else rejectOld(new Error('Obsolete request failed'));
      });
      expect(screen.getByText('Succeeded')).toBeOnTheScreen();
      expect(screen.queryByText('Running')).toBeNull();
      expect(screen.queryByText('Obsolete request failed')).toBeNull();
    },
  );

  it('shows who started a build, its source and result', async () => {
    setSearchParams({ operationId: 'op-1' });
    const auditOperation = jest.fn().mockResolvedValue({
      ...op(),
      server: { release: '4.57.3', generation: 14 },
      build: {
        imageTag: 'verity-devc-org-repo:abc',
        forceRebuild: false,
        commit: '9c1e4a7d00',
        baseImageRef: 'verity-sandbox:4.57.0',
        baseImageDigest: null,
        features: ['ghcr.io/devcontainers/features/node:1'],
        sizeBytes: 11_700_000_000,
        durationMs: 420_000,
      },
      imageRef: null,
      gapWindow: null,
      events: [],
    });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditOperation }));
    render(<AuditOperationScreen />);
    expect(await screen.findByText('Succeeded')).toBeOnTheScreen();
    expect(auditOperation).toHaveBeenCalledWith('op-1');
    expect(screen.getByText('Fix login')).toBeOnTheScreen();
    expect(screen.getByText('9c1e4a7')).toBeOnTheScreen();
    expect(screen.getByText(/11\.7 GB/)).toBeOnTheScreen();
    expect(screen.getByText('4.57.3 · generation 14')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Fix login'));
    expect(mockPush).toHaveBeenCalledWith('/session/s1');
    // Returning from the linked session must refresh an outcome that changed there.
    auditOperation.mockResolvedValue({
      ...op({ status: 'failed' }),
      server: { release: '4.57.3', generation: 14 },
      build: null,
      imageRef: null,
      gapWindow: null,
      events: [],
    });
    await act(async () => refocus());
    expect(await screen.findByText('Failed')).toBeOnTheScreen();
    expect(auditOperation).toHaveBeenCalledTimes(2);
  });
});
