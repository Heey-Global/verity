import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { canonicalizeRestoreDatabase } from './restore-canonical-database.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';

const fake = vi.hoisted(() => ({
  query:
    vi.fn<
      (url: URL, text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
    >(),
  recheck: vi.fn(),
  connected: [] as string[],
}));
vi.mock('./restore-final-review.js', () => ({ recheckRestoreDevices: fake.recheck }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      private url: URL;
      constructor(options: { connectionString: string }) {
        this.url = new URL(options.connectionString);
        fake.connected.push(this.url.username + this.url.pathname);
      }
      query(text: string, values?: unknown[]) {
        return fake.query(this.url, text, values);
      }
      async connect() {
        return this;
      }
      release() {}
      async end() {}
      on() {}
    },
  },
}));

it('resumes after database rename without guessing ownership and reauthenticates the canonical target', async () => {
  fake.connected.length = 0;
  fake.recheck.mockReset().mockResolvedValue([]);
  const root = await mkdtemp(join(tmpdir(), 'restore-canonical-'));
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: {
      source: '/backup',
      repository: randomUUID() + '-r1',
      sequence: 1,
      kind: 'manual',
      newIdentity: false,
    },
    verified: {
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'deployment',
      sourceInstallationId: randomUUID(),
    },
    phase: 'promoting',
    startedAt: 1,
    updatedAt: 1,
  };
  const resources = restoreDatabaseResources(job);
  await mkdir(join(root, job.id, 'host'), { recursive: true });
  await writeFile(
    join(root, job.id, 'database'),
    JSON.stringify({
      jobId: job.id,
      container: resources.container,
      volume: resources.volume,
      database: resources.database,
      network: resources.prefix,
      password: 'c'.repeat(64),
    }),
  );
  await writeFile(join(root, job.id, 'host/backup-postgres-password'), 'd'.repeat(64));
  let database = resources.database;
  let verityLogin = false;
  let interrupted = false;
  let authorityId = job.id;
  let phase = 'prepared';
  const writes: string[] = [];
  fake.query.mockReset().mockImplementation(async (url: URL, text: string) => {
    if (text === 'SELECT 1') {
      if (url.username === 'verity' && !verityLogin) throw new Error('no role');
      return { rows: [] };
    }
    if (text.includes('SELECT datname')) return { rows: [{ datname: database }] };
    if (text.includes('SELECT job_id'))
      return {
        rows: [
          {
            job_id: authorityId,
            installation_id: job.installationId,
            manifest_hash: job.verified!.manifestHash,
            phase,
          },
        ],
      };
    writes.push(text);
    if (text.includes("phase = 'canonicalizing'")) phase = 'canonicalizing';
    if (text.includes('CREATE ROLE verity LOGIN')) verityLogin = true;
    if (text.startsWith('ALTER DATABASE') && text.includes('RENAME TO')) database = 'verity';
    if (text.startsWith('REASSIGN'))
      throw new Error('cannot reassign ownership of objects owned by bootstrap role');
    if (text.includes("set_config('verity.backup_password'") && !interrupted) {
      interrupted = true;
      throw new Error('process interrupted after rename');
    }
    if (text.includes("phase = 'canonical'")) phase = 'canonical';
    return { rows: [] };
  });
  const removeContainer = vi.fn(async () => {});
  const docker = {
    listContainers: async () => [
      { id: 'trial', names: [resources.prefix + '-trial'], labels: resources.labels },
    ],
    removeContainer,
    inspectContainer: async () => ({
      running: true,
      labels: resources.labels,
      networks: { [resources.prefix]: { ipAddress: '172.18.0.2' } },
      mounts: [
        {
          type: 'volume',
          name: resources.volume,
          destination: '/var/lib/postgresql',
          readWrite: true,
        },
      ],
    }),
  } as unknown as DockerClient;
  const options = {
    docker,
    root,
    network: resources.prefix,
    job,
    recoveryKey: 'recovery-secret',
    masterPassword: 'master-secret',
  };
  try {
    await expect(canonicalizeRestoreDatabase(options)).rejects.toThrow('process interrupted');
    expect(database).toBe('verity');
    await canonicalizeRestoreDatabase(options);
    expect(phase).toBe('canonical');
    expect(fake.recheck.mock.calls.map((call) => (call[0] as { target: string }).target)).toEqual([
      'staging',
      'canonical',
    ]);
    const checkpoint = await readFile(join(root, job.id, 'database-canonicalized'), 'utf8');
    expect(JSON.parse(checkpoint)).toEqual({
      jobId: job.id,
      manifestHash: job.verified!.manifestHash,
    });
    expect(checkpoint).not.toContain('secret');
    expect(writes.some((query) => query.includes('ALTER ROLE restore NOLOGIN'))).toBe(true);
    writes.length = 0;
    authorityId = randomUUID();
    await expect(canonicalizeRestoreDatabase(options)).rejects.toThrow('authority mismatch');
    expect(writes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
