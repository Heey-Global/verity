// Backup: setup with a recovery key shown once, the status page, the restore
// test and the options. The recovery key is the one secret here, so most of
// what follows checks where it goes — back to the server exactly once, never
// kept in a field, and discarded on the server when the operator walks away.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { BackupProbeJob, BackupStatus, VerityClient } from '@verity/mobile';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../components/premium/Confetti', () => ({ Confetti: () => null }));
const mockShareAsync = jest.fn<Promise<void>, [string, unknown]>();
jest.mock('../lib/sessionFileUi', () => ({
  loadSharingModule: async () => ({
    isAvailableAsync: async () => true,
    shareAsync: (uri: string, options: unknown) => mockShareAsync(uri, options),
  }),
  loadPrintModule: async () => undefined,
}));
const mockFiles: { uri: string; content: string | undefined; deleted: boolean }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri: string;
    entry: { uri: string; content: string | undefined; deleted: boolean };
    constructor(dir: string, name: string) {
      this.uri = `${dir}/${name}`;
      this.entry = { uri: this.uri, content: undefined, deleted: false };
      mockFiles.push(this.entry);
    }
    get exists() {
      return this.entry.content !== undefined && !this.entry.deleted;
    }
    write(content: string) {
      this.entry.content = content;
    }
    delete() {
      this.entry.deleted = true;
    }
  },
}));

import BackupScreen from '../app/settings/backup';
import BackupNewKeyScreen from '../app/settings/backup-new-key';
import BackupOptionsScreen from '../app/settings/backup-options';
import BackupTestScreen from '../app/settings/backup-test';
import {
  backupRowSummary,
  backupStatusRows,
  formatBackupTime,
  formatInterval,
  probePhaseText,
} from '../components/settings/backup/backupText';
import {
  mockBack,
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
} from './support/settingsHarness';

const KEY = 'verity-recovery-v1.sample-key';
const OFFER = { id: '6a5c3a52-36f1-4c39-9c51-2a1e2b0d6b7e', recoveryKey: KEY, expiresAt: 1 };
const HOUR = 3600000;

function configured(overrides: Partial<Extract<BackupStatus, { available: true }>> = {}) {
  return {
    available: true as const,
    configured: true,
    paused: false,
    intervalMs: 6 * HOUR,
    lastSuccess: Date.now() - HOUR,
    capturing: false,
    lastProbe: null,
    probe: null,
    alerts: [],
    ...overrides,
  };
}

function job(overrides: Partial<BackupProbeJob> = {}): BackupProbeJob {
  return {
    id: '0b7d6c5e-4f3a-4b2c-8d1e-9f0a1b2c3d4e',
    status: 'running',
    phase: 'database',
    startedAt: 1,
    finishedAt: null,
    snapshot: null,
    error: null,
    ...overrides,
  };
}

function backupClient(overrides: Partial<Record<keyof VerityClient, jest.Mock>> = {}) {
  const client = {
    getBackupStatus: jest.fn().mockResolvedValue(configured()),
    beginBackupSetup: jest.fn().mockResolvedValue(OFFER),
    confirmBackupSetup: jest.fn().mockResolvedValue(undefined),
    cancelBackupSetup: jest.fn().mockResolvedValue(undefined),
    beginBackupKeyReplacement: jest.fn().mockResolvedValue(OFFER),
    confirmBackupKeyReplacement: jest.fn().mockResolvedValue(undefined),
    cancelBackupKeyReplacement: jest.fn().mockResolvedValue(undefined),
    setBackupPolicy: jest.fn().mockResolvedValue(undefined),
    startBackupProbe: jest.fn().mockResolvedValue(job()),
    getBackupProbe: jest.fn().mockResolvedValue(job()),
    cancelBackupProbe: jest.fn().mockResolvedValue(job({ status: 'cancelling' })),
    ...overrides,
  };
  mockCreateVerityClient.mockReturnValue(client as unknown as VerityClient);
  return client;
}

beforeEach(() => {
  mockShareAsync.mockReset().mockResolvedValue(undefined);
  mockFiles.length = 0;
});
afterEach(() => {
  resetSettingsHarness();
  jest.useRealTimers();
});

describe('backup setup', () => {
  it('shows the key once and confirms exactly the offered key', async () => {
    const client = backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: true, configured: false, alerts: [] }),
    });
    render(<BackupScreen />);
    expect(await screen.findByText('Stored on this server')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Set up backup'));
    expect(await screen.findByText(KEY)).toBeOnTheScreen();
    expect(screen.queryByText(/QR code/)).toBeNull();
    client.getBackupStatus.mockResolvedValue(configured({ lastSuccess: null, capturing: true }));
    fireEvent.press(screen.getByText('I saved it, turn on backup'));
    expect(await screen.findByText('Backup activated')).toBeOnTheScreen();
    expect(client.confirmBackupSetup).toHaveBeenCalledWith(OFFER);
    expect(await screen.findByText('First backup running')).toBeOnTheScreen();
    expect(screen.queryByText(KEY)).toBeNull();
    fireEvent.press(screen.getByText('Done'));
    expect(await screen.findByText('Last backup')).toBeOnTheScreen();
    expect(client.cancelBackupSetup).not.toHaveBeenCalled();
  });

  it('discards an unconfirmed key on the server when the operator leaves', async () => {
    const client = backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: true, configured: false, alerts: [] }),
    });
    const { unmount } = render(<BackupScreen />);
    fireEvent.press(await screen.findByText('Set up backup'));
    await screen.findByText(KEY);
    unmount();
    expect(client.cancelBackupSetup).toHaveBeenCalledTimes(1);
  });

  it('discards a key that arrives after the operator left', async () => {
    let resolve!: (offer: typeof OFFER) => void;
    const client = backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: true, configured: false, alerts: [] }),
      beginBackupSetup: jest.fn(() => new Promise((done) => (resolve = done))),
    });
    const { unmount } = render(<BackupScreen />);
    fireEvent.press(await screen.findByText('Set up backup'));
    unmount();
    await act(async () => resolve(OFFER));
    expect(client.cancelBackupSetup).toHaveBeenCalledTimes(1);
  });

  it('never cancels a key whose confirmation is already on its way', async () => {
    const client = backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: true, configured: false, alerts: [] }),
      confirmBackupSetup: jest.fn(() => new Promise(() => undefined)),
    });
    const { unmount } = render(<BackupScreen />);
    fireEvent.press(await screen.findByText('Set up backup'));
    fireEvent.press(await screen.findByText('I saved it, turn on backup'));
    unmount();
    expect(client.confirmBackupSetup).toHaveBeenCalledWith(OFFER);
    expect(client.cancelBackupSetup).not.toHaveBeenCalled();
  });

  it('saves the key through the share sheet and removes the temporary file', async () => {
    backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: true, configured: false, alerts: [] }),
    });
    render(<BackupScreen />);
    fireEvent.press(await screen.findByText('Set up backup'));
    fireEvent.press(await screen.findByText('Save'));
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalled());
    expect(mockShareAsync.mock.calls[0]?.[0]).toBe('file:///cache/verity-recovery-key.txt');
    expect(mockFiles[0]?.content).toContain(KEY);
    await waitFor(() => expect(mockFiles[0]?.deleted).toBe(true));
  });

  it('explains a Server that needs the installer once more', async () => {
    backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue({ available: false, reason: 'installer-required' }),
    });
    render(<BackupScreen />);
    expect(await screen.findByText('One-time server step needed')).toBeOnTheScreen();
    expect(screen.queryByText('Set up backup')).toBeNull();
  });
});

describe('backup status', () => {
  it('names each problem and offers a restore test when one is overdue', async () => {
    backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue(configured({ alerts: ['insufficient-space', 'probe-overdue'] })),
    });
    render(<BackupScreen />);
    expect(await screen.findByText('Not enough space')).toBeOnTheScreen();
    expect(screen.getByText('Not tested recently')).toBeOnTheScreen();
    fireEvent.press(screen.getAllByText('Test restore')[0]!);
    expect(mockPush).toHaveBeenCalledWith('/settings/backup-test');
    fireEvent.press(screen.getByText('Options'));
    expect(mockPush).toHaveBeenLastCalledWith('/settings/backup-options');
  });

  it('describes the first backup and the row summary consistently', () => {
    const now = new Date(2026, 9, 29, 14, 3).getTime();
    const first = configured({ lastSuccess: null, capturing: true });
    expect(backupStatusRows(first, now).map((row) => row.value)).toEqual([
      'Running',
      'Running now',
      'Not tested',
    ]);
    expect(backupRowSummary(first, now)).toEqual({
      subtitle: 'First backup running',
      status: { intent: 'ready', label: 'On' },
    });
    expect(backupRowSummary(configured({ paused: true }), now).status.label).toBe('Paused');
    expect(formatBackupTime(now - HOUR, now)).toMatch(/^Today /);
    expect(formatBackupTime(now - 24 * HOUR, now)).toMatch(/^Yesterday /);
    expect(
      backupStatusRows(configured({ lastSuccess: now - HOUR, intervalMs: 24 * HOUR }), now)[1]
        ?.value,
    ).toMatch(/^About tomorrow /);
    expect(probePhaseText('database')).toEqual({
      title: 'Checking the database',
      step: 'Step 6 of 8',
    });
    expect(probePhaseText('future-phase').title).toBe('Checking the backup');
    expect(formatInterval(6 * HOUR)).toBe('Every 6 h');
    expect(formatInterval(24 * HOUR, 'long')).toBe('once a day');
  });
});

describe('restore test', () => {
  it('sends the pasted key once, clears the field and can cancel the running test', async () => {
    const client = backupClient();
    render(<BackupTestScreen />);
    const field = await screen.findByPlaceholderText('Paste your recovery key');
    fireEvent.changeText(field, `  ${KEY}  `);
    fireEvent.press(screen.getByText('Test restore'));
    expect(await screen.findByText('Checking the database')).toBeOnTheScreen();
    expect(client.startBackupProbe).toHaveBeenCalledWith(KEY);
    expect(screen.queryByPlaceholderText('Paste your recovery key')).toBeNull();
    fireEvent.press(screen.getByText('Cancel test'));
    await waitFor(() => expect(client.cancelBackupProbe).toHaveBeenCalledWith(job().id));
  });

  it('explains a failed test', async () => {
    backupClient({
      getBackupStatus: jest
        .fn()
        .mockResolvedValue(configured({ probe: job({ status: 'failed', error: 'probe-failed' }) })),
    });
    render(<BackupTestScreen />);
    expect(await screen.findByText('Test failed')).toBeOnTheScreen();
  });
});

describe('backup options', () => {
  it('saves a new interval and pauses backups', async () => {
    const client = backupClient();
    render(<BackupOptionsScreen />);
    fireEvent.press(await screen.findByText('How often'));
    fireEvent.press(await screen.findByText('Every 12 hours'));
    await waitFor(() =>
      expect(client.setBackupPolicy).toHaveBeenCalledWith({ intervalMs: 12 * HOUR }),
    );
    fireEvent(screen.getByRole('switch'), 'valueChange', true);
    await waitFor(() => expect(client.setBackupPolicy).toHaveBeenLastCalledWith({ paused: true }));
  });

  it('explains what a new key means before creating it', async () => {
    backupClient();
    render(<BackupOptionsScreen />);
    fireEvent.press(await screen.findByText('Create new recovery key'));
    expect(await screen.findByText('Older backups are kept')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Create new key'));
    expect(mockPush).toHaveBeenCalledWith('/settings/backup-new-key');
  });
});

describe('new recovery key', () => {
  it('asks for one key per visit and confirms it', async () => {
    const client = backupClient();
    render(<BackupNewKeyScreen />);
    expect(await screen.findByText(KEY)).toBeOnTheScreen();
    fireEvent.press(screen.getByText('I saved it, use the new key'));
    expect(await screen.findByText('New key is active')).toBeOnTheScreen();
    expect(client.beginBackupKeyReplacement).toHaveBeenCalledTimes(1);
    expect(client.confirmBackupKeyReplacement).toHaveBeenCalledWith(OFFER);
    fireEvent.press(screen.getByText('Done'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('keeps the current key when the operator leaves without confirming', async () => {
    const client = backupClient();
    const { unmount } = render(<BackupNewKeyScreen />);
    await screen.findByText(KEY);
    await act(async () => undefined);
    unmount();
    expect(client.cancelBackupKeyReplacement).toHaveBeenCalledTimes(1);
    expect(client.confirmBackupKeyReplacement).not.toHaveBeenCalled();
  });
});
