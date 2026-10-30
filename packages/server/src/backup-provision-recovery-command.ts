import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDockerClient } from './docker.js';
import { recoverBackupProvisioning } from './self-update/backup-provision-recovery.js';
import { MANAGED_DEPLOYMENT_ROOT } from './self-update/managed-deployment.js';

const snapshot = z
  .object({
    updateId: z.string().min(1),
    generation: z.number().int().positive(),
    targetDigest: z
      .string()
      .regex(/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/),
    journalChecksum: z.string().min(1),
    deploymentChecksum: z.string().min(1),
  })
  .strict();

export async function runBackupProvisionRecoveryCommand(args: readonly string[]): Promise<void> {
  if (process.geteuid?.() !== 0) throw new Error('Backup repair must run as root');
  if (
    !(args.length === 1 && args[0] === '--check') &&
    !(args.length === 2 && args[0] === '--apply')
  )
    throw new Error('Usage: backup-provision-recovery-command --check | --apply SNAPSHOT_JSON');
  const expected = args[0] === '--apply' ? snapshot.parse(JSON.parse(args[1]!)) : undefined;
  const result = await recoverBackupProvisioning({
    managedRoot: MANAGED_DEPLOYMENT_ROOT,
    docker: createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' }),
    ...(expected === undefined ? {} : { expected }),
  });
  const { provisioned, ...reviewed } = result;
  process.stdout.write(
    `${JSON.stringify({
      snapshot: reviewed,
      provisioned,
      nextAction: provisioned
        ? 'Retry the existing update in the app'
        : 'Review the snapshot before --apply',
    })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackupProvisionRecoveryCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Backup provisioning repair failed');
    process.exitCode = 1;
  });
}
