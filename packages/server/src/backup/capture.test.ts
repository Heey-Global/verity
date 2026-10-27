import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { captureInstallation } from './capture.js';
import { writeBackupIdentityFixture } from './testing.js';
import { probeSnapshot, type BackupProbeOptions } from './probe.js';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { BackupRepository, readSnapshot } from './repository.js';
import { BackupLifecycleCoordinator } from './lifecycle.js';
import { stageSnapshot } from './staging.js';
import { prepareRestoredGit } from './restore-git.js';
const exec = promisify(execFile);
const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
describe.skipIf(!adminUrl)('integrated capture components with PostgreSQL', () => {
  it('captures paused and active project files plus frozen Git, identity and one DB snapshot; restores without source or index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-capture-roundtrip-'));
    const name = 'verity_capture_' + randomBytes(16).toString('hex');
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const database = new pg.Pool({ connectionString: url.toString(), max: 1 });
    let destination: BackupDestination | undefined;
    try {
      await database.query(
        "CREATE TABLE test_data(id integer PRIMARY KEY, value text); INSERT INTO test_data VALUES (1,'snapshot-data')",
      );
      const source = join(root, 'original');
      const project = join(source, 'workspaces', 'project');
      await mkdir(project, { recursive: true });
      await mkdir(join(source, 'workspaces', 'paused'));
      await mkdir(join(source, 'sessions'));
      await mkdir(join(source, 'knowledge'));
      await mkdir(join(root, 'backup'));
      await mkdir(join(root, 'staging'));
      const targetId = randomUUID();
      await writeFile(join(root, 'backup', '.verity-backup-target'), targetId);
      destination = await BackupDestination.open(join(root, 'backup'), targetId);
      await writeFile(join(source, 'workspaces', 'paused', 'keep'), 'paused-file');
      await writeFile(join(source, 'knowledge', 'insight.md'), 'durable knowledge');
      await writeFile(join(project, 'file'), 'local history');
      const env = {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      };
      await exec('git', ['init', project], { env });
      await exec('git', ['-C', project, 'add', '.'], { env });
      await exec('git', ['-C', project, 'commit', '-m', 'initial'], { env });
      await exec(
        'git',
        ['-C', project, 'worktree', 'add', '-b', 'session', join(project, 'session')],
        { env },
      );
      await writeFile(join(project, '.env'), 'uncommitted private value');
      const { host, recoveryKey } = await generateBackupKeys();
      const identityFixture = join(root, 'identity-fixture');
      const installationId = randomUUID();
      await writeBackupIdentityFixture(identityFixture, host, installationId);
      await writeFile(
        join(identityFixture, 'identity', 'tls-ca-key.pem'),
        'must never be read directly',
      );
      const repositoryName = `${installationId}-r1`;
      const repository = new BackupRepository(
        join(root, 'backup'),
        join(root, 'host-state'),
        repositoryName,
        host,
        destination,
      );
      await repository.initialize();
      const repoKey = randomUUID();
      const manifest = await captureInstallation({
        root: source,
        identityRoot: join(identityFixture, 'identity'),
        caCiphertext: join(identityFixture, 'ca.age'),
        installationId,
        keyGeneration: 1,
        image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        release: 'v1',
        schema: '0001_initial',
        architecture: 'amd64',
        kind: 'manual',
        connect: () => database.connect(),
        repository,
        destination,
        lifecycle: new BackupLifecycleCoordinator(),
        signal: new AbortController().signal,
        inventory: async (client) => {
          expect((await client.query('SELECT value FROM test_data')).rows[0].value).toBe(
            'snapshot-data',
          );
          return {
            activeTurns: ['session-active'],
            projects: [
              {
                id: 'project',
                state: 'active',
                archived: false,
                paths: ['workspaces/project'],
                warnings: [],
              },
              {
                id: 'paused',
                state: 'absent',
                archived: true,
                paths: ['workspaces/paused'],
                warnings: [],
              },
            ],
          };
        },
        repoKey: async () => repoKey,
      });
      expect(manifest.capture!.git[0]!.status).toBe('validated');
      expect(manifest.capture!.projects[1]!.bytes).toBe('11');
      expect(manifest.capture!.activeTurns).toEqual(['session-active']);
      expect(manifest.files.some((file) => file.path.includes('tls-ca-key.pem'))).toBe(false);
      expect(manifest.files.some((file) => file.path.startsWith('workspaces/project/.git/'))).toBe(
        false,
      );
      expect(manifest.files.some((file) => file.path === `git/${repoKey}/git/HEAD`)).toBe(true);
      await rm(source, { recursive: true });
      await rm(identityFixture, { recursive: true });
      await rm(join(root, 'host-state'), { recursive: true });
      const verified = await readSnapshot(
        join(root, 'backup', 'repositories'),
        repositoryName,
        manifest.sequence,
        recoveryKey,
      );
      const restored = await stageSnapshot(
        join(root, 'staging'),
        join(root, 'backup', 'repositories'),
        verified,
        recoveryKey,
      );
      expect(await readFile(join(restored, 'workspaces/project/.env'), 'utf8')).toBe(
        'uncommitted private value',
      );
      expect(await readFile(join(restored, 'workspaces/paused/keep'), 'utf8')).toBe('paused-file');
      expect(await readFile(join(restored, 'knowledge/insight.md'), 'utf8')).toBe(
        'durable knowledge',
      );
      expect(await prepareRestoredGit(restored, verified.capture!)).toEqual([]);
      const gitPointer = await readFile(join(restored, 'workspaces/project/session/.git'), 'utf8');
      expect(gitPointer).toContain(restored);
      expect(gitPointer).not.toContain(source);
      expect(
        (
          await exec(
            'git',
            ['-C', join(restored, 'workspaces/project/session'), 'show', 'HEAD:file'],
            { env },
          )
        ).stdout,
      ).toBe('local history');
      const probeName = 'verity_probe_' + randomBytes(16).toString('hex');
      const probeUrl = new URL(adminUrl!);
      probeUrl.pathname = '/' + probeName;
      const probeOptions: BackupProbeOptions = {
        backupRoot: join(root, 'backup'),
        repository: repositoryName,
        sequence: manifest.sequence,
        kind: 'manual',
        recoveryKey,
        stagingParent: join(root, 'staging'),
        architecture: 'amd64',
        checkRelease: async (snapshot, architecture) => {
          expect(snapshot.schema).toBe('0001_initial');
          expect(snapshot.capture!.architecture).toBe(architecture);
        },
        withDatabase: async (_snapshot, bytes, run) => {
          expect(bytes).toBeGreaterThan(0n);
          await admin.query(`CREATE DATABASE "${probeName}"`);
          const probe = new pg.Pool({ connectionString: probeUrl.toString(), max: 1 });
          try {
            await probe.query('CREATE TABLE test_data(id integer PRIMARY KEY, value text)');
            const client = await probe.connect();
            try {
              await run(client);
              expect((await client.query('SELECT value FROM test_data')).rows[0].value).toBe(
                'snapshot-data',
              );
            } finally {
              client.release();
            }
          } finally {
            await probe.end();
            await admin.query(`DROP DATABASE "${probeName}" WITH (FORCE)`);
          }
        },
      };
      const report = await probeSnapshot(probeOptions);
      expect(report.deploymentId).toBe('deployment-fixture');
      expect(report.files).toBe(manifest.files.length);
      expect(report.warnings).toEqual([]);
      const before = await readdir(join(root, 'staging'));
      await expect(
        probeSnapshot({
          ...probeOptions,
          checkRelease: () => Promise.reject(new Error('unsupported image')),
        }),
      ).rejects.toThrow('unsupported image');
      expect(await readdir(join(root, 'staging'))).toEqual(before);
      await expect(
        probeSnapshot({ ...probeOptions, withDatabase: () => Promise.resolve() }),
      ).rejects.toThrow('database import did not complete');
      expect(await readdir(join(root, 'staging'))).toEqual(before);
    } finally {
      await destination?.close();
      await database.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
