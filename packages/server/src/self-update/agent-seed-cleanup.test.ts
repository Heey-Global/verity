import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, DockerClient } from '../docker.js';
import { cleanupAgentSeedVersions } from './agent-seed-cleanup.js';
import { withAgentSeedLease } from './agent-seed-lease.js';
import {
  agentSeedPublicationKey,
  publishAgentSeedAtomically,
} from './managed-companion-reconcile.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seed-cleanup-'));
  roots.push(root);
  const keys: string[] = [];
  for (let index = 0; index < 5; index++) {
    const image = `sha256:${String(index).repeat(64)}`;
    const version = `1.0.${index}`;
    const key = agentSeedPublicationKey(image, version);
    keys.push(key);
    const directory = join(root, '.versions', key);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, '.verity-agent-seed'),
      `schema=1\nimage=${image}\nversion=${version}\npublished=2026-10-25T00:00:00.000Z\n`,
    );
  }
  await symlink(`.versions/${keys[0]!}`, join(root, '.current'));
  await symlink(`.versions/${keys[1]!}`, join(root, '.previous'));
  const hostRoot = '/srv/verity/seed';
  const states: ContainerInspect[] = [
    {
      id: 'stopped',
      running: false,
      mountCount: 1,
      mounts: [
        {
          type: 'bind',
          source: `${hostRoot}/.versions/${keys[2]!}`,
          destination: '/opt/agent-seed',
        },
      ],
    },
    {
      id: 'server',
      running: true,
      mountCount: 0,
      mounts: [],
      env: [`VERITY_AGENT_SEED_HOST_PATH=${hostRoot}/.versions/${keys[3]!}`],
    },
  ];
  const docker = {
    listContainers: vi.fn(async () => states.map(({ id }) => ({ id, imageId: 'image' }))),
    inspectContainer: vi.fn(async (id: string) => states.find((state) => state.id === id)!),
  } satisfies Pick<DockerClient, 'listContainers' | 'inspectContainer'>;
  const run = () => cleanupAgentSeedVersions({ root, hostRoot, docker });
  const remaining = () => readdir(join(root, '.versions'));
  return { root, hostRoot, keys, states, docker, run, remaining };
}

describe('agent seed cleanup', () => {
  it('prevents a publisher from promoting a release during reclamation', async () => {
    const f = await fixture();
    await withAgentSeedLease(f.root, async () => {
      await expect(
        publishAgentSeedAtomically(join(f.root, 'missing-source'), f.root, 'release:next', '2.0.0'),
      ).rejects.toThrow('lifecycle is busy');
    });
    expect(await f.remaining()).toHaveLength(5);
  });

  it('preserves selections, stopped-container references and configured pins while deleting an orphan', async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({ deleted: [f.keys[4]] });
    expect(await f.remaining()).toEqual(expect.arrayContaining(f.keys.slice(0, 4)));
    expect(await f.remaining()).toHaveLength(4);
    expect(f.docker.inspectContainer).toHaveBeenCalledWith('stopped');
  });

  it.each(['.current', '', '.current/bin', '.previous'])(
    'refuses ambiguous seed bind %s',
    async (suffix) => {
      const f = await fixture();
      f.states[0]!.mounts![0]!.source = suffix ? `${f.hostRoot}/${suffix}` : f.hostRoot;
      expect((await f.run()).skipped).toMatch(/ambiguous|unrecognized/);
      expect(await f.remaining()).toHaveLength(5);
    },
  );

  it('refuses a parent bind that can expose every seed release', async () => {
    const f = await fixture();
    f.states[0]!.mounts![0]!.source = '/srv/verity';
    f.states[0]!.mounts![0]!.destination = '/host';
    expect((await f.run()).skipped).toBeTruthy();
    expect(await f.remaining()).toHaveLength(5);
  });

  it('does not treat an empty bind source as an unrelated host directory', async () => {
    const f = await fixture();
    f.states[0]!.mounts![0]!.source = '';
    expect((await f.run()).skipped).toContain('not absolute');
    expect(await f.remaining()).toHaveLength(5);
  });

  it.each([
    'missing listing',
    'listing failure',
    'inspect failure',
    'missing mounts',
    'partial mounts',
    'missing metadata',
  ])('does not delete after %s', async (failure) => {
    const f = await fixture();
    if (failure === 'missing listing') delete (f.docker as Partial<typeof f.docker>).listContainers;
    if (failure === 'listing failure')
      f.docker.listContainers.mockRejectedValue(new Error('offline'));
    if (failure === 'inspect failure')
      f.docker.inspectContainer.mockRejectedValue(new Error('offline'));
    if (failure === 'missing mounts') delete f.states[0]!.mounts;
    if (failure === 'partial mounts') f.states[0]!.mountCount = 2;
    if (failure === 'missing metadata') delete f.states[0]!.mounts![0]!.source;
    expect((await f.run()).skipped).toBeTruthy();
    expect(await f.remaining()).toHaveLength(5);
  });

  it('does not delete anything when any release stamp is malformed', async () => {
    const f = await fixture();
    await writeFile(join(f.root, '.versions', f.keys[4]!, '.verity-agent-seed'), 'schema=broken');
    expect((await f.run()).skipped).toMatch(/provenance/);
    expect(await f.remaining()).toHaveLength(5);
  });

  it('rejects an inventory that changes during inspection', async () => {
    const f = await fixture();
    f.docker.listContainers
      .mockResolvedValueOnce(f.states.map(({ id }) => ({ id, imageId: 'image' })))
      .mockResolvedValueOnce([]);
    expect((await f.run()).skipped).toMatch(/inventory changed/);
    expect(await f.remaining()).toHaveLength(5);
  });

  it('skips cleanup while publication holds the cross-process lease', async () => {
    const f = await fixture();
    await withAgentSeedLease(f.root, async () => {
      expect((await f.run()).skipped).toMatch(/busy/);
      expect(f.docker.listContainers).not.toHaveBeenCalled();
      expect(await f.remaining()).toHaveLength(5);
    });
  });
});
