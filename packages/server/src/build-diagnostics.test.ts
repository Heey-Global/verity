import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuildDiagnosticStore } from './build-diagnostics.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'verity-diagnostics-'));
  roots.push(root);
  return root;
}

describe('build diagnostic files', () => {
  it('redacts before persistence and survives a store restart', async () => {
    const root = await directory();
    const id = randomUUID();
    const secret = 'opaque-registry-credential';
    const store = createBuildDiagnosticStore(root);
    await store.save(
      id,
      {
        stdout: 'Step 1: compiling',
        stderr: `Failed using ${secret}\nAuthorization: Bearer abc123\npassword=unsafe\nlast failure`,
      },
      [secret],
    );
    const raw = await readFile(join(root, `${id}.json`), 'utf8');
    for (const value of [secret, 'abc123', 'unsafe']) expect(raw).not.toContain(value);
    const recovered = await createBuildDiagnosticStore(root).read(id);
    expect(recovered?.text).toContain('last failure');
    expect(recovered?.operationId).toBe(id);
    expect(recovered?.phase).toBe('image_build');
  });
  it('bounds encoded bytes and serializes concurrent saves under the total limit', async () => {
    const root = await directory();
    const store = createBuildDiagnosticStore(root, { entryBytes: 512, totalBytes: 1100 });
    await Promise.all(
      Array.from({ length: 6 }, () => store.save(randomUUID(), { stderr: 'é\\"'.repeat(2000) })),
    );
    const files = await readdir(root);
    const bodies = await Promise.all(files.map((name) => readFile(join(root, name))));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.reduce((sum, body) => sum + body.length, 0)).toBeLessThanOrEqual(1100);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(512);
      expect(JSON.parse(body.toString()).truncated).toBe(true);
    }
  });
  it('expires files and rejects path traversal', async () => {
    const root = await directory();
    let now = Date.now();
    const store = createBuildDiagnosticStore(root, { now: () => now, retentionMs: 1000 });
    const id = randomUUID();
    await store.save(id, new Error('failure'));
    now += 2000;
    expect(await store.read(id)).toBeNull();
    expect(await readdir(root)).toEqual([]);
    await expect(store.read('../escape')).rejects.toThrow('Invalid');
  });
  it('reports storage failures without poisoning the next operation', async () => {
    const root = await directory();
    const blocked = join(root, 'file');
    await writeFile(blocked, 'not a directory');
    await expect(
      createBuildDiagnosticStore(blocked).save(randomUUID(), new Error('failure')),
    ).rejects.toThrow();
    const store = createBuildDiagnosticStore(root);
    await expect(store.read('invalid')).rejects.toThrow();
    const id = randomUUID();
    await store.save(id, new Error('next failure'));
    expect((await store.read(id))?.text).toBe('next failure');
  });
  it('marks output cut by the child-process buffer even below the file limit', async () => {
    const root = await directory();
    const store = createBuildDiagnosticStore(root);
    const id = randomUUID();
    await store.save(id, {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr: 'Partial compiler output',
    });
    expect((await store.read(id))?.truncated).toBe(true);
  });
  it.each(['single-line', 'multi-line'])(
    'preserves complete large %s output across repeated reads',
    async (kind) => {
      const root = await directory();
      const store = createBuildDiagnosticStore(root);
      const id = randomUUID();
      const output =
        'x'.repeat(70_000) + (kind === 'multi-line' ? '\ncompiler failure\nlast line' : '');
      await store.save(id, { stderr: output });
      for (let read = 0; read < 2; read += 1) {
        const result = await store.read(id);
        expect(result?.text).toBe(output);
        expect(result?.truncated).toBe(false);
      }
    },
  );
  it('captures command output and truncation through production build error wrappers', async () => {
    const root = await directory();
    const store = createBuildDiagnosticStore(root);
    const id = randomUUID();
    const command = Object.assign(new Error('command failed'), {
      stdout: 'compiler started',
      stderr: 'detailed failure with password=opaque',
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const wrapped = new Error('Devcontainer image build failed: shortened status', {
      cause: command,
    });
    await store.save(id, new Error('provision failed', { cause: wrapped }));
    const result = await store.read(id);
    expect(result?.text).toContain('compiler started');
    expect(result?.text).toContain('detailed failure');
    expect(result?.text).not.toContain('opaque');
    expect(result?.truncated).toBe(true);
  });
});
