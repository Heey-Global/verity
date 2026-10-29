import { randomUUID, randomBytes, createHash } from 'node:crypto';
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
import { decodeRecoveryKey, generateBackupKeys } from './crypto.js';
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
      // Preserve objects reachable only from the index, stash or reflog, not just HEAD.
      await writeFile(join(project, 'stashed'), 'stash-only-content');
      await exec('git', ['-C', project, 'add', 'stashed'], { env });
      await exec('git', ['-C', project, 'stash', 'push', '-m', 'security fixture'], { env });
      await writeFile(join(project, 'reflog-only'), 'reflog-only-content');
      await exec('git', ['-C', project, 'add', 'reflog-only'], { env });
      await exec('git', ['-C', project, 'commit', '-m', 'reflog-only'], { env });
      const reflogCommit = (
        await exec('git', ['-C', project, 'rev-parse', 'HEAD'], { env })
      ).stdout.trim();
      await exec('git', ['-C', project, 'reset', '--hard', 'HEAD~1'], { env });
      await writeFile(join(project, 'index-only'), 'index-only-content');
      await exec('git', ['-C', project, 'add', 'index-only'], { env });
      await rm(join(project, 'index-only'));
      const hostileMarker = join(root, 'hostile-git-executed');
      await exec('git', ['-C', project, 'config', 'extensions.worktreeConfig', 'true'], { env });
      const include = join(root, 'hostile-include');
      await writeFile(include, '[invalid unterminated section\n');
      const hostile = `[core]\nfsmonitor = touch ${hostileMarker}\n[include]\npath = ${include}\n[credential]\nhelper = !touch ${hostileMarker}\n`;
      const originalConfig = await readFile(join(project, '.git/config'), 'utf8');
      await writeFile(join(project, '.git/config'), originalConfig + hostile);
      await writeFile(join(project, '.git/config.worktree'), hostile);
      await writeFile(join(project, '.git/worktrees/session/config.worktree'), hostile);
      for (const hooks of ['.git/hooks', '.git/worktrees/session/hooks']) {
        await mkdir(join(project, hooks), { recursive: true });
        await writeFile(
          join(project, hooks, 'post-checkout'),
          `#!/bin/sh\ntouch ${hostileMarker}\n`,
          { mode: 0o755 },
        );
      }

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
      // Inspect the evidence before restoring safe config for our own ordinary Git queries.
      await expect(readFile(hostileMarker)).rejects.toThrow();
      const restoredProject = join(restored, 'workspaces/project');
      expect(await readFile(join(restoredProject, '.git/config.worktree'), 'utf8')).toBe(hostile);
      expect(
        await readFile(join(restoredProject, '.git/worktrees/session/config.worktree'), 'utf8'),
      ).toBe(hostile);
      await writeFile(join(restoredProject, '.git/config'), originalConfig);
      await rm(join(restoredProject, '.git/config.worktree'));
      await rm(join(restoredProject, '.git/worktrees/session/config.worktree'));
      await rm(join(restoredProject, '.git/hooks'), { recursive: true });
      await rm(join(restoredProject, '.git/worktrees/session/hooks'), { recursive: true });
      for (const [object, content] of [
        [':index-only', 'index-only-content'],
        ['stash@{0}:stashed', 'stash-only-content'],
        [`${reflogCommit}:reflog-only`, 'reflog-only-content'],
      ])
        expect((await exec('git', ['-C', restoredProject, 'show', object!], { env })).stdout).toBe(
          content,
        );
      expect(
        (await exec('git', ['-C', restoredProject, 'reflog', 'show', '--all'], { env })).stdout,
      ).toContain('reflog-only');

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
      async function assertNoRecoveryFiles(path = root): Promise<void> {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) await assertNoRecoveryFiles(file);
          else if (entry.isFile()) {
            const bytes = await readFile(file);
            for (const secret of [recoveryKey, decodeRecoveryKey(recoveryKey).identity])
              expect(bytes.includes(Buffer.from(secret)), file).toBe(false);
          }
        }
      }
      const probeOptions: BackupProbeOptions = {
        phase: async () => assertNoRecoveryFiles(),
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
            await admin.query(`DROP DATABASE "${probeName}"`);
          }
        },
      };
      const report = await probeSnapshot(probeOptions);
      expect(report.deploymentId).toBe('deployment-fixture');
      expect(report.files).toBe(manifest.files.length);
      expect(report.warnings).toEqual([]);
      await assertNoRecoveryFiles();
      const before = await readdir(join(root, 'staging'));
      await expect(
        probeSnapshot({
          ...probeOptions,
          checkRelease: () => Promise.reject(new Error('unsupported image')),
        }),
      ).rejects.toThrow('unsupported image');
      expect(await readdir(join(root, 'staging'))).toEqual(before);
      await assertNoRecoveryFiles();
      await expect(
        probeSnapshot({ ...probeOptions, withDatabase: () => Promise.resolve() }),
      ).rejects.toThrow('database import did not complete');
      expect(await readdir(join(root, 'staging'))).toEqual(before);
      await assertNoRecoveryFiles();
    } finally {
      await destination?.close();
      await database.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.skipIf(!adminUrl)(
  'records the actual lifecycle barrier for a bounded Git dataset without reflinks',
  async () => {
    const parent = join(process.cwd(), '.cache');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'capture-measurement-'));
    const name = 'verity_measure_' + randomBytes(12).toString('hex');
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const database = new pg.Pool({ connectionString: url.toString(), max: 1 });
    let destination: BackupDestination | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      await database.query(
        'CREATE TABLE fixture(id integer PRIMARY KEY); INSERT INTO fixture VALUES (1)',
      );
      const source = join(root, 'source');
      const project = join(source, 'workspaces/project');
      await mkdir(project, { recursive: true });
      for (const scope of ['sessions', 'knowledge']) await mkdir(join(source, scope));
      // Incompressible content exercises a real Git object copy, not a sparse or reflink fixture.
      await writeFile(
        join(project, 'dataset'),
        createHash('shake256', { outputLength: 16 * 1024 * 1024 })
          .update('backup-freeze-measurement-v1')
          .digest(),
      );
      await exec('git', ['init', project]);
      await exec('git', ['-C', project, 'add', '.']);
      await exec('git', [
        '-C',
        project,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'fixture',
      ]);
      const { host } = await generateBackupKeys();
      const installationId = randomUUID();
      const identity = join(root, 'identity-fixture');
      await writeBackupIdentityFixture(identity, host, installationId);
      const backup = join(root, 'backup');
      await mkdir(backup);
      const targetId = randomUUID();
      await writeFile(join(backup, '.verity-backup-target'), targetId);
      destination = await BackupDestination.open(backup, targetId);
      const repository = new BackupRepository(
        backup,
        join(root, 'state'),
        `${installationId}-r1`,
        host,
        destination,
      );
      await repository.initialize();
      const started = performance.now();
      const cpu = process.cpuUsage();
      const manifest = await captureInstallation({
        root: source,
        identityRoot: join(identity, 'identity'),
        caCiphertext: join(identity, 'ca.age'),
        installationId,
        keyGeneration: 1,
        image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        release: 'measurement',
        schema: '0001_fixture',
        architecture: 'amd64',
        kind: 'manual',
        connect: () => database.connect(),
        repository,
        destination,
        lifecycle: new BackupLifecycleCoordinator(),
        signal: new AbortController().signal,
        inventory: async () => ({
          activeTurns: [],
          projects: [
            {
              id: 'project',
              state: 'active',
              archived: false,
              paths: ['workspaces/project'],
              warnings: [],
            },
          ],
        }),
        repoKey: async () => installationId,
      });
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      expect(manifest.capture!.git[0]!.status).toBe('validated');
      expect(manifest.capture!.barrierMs).toBeGreaterThan(0);
      expect(manifest.capture!.barrierMs).toBeLessThanOrEqual(elapsedMs);
      expect(BigInt(manifest.capture!.projects[0]!.bytes)).toBeGreaterThanOrEqual(
        16n * 1024n * 1024n,
      );
      const report = {
        datasetBytes: 16 * 1024 * 1024,
        gitRepositories: 1,
        copyMethod:
          'freezeGitDirectory streams through file descriptors; no reflink/copy_file_range',
        barrierMs: manifest.capture!.barrierMs,
        elapsedMs,
        cpuMicros: used.user + used.system,
        maxRssKiB: process.resourceUsage().maxRSS,
        performanceAcceptance: false,
      };
      if (process.env.VERITY_BACKUP_FREEZE_REPORT)
        await writeFile(
          process.env.VERITY_BACKUP_FREEZE_REPORT,
          JSON.stringify(report, null, 2) + '\n',
        );
    } finally {
      await destination?.close();
      await database.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
