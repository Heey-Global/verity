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
  it('lists operations and opens one', async () => {
    const auditOperations = jest.fn().mockResolvedValue({
      operations: [
        op(),
        op({
          operationId: 'op-2',
          status: 'failed',
          initiator: { kind: 'system', trigger: 'sandbox_wake' },
        }),
      ],
      nextBefore: null,
      oldestRecordedAt: '2026-04-30T00:00:00.000Z',
    });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditOperations }));
    render(<AuditLogsScreen />);
    expect(await screen.findByText('Project image built')).toBeOnTheScreen();
    expect(screen.getByText(/org\/repo · Session “Fix login”/)).toBeOnTheScreen();
    expect(screen.getByText(/Sandbox wake/)).toBeOnTheScreen();
    expect(screen.getByText('Failed')).toBeOnTheScreen();
    expect(screen.getByText(/^Entries since/)).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Project image built'));
    expect(mockPush).toHaveBeenCalledWith('/settings/audit-logs/op-1');
  });

  // Returning from an older entry must preserve the pages already loaded.
  it('keeps older pages when returning from an entry', async () => {
    const auditOperations = jest
      .fn()
      .mockResolvedValueOnce({ operations: [op()], nextBefore: 'cursor', oldestRecordedAt: null })
      .mockResolvedValueOnce({
        operations: [op({ operationId: 'older', status: 'failed' })],
        nextBefore: null,
        oldestRecordedAt: null,
      });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditOperations }));
    render(<AuditLogsScreen />);
    fireEvent.press(await screen.findByText('Show older entries'));
    expect(await screen.findByText('Failed')).toBeOnTheScreen();
    await act(async () => refocus());
    expect(auditOperations).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Failed')).toBeOnTheScreen();
  });

  it('filters by area and searches', async () => {
    const auditOperations = jest
      .fn()
      .mockResolvedValue({ operations: [], nextBefore: null, oldestRecordedAt: null });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { auditOperations }));
    render(<AuditLogsScreen />);
    expect(await screen.findByText('No entries yet.')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Builds'));
    await waitFor(() => expect(auditOperations).toHaveBeenLastCalledWith({ domain: 'builds' }));
    jest.useFakeTimers();
    fireEvent.changeText(screen.getByLabelText('Search image, project or ID'), '3f9a');
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    jest.useRealTimers();
    await waitFor(() =>
      expect(auditOperations).toHaveBeenLastCalledWith({ domain: 'builds', search: '3f9a' }),
    );
    expect(await screen.findByText('No matching entries.')).toBeOnTheScreen();
  });

  it('explains when this device may not read audit logs', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<AuditLogsScreen />);
    expect(await screen.findByText('Audit logs unavailable')).toBeOnTheScreen();
  });
});

describe('audit operation screen', () => {
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
