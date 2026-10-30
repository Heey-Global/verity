import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runBackupProvisionRecoveryCommand } from './backup-provision-recovery-command.js';
import { recoverBackupProvisioning } from './self-update/backup-provision-recovery.js';
vi.mock('./self-update/backup-provision-recovery.js', () => ({
  recoverBackupProvisioning: vi.fn(),
}));
vi.mock('./docker.js', () => ({ createDockerClient: vi.fn(() => ({})) }));
const snapshot = {
  updateId: 'test',
  generation: 181,
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  journalChecksum: 'journal',
  deploymentChecksum: 'deployment',
};
beforeEach(() => {
  vi.spyOn(process, 'geteuid').mockReturnValue(0);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.mocked(recoverBackupProvisioning).mockResolvedValue({ ...snapshot, provisioned: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
it('checks by default only when explicitly requested and prints a reviewable snapshot', async () => {
  const write = vi.spyOn(process.stdout, 'write');
  await runBackupProvisionRecoveryCommand(['--check']);
  expect(recoverBackupProvisioning).toHaveBeenCalledWith(
    expect.not.objectContaining({ expected: expect.anything() }),
  );
  expect(write).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(snapshot)));
});
it('applies only the explicitly reviewed snapshot', async () => {
  await runBackupProvisionRecoveryCommand(['--apply', JSON.stringify(snapshot)]);
  expect(recoverBackupProvisioning).toHaveBeenCalledWith(
    expect.objectContaining({ expected: snapshot }),
  );
});
it.each([
  [],
  ['--apply'],
  ['--check', '--apply'],
  ['--apply', '{}'],
  ['--apply', JSON.stringify({ ...snapshot, targetDigest: 'untrusted:latest' })],
])('rejects incomplete or invalid arguments %s', async (...args) => {
  await expect(runBackupProvisionRecoveryCommand(args)).rejects.toThrow();
  expect(recoverBackupProvisioning).not.toHaveBeenCalled();
});
it('requires local root authorization before reading deployment state', async () => {
  vi.spyOn(process, 'geteuid').mockReturnValue(1000);
  await expect(runBackupProvisionRecoveryCommand(['--check'])).rejects.toThrow('root');
  expect(recoverBackupProvisioning).not.toHaveBeenCalled();
});
