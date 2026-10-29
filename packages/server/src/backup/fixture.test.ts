import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { decryptStream, openMetadata, recoverHostKeys } from './crypto.js';
import { parseManifest } from './format.js';
import { probeSnapshot } from './probe.js';

describe('committed backup format compatibility', () => {
  it('reads format v1 without regenerating the fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/v1.json', import.meta.url), 'utf8'),
    ) as {
      recoveryKey: string;
      hostKeys: string;
      manifest: string;
      ciphertext: string;
      plaintext: string;
    };
    const host = await recoverHostKeys(
      fixture.recoveryKey,
      Buffer.from(fixture.hostKeys, 'base64'),
    );
    expect(host.recipient.startsWith('age1')).toBe(true);
    const manifest = parseManifest(
      await openMetadata(fixture.recoveryKey, Buffer.from(fixture.manifest, 'base64')),
      '11111111-1111-4111-8111-111111111111-r1',
      1,
    );
    expect(manifest.files[0]!.path).toBe('fixture.txt');
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from(fixture.ciphertext, 'base64'));
        c.close();
      },
    });
    const plaintext = await new Response(await decryptStream(fixture.recoveryKey, input)).text();
    expect(plaintext).toBe(fixture.plaintext);
  });
});

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
it.skipIf(!adminUrl)(
  'probes immutable format v1 through extraction, identity and actual PostgreSQL import',
  async () => {
    const path = new URL('./fixtures/v1-installation.json', import.meta.url);
    const original = await readFile(path);
    const fixture = JSON.parse(original.toString()) as {
      format: number;
      recoveryKey: string;
      repository: string;
      sequence: number;
      schemaSql: string;
      expected: {
        deploymentId: string;
        files: number;
        value: string;
        bytesHex: string;
        knowledge: string;
      };
      files: { path: string; base64: string }[];
    };
    expect(fixture.format).toBe(1);
    const root = await mkdtemp(join(tmpdir(), 'format-v1-probe-'));
    const backup = join(root, 'backup');
    const staging = join(root, 'staging');
    await mkdir(staging);
    const phases: string[] = [];
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    let databaseName: string | undefined;
    try {
      // Only unpack committed bytes. Capturing a new fixture here would hide format regressions.
      for (const file of fixture.files) {
        const target = join(backup, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.base64, 'base64'));
      }
      const report = await probeSnapshot({
        backupRoot: backup,
        repository: fixture.repository,
        sequence: fixture.sequence,
        kind: 'manual',
        recoveryKey: fixture.recoveryKey,
        stagingParent: staging,
        architecture: 'amd64',
        phase: async (phase) => {
          phases.push(phase);
          if (phase === 'identity') {
            const [directory] = await readdir(staging);
            expect(directory).toBeDefined();
            expect(
              await readFile(join(staging, directory!, 'knowledge/compatibility.md'), 'utf8'),
            ).toBe(fixture.expected.knowledge);
          }
        },
        checkRelease: async (manifest, architecture) => {
          expect(manifest.schema).toBe('0001_fixture_schema');
          expect(manifest.release).toBe('fixture-v1');
          expect(manifest.capture?.architecture).toBe(architecture);
        },
        withDatabase: async (_manifest, estimatedBytes, run) => {
          expect(estimatedBytes).toBeGreaterThan(0n);
          databaseName = 'verity_probe_' + randomBytes(16).toString('hex');
          await admin.query(`CREATE DATABASE "${databaseName}"`);
          const url = new URL(adminUrl!);
          url.pathname = '/' + databaseName;
          const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
          try {
            // The historical fixture schema stays fixed independently of current migrations.
            await pool.query(fixture.schemaSql);
            const client = await pool.connect();
            try {
              await run(client);
              const data = await client.query<{ id: number; value: string; bytes: Buffer }>(
                'SELECT id,value,bytes FROM fixture_data',
              );
              expect(data.rows).toHaveLength(1);
              expect(data.rows[0]?.id).toBe(7);
              expect(data.rows[0]?.value).toBe(fixture.expected.value);
              expect(data.rows[0]?.bytes.toString('hex')).toBe(fixture.expected.bytesHex);
            } finally {
              client.release();
            }
          } finally {
            await pool.end();
          }
        },
      });
      expect(report.deploymentId).toBe(fixture.expected.deploymentId);
      expect(report.files).toBe(fixture.expected.files);
      expect(report.warnings).toEqual([]);
      expect(phases).toEqual(['release', 'staging', 'identity', 'git', 'database', 'revocations']);
      expect(await readdir(staging)).toEqual([]);
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(createHash('sha256').update(original).digest('hex'));
    } finally {
      if (databaseName) await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
