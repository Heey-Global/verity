import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readInstallerRestoreRequest } from './restore-installer-protocol.js';

const config = {
  action: 'begin',
  root: '/etc/verity/restore',
  hostRoot: '/etc/verity',
  previousComposeProject: 'verity',
  tufCachePath: '/etc/verity/restore/tuf',
  backupDirectory: '/backups',
  addresses: [],
  selection: {
    source: '/copied backup',
    repository: randomUUID() + '-r1',
    sequence: 1,
    kind: 'manual',
    newIdentity: false,
  },
};
async function* input(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}
it('requires an explicit selection and a bounded stdin-only credential envelope without echoing invalid input', async () => {
  const body = {
    configuration: config,
    recoveryKey: 'private-recovery-key',
    masterPassword: 'private-master-password',
  };
  await expect(readInstallerRestoreRequest(input(body))).resolves.toMatchObject(body);
  for (const configuration of [
    { ...config, selection: undefined },
    { ...config, action: 'review' },
    { ...config, root: '/etc/../other' },
    { ...config, secretAlias: 'invented' },
  ])
    await expect(readInstallerRestoreRequest(input({ ...body, configuration }))).rejects.toThrow(
      /^Invalid installer restore request$/,
    );
  await expect(
    readInstallerRestoreRequest(input({ ...body, recoveryKey: 's'.repeat(65537) })),
  ).rejects.toThrow(/^Invalid installer restore request$/);
  await expect(
    readInstallerRestoreRequest(
      input({
        ...body,
        configuration: { ...config, action: 'review', jobId: randomUUID(), keepIds: [] },
      }),
    ),
  ).resolves.toMatchObject({ configuration: { keepIds: [] } });
});
