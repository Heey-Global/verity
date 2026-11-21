import { chmod, cp, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishAgentSeedAtomically,
  validatePublishedAgentSeed,
} from './managed-companion-reconcile.js';

const shipped = resolve('features/verity-sandbox-toolkit/agent-seed');
const helper = 'bin/verity-dependencies';
const companion = 'bin/verity-dependency-storage.mjs';
const oldImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const newImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-seed-module-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'seed');
  await cp(shipped, source, { recursive: true });
  const standalone = join(root, 'standalone');
  await cp(source, standalone, { recursive: true });
  await writeFile(join(standalone, helper), '#!/usr/bin/env node\nconsole.log("standalone");\n');
  await rm(join(standalone, companion));
  return { root, source, standalone, target };
}

describe('agent seed dependency helper companion publication', () => {
  it('rejects a missing companion before changing the selected seed', async () => {
    const f = await fixture();
    await publishAgentSeedAtomically(f.standalone, f.target, oldImage, '4.90.0');
    const previous = await readlink(join(f.target, '.current'));
    await rm(join(f.source, companion));
    await expect(
      publishAgentSeedAtomically(f.source, f.target, newImage, '4.99.0'),
    ).rejects.toThrow(`required file is missing: ${companion}`);
    expect(await readlink(join(f.target, '.current'))).toBe(previous);
    expect(await readFile(join(f.target, '.current', helper), 'utf8')).toContain('standalone');
  });

  it('accepts a read-only non-executable companion and can roll back to a standalone helper', async () => {
    const f = await fixture();
    await publishAgentSeedAtomically(f.standalone, f.target, oldImage, '4.90.0');
    const previous = await readlink(join(f.target, '.current'));
    await chmod(join(f.source, companion), 0o644);
    await publishAgentSeedAtomically(f.source, f.target, newImage, '4.99.0');
    expect((await stat(join(f.target, '.current', companion))).mode & 0o777).toBe(0o644);
    await publishAgentSeedAtomically(f.standalone, f.target, oldImage, '4.90.0');
    expect(await readlink(join(f.target, '.current'))).toBe(previous);
  });

  it('allows legacy flat standalone seeds without the new companion', async () => {
    const f = await fixture();
    await cp(f.standalone, f.target, { recursive: true });
    await writeFile(
      join(f.target, '.verity-agent-seed'),
      `schema=1\nimage=${oldImage}\nversion=4.90.0\npublished=2026-11-01T00:00:00Z\n`,
    );
    await publishAgentSeedAtomically(
      f.source,
      f.target,
      newImage,
      '4.99.0',
      undefined,
      undefined,
      true,
    );
    expect(await readlink(join(f.target, '.current'))).toBe(`.versions/${'b'.repeat(64)}`);
  });

  it('requires the companion when a legacy flat helper already imports it', async () => {
    const f = await fixture();
    await cp(f.source, f.target, { recursive: true });
    await rm(join(f.target, companion));
    await writeFile(
      join(f.target, '.verity-agent-seed'),
      `schema=1\nimage=${oldImage}\nversion=4.99.0\npublished=2026-11-01T00:00:00Z\n`,
    );
    await expect(
      validatePublishedAgentSeed(f.target, oldImage, '4.99.0', 'legacy'),
    ).rejects.toThrow(`required file is missing: ${companion}`);
    await expect(
      publishAgentSeedAtomically(f.source, f.target, newImage, '5.0.0', undefined, undefined, true),
    ).rejects.toThrow(`required file is missing: ${companion}`);
    await expect(readlink(join(f.target, '.current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
