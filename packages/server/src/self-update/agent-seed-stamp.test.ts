import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareAgentSeed,
  parseAgentSeedStamp,
  readAgentSeedStamp,
  sandboxAgentSeedHostPath,
  AGENT_SEED_STAMP_FILE,
  DEV_VERSION_SENTINEL,
} from './agent-seed-stamp.js';
import { createAgentSeedProvenanceClient } from './server-update-controller.js';
import {
  readUpdaterAgentSeed,
  startUpdaterStatusServer,
  type UpdaterStatusServer,
} from './updater-status.js';

const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const otherImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

/** Exactly what the `verity-agent-seed` one-shot's `printf` writes. */
const published = (version: string): string =>
  `schema=1\nimage=${image}\nversion=${version}\npublished=2026-08-12T09:00:00Z\n`;

const servers: UpdaterStatusServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

/** A host seed directory, with or without the stamp the one-shot leaves in it. */
async function seedDirectory(stamp?: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'verity-agent-seed-'));
  if (stamp !== undefined) await writeFile(join(path, AGENT_SEED_STAMP_FILE), stamp);
  return path;
}

/** An Updater listening on a private socket, with the seed mounted or not. */
async function updater(options: { agentSeedPath?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-updater-'));
  const control = join(root, 'control');
  await mkdir(control, { mode: 0o750 });
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  const socketPath = join(control, 'updater.sock');
  const token = 'a'.repeat(32);
  servers.push(
    await startUpdaterStatusServer({
      socketPath,
      token,
      managedRoot,
      // Publishing to the peer group is what a managed deployment does, and is
      // what lets the Server-side client find the token at all.
      peerGid: process.getgid?.() ?? 0,
      ...(options.agentSeedPath === undefined ? {} : { agentSeedPath: options.agentSeedPath }),
    }),
  );
  return { socketPath, token };
}

describe('agent seed stamp', () => {
  it('normalizes old managed seals onto the immutable current pointer', () => {
    expect(sandboxAgentSeedHostPath({ VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1' })).toBe(
      '/opt/agent-seed/.current',
    );
    expect(
      sandboxAgentSeedHostPath({
        VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
        VERITY_AGENT_SEED_HOST_PATH: '/srv/verity/seed',
      }),
    ).toBe('/srv/verity/seed/.current');
    expect(
      sandboxAgentSeedHostPath({
        VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
        VERITY_AGENT_SEED_HOST_PATH: '/srv/verity/seed/.current',
      }),
    ).toBe('/srv/verity/seed/.current');
  });

  it('normalizes the new Compose root without doubling an existing suffix', () => {
    expect(sandboxAgentSeedHostPath({ VERITY_AGENT_SEED_ROOT_HOST_PATH: '/srv/verity/seed' })).toBe(
      '/srv/verity/seed/.current',
    );
    expect(
      sandboxAgentSeedHostPath({ VERITY_AGENT_SEED_ROOT_HOST_PATH: '/srv/verity/seed/.current' }),
    ).toBe('/srv/verity/seed/.current');
  });

  it('preserves standalone seed paths', () => {
    expect(sandboxAgentSeedHostPath({})).toBeUndefined();
    expect(
      sandboxAgentSeedHostPath({
        VERITY_MANAGED_DEPLOYMENT_ID: '',
        VERITY_AGENT_SEED_HOST_PATH: '/custom/seed',
      }),
    ).toBe('/custom/seed');
    expect(sandboxAgentSeedHostPath({ VERITY_AGENT_SEED_HOST_PATH: '/custom/seed' })).toBe(
      '/custom/seed',
    );
  });

  it('reads back the four fields the one-shot writes', () => {
    expect(parseAgentSeedStamp(published('1.2.3'))).toEqual({
      schemaVersion: 1,
      image,
      version: '1.2.3',
      publishedAt: '2026-08-12T09:00:00Z',
    });
  });

  it('treats a stamp without a timestamp as stamped, not as unstamped', () => {
    // `published` is the one field the comparison never uses, so a stamp that
    // omits it still answers the question the operator is asking.
    expect(parseAgentSeedStamp(`schema=1\nimage=${image}\nversion=1.2.3\n`)).toMatchObject({
      version: '1.2.3',
      publishedAt: null,
    });
  });

  it('ignores blanks and comments, and lets the first line win a repeated key', () => {
    const text = [
      '# published by verity-agent-seed',
      '',
      'schema=1',
      `image=${image}`,
      'version=1.2.3',
      '   ',
      'version=9.9.9',
    ].join('\n');
    expect(parseAgentSeedStamp(text)).toMatchObject({ version: '1.2.3' });
  });

  it('keeps a value that contains the separator intact', () => {
    const ref = 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64);
    expect(parseAgentSeedStamp(`schema=1\nimage=${ref}\nversion=1.2.3\npublished=a=b\n`)).toEqual({
      schemaVersion: 1,
      image: ref,
      version: '1.2.3',
      publishedAt: 'a=b',
    });
  });

  it.each([
    ['a future schema', `schema=2\nimage=${image}\nversion=1.2.3\n`],
    ['no schema at all', `image=${image}\nversion=1.2.3\n`],
    ['no image', 'schema=1\nversion=1.2.3\n'],
    ['an empty image', 'schema=1\nimage=\nversion=1.2.3\n'],
    ['no version', `schema=1\nimage=${image}\n`],
    ['an empty version', `schema=1\nimage=${image}\nversion=\n`],
    ['a line that is not a pair', `schema=1\nimage=${image}\nversion=1.2.3\nrubbish\n`],
    ['a line with an empty key', `=1\nschema=1\nimage=${image}\nversion=1.2.3\n`],
    ['nothing', ''],
  ])('refuses a stamp with %s', (_case, text) => {
    expect(parseAgentSeedStamp(text)).toBeNull();
  });

  it('refuses a file too large to be a stamp without parsing it', () => {
    expect(parseAgentSeedStamp(published('1.2.3') + '#'.repeat(4096))).toBeNull();
  });

  it('reads the stamp out of a seed directory', async () => {
    await expect(
      readAgentSeedStamp(await seedDirectory(published('1.2.3'))),
    ).resolves.toMatchObject({ version: '1.2.3' });
  });

  it.each([
    ['the directory has no stamp', undefined],
    ['the stamp is malformed', 'not a stamp at all'],
  ])('answers null when %s', async (_case, stamp) => {
    await expect(readAgentSeedStamp(await seedDirectory(stamp))).resolves.toBeNull();
  });

  it('answers null for a directory that does not exist', async () => {
    await expect(
      readAgentSeedStamp(join(tmpdir(), 'verity-agent-seed-absent')),
    ).resolves.toBeNull();
  });

  /**
   * The read is bounded, so an oversized file costs one buffer rather than its
   * own size — and it is one byte wider than the limit, so what comes back is
   * refused as too large instead of parsed out of a truncation that happens to
   * look like a stamp. The padding is a comment line for exactly that reason:
   * truncated at the limit it would parse.
   */
  it('refuses an oversized stamp rather than parsing a prefix of it', async () => {
    const seedPath = await seedDirectory(`${published('1.2.3')}#${'x'.repeat(16 * 1024)}\n`);
    await expect(readAgentSeedStamp(seedPath)).resolves.toBeNull();
  });

  it('answers null when the stamp is not a regular file', async () => {
    const seedPath = await mkdtemp(join(tmpdir(), 'verity-agent-seed-'));
    await mkdir(join(seedPath, AGENT_SEED_STAMP_FILE));
    await expect(readAgentSeedStamp(seedPath)).resolves.toBeNull();
  });

  it('refuses a FIFO without waiting for a writer', async () => {
    const seedPath = await mkdtemp(join(tmpdir(), 'verity-agent-seed-'));
    execFileSync('mkfifo', [join(seedPath, AGENT_SEED_STAMP_FILE)]);
    await expect(readAgentSeedStamp(seedPath)).resolves.toBeNull();
  });
});

describe('agent seed comparison', () => {
  it('matches a seed published from the release the Server is', () => {
    const stamp = parseAgentSeedStamp(published('1.2.3'));
    expect(compareAgentSeed(stamp, '1.2.3', image)).toEqual({ state: 'matched', stamp });
  });

  /** A skew remains observable while managed companion convergence is pending,
   * and in standalone deployments where publication is independently owned. */
  it('reports skew when the Server moved and the seed did not', () => {
    const stamp = parseAgentSeedStamp(published('1.2.3'));
    expect(compareAgentSeed(stamp, '1.3.0', image)).toEqual({
      state: 'skewed',
      stamp,
      serverVersion: '1.3.0',
      serverImage: image,
    });
  });

  it('reports skew when the image digest changed without a version change', () => {
    const stamp = parseAgentSeedStamp(published('1.2.3'));
    expect(compareAgentSeed(stamp, '1.2.3', otherImage)).toEqual({
      state: 'skewed',
      stamp,
      serverVersion: '1.2.3',
      serverImage: otherImage,
    });
  });

  it('does not claim a match when either image lacks an immutable digest', () => {
    const tagStamp = parseAgentSeedStamp(published('1.2.3').replace(image, 'server:1.2.3'));
    expect(compareAgentSeed(tagStamp, '1.2.3', image)).toMatchObject({ state: 'unknown' });
    expect(
      compareAgentSeed(parseAgentSeedStamp(published('1.2.3')), '1.2.3', undefined),
    ).toMatchObject({ state: 'unknown' });
  });

  it('says unknown, not matched, for a seed that carries no stamp', () => {
    const provenance = compareAgentSeed(null, '1.2.3', image);
    expect(provenance.state).toBe('unknown');
  });

  it.each([
    ['the seed', DEV_VERSION_SENTINEL, '1.2.3'],
    ['the Server', '1.2.3', DEV_VERSION_SENTINEL],
    ['both', DEV_VERSION_SENTINEL, DEV_VERSION_SENTINEL],
  ])('says unknown when %s is a development build', (_case, seedVersion, serverVersion) => {
    // Two dev builds are not evidence of agreement — they are two builds that
    // decline to say what they are, and reporting "matched" would be a claim
    // neither side made.
    expect(
      compareAgentSeed(parseAgentSeedStamp(published(seedVersion)), serverVersion, image),
    ).toMatchObject({ state: 'unknown' });
  });
});

describe('updater agent-seed route', () => {
  it('reports the stamp of the seed the host is serving', async () => {
    const seedPath = await seedDirectory(published('1.2.3'));
    await expect(readUpdaterAgentSeed(await updater({ agentSeedPath: seedPath }))).resolves.toEqual(
      {
        visible: true,
        stamp: { schemaVersion: 1, image, version: '1.2.3', publishedAt: '2026-08-12T09:00:00Z' },
      },
    );
  });

  /**
   * `visible` is the distinction the operator-facing message rests on: a seed
   * that is mounted but unstamped says something about the seed, while a seed
   * that is not mounted says only that this deployment cannot look.
   */
  it('separates a mounted seed without a stamp from no mount at all', async () => {
    await expect(
      readUpdaterAgentSeed(await updater({ agentSeedPath: await seedDirectory() })),
    ).resolves.toEqual({ visible: true, stamp: null });
    await expect(readUpdaterAgentSeed(await updater())).resolves.toEqual({
      visible: false,
      stamp: null,
    });
  });

  it('answers a mounted but malformed stamp the way it answers a missing one', async () => {
    const seedPath = await seedDirectory('schema=99\n');
    await expect(readUpdaterAgentSeed(await updater({ agentSeedPath: seedPath }))).resolves.toEqual(
      {
        visible: true,
        stamp: null,
      },
    );
  });

  it('tells an unauthorized caller nothing about the seed', async () => {
    const seedPath = await seedDirectory(published('1.2.3'));
    const { socketPath } = await updater({ agentSeedPath: seedPath });
    // Degrades to the same shape as "cannot look" rather than throwing, because
    // a Server that fails this call must still start and serve.
    await expect(readUpdaterAgentSeed({ socketPath, token: 'b'.repeat(32) })).resolves.toEqual({
      visible: false,
      stamp: null,
    });
  });
});

describe('agent seed provenance client', () => {
  it('is absent for a deployment with no updater control mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-'));
    await expect(
      createAgentSeedProvenanceClient('1.2.3', image, join(root, 'control', 'updater.sock')),
    ).resolves.toBeUndefined();
  });

  it('carries the skew across the control socket to the Server', async () => {
    const seedPath = await seedDirectory(published('1.2.3'));
    const { socketPath } = await updater({ agentSeedPath: seedPath });
    const client = await createAgentSeedProvenanceClient('1.3.0', image, socketPath);
    await expect(client?.read()).resolves.toMatchObject({
      state: 'skewed',
      serverVersion: '1.3.0',
    });
  });

  it('reports an Updater without the mount as unknown rather than as agreement', async () => {
    const { socketPath } = await updater();
    const client = await createAgentSeedProvenanceClient('1.3.0', image, socketPath);
    await expect(client?.read()).resolves.toMatchObject({ state: 'unknown' });
  });

  it('observes a managed selection published after the control boundary starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-seed-transition-'));
    const current = join(root, '.current');
    const { socketPath } = await updater({ agentSeedPath: current });
    const client = await createAgentSeedProvenanceClient('1.2.3', image, socketPath);

    await expect(client?.read()).resolves.toMatchObject({ state: 'unknown' });

    await mkdir(current);
    await writeFile(join(current, AGENT_SEED_STAMP_FILE), published('1.2.3'));
    await expect(client?.read()).resolves.toMatchObject({ state: 'matched' });
  });
});
