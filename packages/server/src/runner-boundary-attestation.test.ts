import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeHttp from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attestRunnerSupervisorBoundary,
  cachedTrustedToolkitIdentity,
  acceptedToolkits,
  defaultImageEvidenceCollector,
  evaluateRunnerBoundaryEvidence,
  parseDockerArchive,
  resetTrustedToolkitIdentityCache,
  RUNNER_BOUNDARY_BINARIES,
  trustedToolkitIdentity,
  type ImageEvidenceCollector,
  type ImageFileEvidence,
  type RunnerBoundaryEvidence,
} from './runner-boundary-attestation.js';

/** The collector shells out to the `docker` CLI for the two calls that need the
 *  daemon's own authority (create a stopped container, read its Config.User) and
 *  speaks HTTP for the archive reads. Only the CLI half is faked here — the
 *  archive half runs against a real server below, so the tar parsing, the
 *  bounded read and the refusal arms are exercised for real. */
const dockerCli = vi.hoisted(() => {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    /** Overridden per test; throwing simulates a non-zero `docker` exit. */
    run: (args: readonly string[]): string => args.join(' '),
  };
});

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ): void => {
    dockerCli.calls.push({ file, args, env: options.env });
    let stdout: string;
    try {
      stdout = dockerCli.run(args);
    } catch (error) {
      queueMicrotask(() => callback(error as Error));
      return;
    }
    queueMicrotask(() => {
      callback(null, { stdout, stderr: '' });
    });
  },
}));

const IDS = { runnerUid: 1101, runtimeGid: 1101 };
const BINARY_BYTES = Buffer.from('trusted supervisor');
const hash = createHash('sha256').update(BINARY_BYTES).digest('hex');
const bundledToolkit = {
  label: 'this Server bundled toolkit',
  hashes: new Map(RUNNER_BOUNDARY_BINARIES.map((path) => [path, hash])),
};
const trustedToolkits = [bundledToolkit];

/** A published build differing from the bundle in one binary. */
function releaseToolkit(label: string, path: string, content: string) {
  const hashes = new Map<string, string>(bundledToolkit.hashes);
  hashes.set(path, createHash('sha256').update(content).digest('hex'));
  return { label, hashes };
}

function entry(
  path: string,
  type: ImageFileEvidence['type'],
  overrides: Partial<ImageFileEvidence> = {},
): ImageFileEvidence {
  return {
    path,
    type,
    uid: 0,
    gid: 0,
    mode: type === 'directory' ? 0o755 : 0o755,
    ...(type === 'file' ? { content: BINARY_BYTES } : {}),
    ...overrides,
  };
}

function evidence(
  overrides: ReadonlyMap<string, ImageFileEvidence> = new Map(),
  configuredUser = 'vscode',
): RunnerBoundaryEvidence {
  const files = new Map<string, ImageFileEvidence>([
    [
      '/etc/passwd',
      entry('/etc/passwd', 'file', {
        content: Buffer.from(
          'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1000::/home/vscode:/bin/sh\nverity-runner:x:1101:1101::/nonexistent:/usr/sbin/nologin\n',
        ),
      }),
    ],
    [
      '/etc/group',
      entry('/etc/group', 'file', {
        content: Buffer.from(
          'root:x:0:\nvscode:x:1000:vscode\nverity-runtime:x:1101:verity-runner\n',
        ),
      }),
    ],
    ['/', entry('/', 'directory')],
    ['/usr', entry('/usr', 'directory')],
    ['/usr/local', entry('/usr/local', 'directory')],
    ['/usr/local/bin', entry('/usr/local/bin', 'directory')],
    ...RUNNER_BOUNDARY_BINARIES.map((path) => [path, entry(path, 'file')] as const),
  ]);
  for (const [path, value] of overrides) files.set(path, value);
  return { configuredUser, files };
}

function evaluate(value: RunnerBoundaryEvidence, user?: string) {
  return evaluateRunnerBoundaryEvidence(value, {
    ...IDS,
    trustedToolkits,
    ...(user === undefined ? {} : { user }),
  });
}

describe('evaluateRunnerBoundaryEvidence (ADR 0006 D1)', () => {
  it('accepts trusted toolkit bytes and isolated identities', () =>
    expect(evaluate(evidence())).toEqual({
      ok: true,
      toolkitIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
    }));

  it.each([
    ['root agent', evidence(new Map(), 'root'), /runs as root/u],
    [
      'agent in verity-runtime',
      evidence(
        new Map([
          [
            '/etc/group',
            entry('/etc/group', 'file', {
              content: Buffer.from(
                'root:x:0:\nvscode:x:1000:vscode\nverity-runtime:x:1101:verity-runner,vscode\n',
              ),
            }),
          ],
        ]),
      ),
      /member/u,
    ],
    [
      'foreign runner UID',
      evidence(
        new Map([
          [
            '/etc/passwd',
            entry('/etc/passwd', 'file', {
              content: Buffer.from(
                'root:x:0:0::/:/bin/sh\nvscode:x:1000:1000::/:/bin/sh\nattacker:x:1101:1101::/:/bin/sh\n',
              ),
            }),
          ],
        ]),
      ),
      /not uniquely assigned/u,
    ],
    [
      'missing runtime GID',
      evidence(
        new Map([
          [
            '/etc/group',
            entry('/etc/group', 'file', {
              content: Buffer.from('root:x:0:\nvscode:x:1000:vscode\n'),
            }),
          ],
        ]),
      ),
      /GID 1101 is missing/u,
    ],
  ])('rejects %s', (_label, value, reason) => {
    const result = evaluate(value);
    expect(result.ok === false && result.reason).toMatch(reason);
  });

  it('rejects writable parent directories', () => {
    const result = evaluate(
      evidence(
        new Map([['/usr/local/bin', entry('/usr/local/bin', 'directory', { mode: 0o775 })]]),
      ),
    );
    expect(result.ok === false && result.reason).toMatch(
      /\/usr\/local\/bin is group- or world-writable/u,
    );
  });

  it.each(['symlink', 'other'] as const)(
    'rejects %s and path-traversal-shaped binary evidence',
    (type) => {
      const path = RUNNER_BOUNDARY_BINARIES[0];
      const result = evaluate(
        evidence(new Map([[path, entry(path, type, { linkTarget: '../../tmp/fake' })]])),
      );
      expect(result.ok === false && result.reason).toMatch(
        /not a regular file, or traverses a symlink/u,
      );
    },
  );

  it('rejects replaced supervisor content', () => {
    const path = RUNNER_BOUNDARY_BINARIES[0];
    const result = evaluate(
      evidence(new Map([[path, entry(path, 'file', { content: Buffer.from('malicious') })]])),
    );
    expect(result.ok === false && result.reason).toMatch(
      /is not a toolkit build this Server accepts/u,
    );
  });

  // ADR 0006 D9: a Server of version N routinely meets a Runner from N−1, so an
  // authentic previous build must attest. What must not pass is a build nobody
  // published — which is the only thing the set may ever contain more of.
  it('accepts an authentic build that is not this Server own bundle', () => {
    const path = RUNNER_BOUNDARY_BINARIES[0];
    const result = evaluateRunnerBoundaryEvidence(
      evidence(
        new Map([
          [path, entry(path, 'file', { content: Buffer.from('previous release supervisor') })],
        ]),
      ),
      {
        ...IDS,
        trustedToolkits: [
          bundledToolkit,
          releaseToolkit('release 9.0.0', path, 'previous release supervisor'),
        ],
      },
    );
    expect(result.ok).toBe(true);
  });

  // Every binary below is authentic and every one is accepted — but each comes
  // from a different release, so the toolkit as a whole was never published and
  // never tested. Accepting hashes independently would let it through.
  it('refuses binaries mixed from two accepted builds', () => {
    const [supervisor, worker] = RUNNER_BOUNDARY_BINARIES;
    const result = evaluateRunnerBoundaryEvidence(
      evidence(
        new Map([
          [supervisor, entry(supervisor, 'file', { content: Buffer.from('release 9 supervisor') })],
          [worker, entry(worker, 'file', { content: Buffer.from('release 10 worker') })],
        ]),
      ),
      {
        ...IDS,
        trustedToolkits: [
          bundledToolkit,
          releaseToolkit('release 9.0.0', supervisor, 'release 9 supervisor'),
          releaseToolkit('release 10.0.0', worker, 'release 10 worker'),
        ],
      },
    );
    expect(result.ok === false && result.reason).toMatch(/come from different toolkit builds/u);
  });

  // The recorded identity has to name the toolkit that produced the verdict. If it
  // were derived from the accepted set it would name this Server's policy instead,
  // and two Sandboxes running different accepted builds would be indistinguishable
  // in the drift report — which is the one thing it exists to tell apart.
  it('identifies the build that matched, not the set that allowed it', () => {
    const path = RUNNER_BOUNDARY_BINARIES[0];
    const widened = [
      bundledToolkit,
      releaseToolkit('release 9.0.0', path, 'previous release supervisor'),
    ];
    const identityOf = (content: string) => {
      const result = evaluateRunnerBoundaryEvidence(
        evidence(new Map([[path, entry(path, 'file', { content: Buffer.from(content) })]])),
        { ...IDS, trustedToolkits: widened },
      );
      return result.ok === true ? result.toolkitIdentity : undefined;
    };
    const current = identityOf('trusted supervisor');
    const older = identityOf('previous release supervisor');
    expect(current).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(older).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(current).not.toBe(older);
  });

  // A Server that offers no hash for a boundary binary has a packaging fault of
  // its own. Blaming the image would send an operator to rebuild the Sandbox.
  it('names its own missing trust root rather than blaming the image', () => {
    const path = RUNNER_BOUNDARY_BINARIES[0];
    const incomplete = new Map(bundledToolkit.hashes);
    incomplete.delete(path);
    const result = evaluateRunnerBoundaryEvidence(evidence(new Map()), {
      ...IDS,
      trustedToolkits: [{ label: 'this Server bundled toolkit', hashes: incomplete }],
    });
    expect(result.ok === false && result.reason).toMatch(/this Server knows no accepted hash/u);
  });

  it('does not consume or trust in-image tools', () => {
    const value = evidence(
      new Map([
        ['/bin/sh', entry('/bin/sh', 'file', { content: Buffer.from('fake sh') })],
        ['/usr/bin/stat', entry('/usr/bin/stat', 'file', { content: Buffer.from('fake stat') })],
      ]),
    );
    expect(evaluate(value).ok).toBe(true);
  });
});

describe('parseDockerArchive', () => {
  const archiveWith = (name: string, typeFlag: string): Buffer => {
    const archive = Buffer.alloc(1024);
    archive.write(name, 0, 'utf8');
    archive.write('0000755\0', 100, 'ascii');
    archive.write('0000000\0', 108, 'ascii');
    archive.write('0000000\0', 116, 'ascii');
    archive.write('00000000000\0', 124, 'ascii');
    archive.write(typeFlag, 156, 'ascii');
    return archive;
  };

  it('rejects traversal names supplied by an unexpected archive', () => {
    const archive = Buffer.alloc(1024);
    archive.write('../escape', 0, 'utf8');
    archive.write('0000755\0', 100, 'ascii');
    expect(() => parseDockerArchive('/expected', archive)).toThrow(/unsafe path/u);
  });

  // Docker names a directory entry with the trailing slash tar uses for one, and
  // the container root as "/". Rejecting those made every directory in
  // EVIDENCE_PATHS unreadable, so the attestation could never pass and any
  // project with its own devcontainer silently lost the runner supervisor.
  it('accepts the trailing slash Docker puts on a directory entry', () => {
    expect(parseDockerArchive('/usr', archiveWith('usr/', '5'))).toMatchObject({
      path: '/usr',
      type: 'directory',
    });
  });

  it('accepts the container root, which Docker names "/"', () => {
    expect(parseDockerArchive('/', archiveWith('/', '5'))).toMatchObject({
      path: '/',
      type: 'directory',
    });
  });

  it('still rejects a nested path, which no evidence entry ever is', () => {
    expect(() => parseDockerArchive('/usr', archiveWith('usr/local/', '5'))).toThrow(
      /unsafe path/u,
    );
  });
});

describe('attestRunnerSupervisorBoundary', () => {
  it('uses collected image bytes and the bundled toolkit as trust root', async () => {
    const files = new Map(evidence().files);
    for (const path of RUNNER_BOUNDARY_BINARIES) {
      const source = path.endsWith('supervisor')
        ? 'verity-runner-supervisor.mjs'
        : path.endsWith('worker')
          ? 'verity-runner-worker.mjs'
          : path.slice(path.lastIndexOf('/') + 1);
      files.set(
        path,
        entry(path, 'file', {
          content: await readFile(`features/verity-sandbox-toolkit/bin/${source}`),
        }),
      );
    }
    const collector = vi.fn<ImageEvidenceCollector>(async () => ({
      configuredUser: 'vscode',
      files,
    }));
    const result = await attestRunnerSupervisorBoundary({
      imageRef: 'custom:test',
      dockerHost: 'unix:///docker.sock',
      evidenceCollector: collector,
      featureDir: 'features/verity-sandbox-toolkit',
      ...IDS,
    });
    // The verdict names the trust root it was made against, so a caller
    // recording it cannot attribute the pass to a different toolkit — not even
    // if the bundle on disk changed between the check and the write.
    expect(result).toEqual({
      ok: true,
      toolkitIdentity: await trustedToolkitIdentity('features/verity-sandbox-toolkit'),
    });
    expect(collector).toHaveBeenCalledWith(expect.objectContaining({ imageRef: 'custom:test' }));
  });

  it('fails closed when evidence is unavailable', async () => {
    const result = await attestRunnerSupervisorBoundary({
      imageRef: 'broken:1',
      dockerHost: 'unix:///docker.sock',
      evidenceCollector: async () => {
        throw new Error('daemon detail');
      },
      featureDir: 'features/verity-sandbox-toolkit',
      ...IDS,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'trusted image evidence could not be collected or verified',
    });
  });
});

/**
 * The recorded identity has one job: tell an image whose toolkit still matches
 * from one whose toolkit changed. It is therefore derived from exactly the bytes
 * a verdict is made from — no more, or every unrelated edit reads as drift and
 * the warning becomes noise; no less, or a changed binary reads as current.
 */
describe('trustedToolkitIdentity', () => {
  async function bundle(
    contents: Partial<Record<string, string>> = {},
  ): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = mkdtempSync(join(tmpdir(), 'toolkit-identity-'));
    await mkdir(join(dir, 'bin'), { recursive: true });
    for (const path of RUNNER_BOUNDARY_BINARIES) {
      const name = path.endsWith('supervisor')
        ? 'verity-runner-supervisor.mjs'
        : path.endsWith('worker')
          ? 'verity-runner-worker.mjs'
          : path.slice(path.lastIndexOf('/') + 1);
      await writeFile(join(dir, 'bin', name), contents[name] ?? `${name} v1\n`);
    }
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('is stable for the same bytes', async () => {
    const { dir, cleanup } = await bundle();
    try {
      const first = await trustedToolkitIdentity(dir);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await trustedToolkitIdentity(dir)).toBe(first);
    } finally {
      await cleanup();
    }
  });

  it('changes when any boundary binary changes', async () => {
    const base = await bundle();
    const changed = await bundle({ 'verity-runner-worker.mjs': 'verity-runner-worker.mjs v2\n' });
    try {
      expect(await trustedToolkitIdentity(changed.dir)).not.toBe(
        await trustedToolkitIdentity(base.dir),
      );
    } finally {
      await base.cleanup();
      await changed.cleanup();
    }
  });

  // The counterpart, and the reason this is not a hash of the whole directory:
  // the Feature ships a manifest, docs and lifecycle scripts that no attestation
  // reads. Letting those move the identity would report drift for every project
  // after an edit that cannot change a single verdict.
  it('ignores files outside the boundary set', async () => {
    const { dir, cleanup } = await bundle();
    try {
      const before = await trustedToolkitIdentity(dir);
      await writeFile(join(dir, 'devcontainer-feature.json'), '{"version":"9.9.9"}\n');
      await writeFile(join(dir, 'bin', 'unrelated-helper'), 'noise\n');
      expect(await trustedToolkitIdentity(dir)).toBe(before);
    } finally {
      await cleanup();
    }
  });

  // Dev and test hosts ship no bundle. "Unknown" has to be distinguishable from
  // an identity, because the caller must not report those projects as drifted.
  it('is undefined when the bundle directory is absent', async () => {
    expect(
      await trustedToolkitIdentity(join(tmpdir(), 'toolkit-identity-missing')),
    ).toBeUndefined();
  });

  // The drift verdict is computed on the project list and detail paths, so the
  // read has to happen once rather than on every request.
  describe('cachedTrustedToolkitIdentity', () => {
    beforeEach(() => {
      resetTrustedToolkitIdentityCache();
    });

    it('reads a bundle once and answers from the cache after that', async () => {
      const { dir, cleanup } = await bundle();
      try {
        const first = await cachedTrustedToolkitIdentity(dir);
        expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
        // Removing a boundary binary makes an uncached read THROW. Still getting
        // the identity back proves the second call never touched the disk.
        await rm(join(dir, 'bin', 'verity-runner-worker.mjs'));
        expect(await cachedTrustedToolkitIdentity(dir)).toBe(first);
      } finally {
        await cleanup();
      }
    });

    // "This Server ships no bundle" is a finding, not a failure — caching it is
    // the whole point on a host that will never have one.
    it('caches the absent-bundle answer', async () => {
      const missing = join(tmpdir(), 'toolkit-identity-missing-cached');
      expect(await cachedTrustedToolkitIdentity(missing)).toBeUndefined();
      expect(await cachedTrustedToolkitIdentity(missing)).toBeUndefined();
    });

    // A throw is a broken deployment, not an answer. Freezing it would turn a
    // transient I/O fault into a permanently poisoned result that only a restart
    // clears — so the next call must go back to the disk and see the repair.
    it('does not cache a failure', async () => {
      const { dir, cleanup } = await bundle();
      try {
        const complete = await trustedToolkitIdentity(dir);
        await rm(join(dir, 'bin', 'verity-runner-worker.mjs'));
        await expect(cachedTrustedToolkitIdentity(dir)).rejects.toThrow(/ENOENT/u);

        await writeFile(
          join(dir, 'bin', 'verity-runner-worker.mjs'),
          'verity-runner-worker.mjs v1\n',
        );
        expect(await cachedTrustedToolkitIdentity(dir)).toBe(complete);
      } finally {
        await cleanup();
      }
    });

    // Keyed by directory because `VERITY_FEATURE_DIR` is a test override: a suite
    // pointing at a second fixture must not be answered from the first's read.
    it('keeps separate bundle directories apart', async () => {
      const base = await bundle();
      const changed = await bundle({ 'verity-runner-worker.mjs': 'verity-runner-worker.mjs v2\n' });
      try {
        expect(await cachedTrustedToolkitIdentity(base.dir)).not.toBe(
          await cachedTrustedToolkitIdentity(changed.dir),
        );
      } finally {
        await base.cleanup();
        await changed.cleanup();
      }
    });
  });

  // A bundle that is there but incomplete is not a Server that ships none — it
  // is a Feature that lost a binary somewhere in packaging. Filing it under
  // "no toolkit" would answer a broken build with a shrug and leave the whole
  // fleet unjudged for a reason no one is told.
  it('throws when the bundle exists but a boundary binary is missing', async () => {
    const { dir, cleanup } = await bundle();
    try {
      await rm(join(dir, 'bin', 'verity-runner-worker.mjs'));
      await expect(trustedToolkitIdentity(dir)).rejects.toThrow(/ENOENT/u);
    } finally {
      await cleanup();
    }
  });

  // "No toolkit" and "cannot read the toolkit" are different deployments. A
  // Server whose bundle is unreadable is broken, and reporting that as "ships
  // no toolkit" would describe a mount or permission fault as a design choice.
  it('throws rather than reporting absence when the bundle is unreadable', async () => {
    const { dir, cleanup } = await bundle();
    try {
      await chmod(join(dir, 'bin', 'verity-runner-worker.mjs'), 0o000);
      // Running as root defeats the mode bits; the distinction still holds and
      // is worth asserting wherever it can be observed.
      if ((process.getuid?.() ?? 0) === 0) return;
      await expect(trustedToolkitIdentity(dir)).rejects.toThrow(/EACCES/u);
    } finally {
      await cleanup();
    }
  });

  // The rules the evaluator applies are as much a part of "would this still
  // pass?" as the bytes it applies them to. Reserving a different uid/gid can
  // reject an image whose toolkit never moved, so an identity that ignored them
  // would report that image as verified until the day it failed.
  it('changes when the reserved runner identities change', async () => {
    const { dir, cleanup } = await bundle();
    try {
      expect(await trustedToolkitIdentity(dir, { runnerUid: 1201, runtimeGid: 1202 })).not.toBe(
        await trustedToolkitIdentity(dir),
      );
    } finally {
      await cleanup();
    }
  });

  // A configured path that exists as something else is a deployment mistake, not
  // an empty host. Reading it as absence would let one bad mount silence the
  // drift report for the entire fleet, with nothing said about why.
  it('throws when the bundle path exists but is not a directory', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'toolkit-identity-')), 'not-a-directory');
    await writeFile(path, 'this is a file\n');
    await expect(trustedToolkitIdentity(path)).rejects.toThrow(/is not a directory/u);
  });

  it('matches the toolkit this repo ships', async () => {
    expect(await trustedToolkitIdentity('features/verity-sandbox-toolkit')).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

describe('acceptedToolkits (ADR 0006 D9)', () => {
  const SUPERVISOR = RUNNER_BOUNDARY_BINARIES[0];

  /** A ledger entry naming every boundary binary, which is what a real release
   *  publishes; `label` varies the hashes so two entries differ. */
  const build = (label: string): Record<string, string> =>
    Object.fromEntries(
      RUNNER_BOUNDARY_BINARIES.map((path) => [
        path,
        createHash('sha256').update(`${label}:${path}`).digest('hex'),
      ]),
    );

  async function bundleWithLedger(
    ledger?: unknown,
  ): Promise<{ dir: string; own: string; cleanup: () => Promise<void> }> {
    const dir = mkdtempSync(join(tmpdir(), 'toolkit-ledger-'));
    await mkdir(join(dir, 'bin'), { recursive: true });
    for (const path of RUNNER_BOUNDARY_BINARIES) {
      const name = path.endsWith('supervisor')
        ? 'verity-runner-supervisor.mjs'
        : path.endsWith('worker')
          ? 'verity-runner-worker.mjs'
          : path.slice(path.lastIndexOf('/') + 1);
      await writeFile(join(dir, 'bin', name), `${name} own\n`);
    }
    if (ledger !== undefined) {
      await writeFile(
        join(dir, 'published-hashes.json'),
        typeof ledger === 'string' ? ledger : JSON.stringify(ledger),
      );
    }
    const own = createHash('sha256').update('verity-runner-supervisor.mjs own\n').digest('hex');
    return { dir, own, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  /** What the Server would accept, named by build. */
  async function labels(dir: string): Promise<string[]> {
    return (await acceptedToolkits(dir)).map((toolkit) => toolkit.label);
  }

  it('accepts the bundle alone when no ledger ships', async () => {
    const { dir, own, cleanup } = await bundleWithLedger();
    try {
      const accepted = await acceptedToolkits(dir);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.hashes.get(SUPERVISOR)).toBe(own);
    } finally {
      await cleanup();
    }
  });

  it('adds every release at or above the floor', async () => {
    const { dir, cleanup } = await bundleWithLedger({
      minimumVersion: '9.0.0',
      releases: [
        { version: '9.0.0', hashes: build('v9') },
        { version: '10.0.0', hashes: build('v10') },
      ],
    });
    try {
      expect(await labels(dir)).toEqual([
        'this Server bundled toolkit',
        'release 9.0.0',
        'release 10.0.0',
      ]);
    } finally {
      await cleanup();
    }
  });

  // Without the floor, accepting a set is a downgrade path: a Sandbox pinned to a
  // release with a known-bad toolkit would attest cleanly for ever.
  it('refuses a release below the floor even though it is authentic', async () => {
    const { dir, cleanup } = await bundleWithLedger({
      minimumVersion: '9.0.0',
      releases: [{ version: '8.7.0', hashes: build('v8') }],
    });
    try {
      expect(await labels(dir)).toEqual(['this Server bundled toolkit']);
    } finally {
      await cleanup();
    }
  });

  // `9.0.0-rc.1` is not `9.0.0`. A floor that admitted its own pre-releases would
  // accept exactly the builds it was raised to exclude.
  it('places a pre-release below the release it precedes', async () => {
    const { dir, cleanup } = await bundleWithLedger({
      minimumVersion: '9.0.0',
      releases: [
        { version: '9.0.0-rc.1', hashes: build('rc') },
        { version: '9.0.1', hashes: build('patch') },
      ],
    });
    try {
      expect(await labels(dir)).toEqual(['this Server bundled toolkit', 'release 9.0.1']);
    } finally {
      await cleanup();
    }
  });

  // A release that names only some binaries does not describe a build, and half a
  // build must not become a hash that other releases can be mixed with.
  it('skips a release that does not name every boundary binary', async () => {
    const partial = build('v9');
    delete partial[RUNNER_BOUNDARY_BINARIES[1] ?? ''];
    const { dir, cleanup } = await bundleWithLedger({
      minimumVersion: '9.0.0',
      releases: [{ version: '9.0.0', hashes: partial }],
    });
    try {
      expect(await labels(dir)).toEqual(['this Server bundled toolkit']);
    } finally {
      await cleanup();
    }
  });

  // A broken ledger must degrade to the bundle, never to a denial. The ledger can
  // only widen acceptance, so ignoring it cannot admit anything it should not —
  // whereas failing closed would disable the whole fleet, which is the outcome
  // this change exists to prevent happening for no reason.
  it.each([
    ['malformed json', '{ not json'],
    ['wrong shape', JSON.stringify([1, 2, 3])],
    ['a bare JSON null', 'null'],
    ['a bare JSON string', JSON.stringify('published-hashes')],
    [
      'listing releases that are not objects',
      JSON.stringify({ minimumVersion: '9.0.0', releases: [null, 42, 'nine'] }),
    ],
    // No floor is not "no restriction": the floor is what stops a set of accepted
    // builds from being a downgrade path, so a ledger without one is not a ledger.
    ['missing a floor', JSON.stringify({ releases: [{ version: '9.0.0', hashes: build('v9') }] })],
    [
      'floored by an unparsable version',
      JSON.stringify({
        minimumVersion: '9evil.0.0',
        releases: [{ version: '9.0.0', hashes: build('v9') }],
      }),
    ],
    [
      'versioned by an unparsable version',
      JSON.stringify({
        minimumVersion: '9.0.0',
        releases: [{ version: '9evil.0.0', hashes: build('v9') }],
      }),
    ],
    [
      'carrying releases that are not a list',
      JSON.stringify({ minimumVersion: '9.0.0', releases: { '9.0.0': build('v9') } }),
    ],
    [
      'carrying a null hash map',
      JSON.stringify({ minimumVersion: '9.0.0', releases: [{ version: '9.0.0', hashes: null }] }),
    ],
    [
      'non-sha256 entries',
      JSON.stringify({
        minimumVersion: '9.0.0',
        releases: [{ version: '9.0.0', hashes: { x: 'no' } }],
      }),
    ],
  ])('ignores a ledger that is %s', async (_label, body) => {
    const { dir, own, cleanup } = await bundleWithLedger(body);
    try {
      const accepted = await acceptedToolkits(dir);
      expect(accepted.map((toolkit) => toolkit.label)).toEqual(['this Server bundled toolkit']);
      expect(accepted[0]?.hashes.get(SUPERVISOR)).toBe(own);
    } finally {
      await cleanup();
    }
  });

  // The file this repository actually ships must be readable by the reader above,
  // or the structure is in place only in the tests.
  it('reads the ledger this repository ships', async () => {
    const shipped = JSON.parse(
      await readFile('features/verity-sandbox-toolkit/published-hashes.json', 'utf8'),
    ) as { minimumVersion?: unknown; releases?: unknown };
    expect(typeof shipped.minimumVersion).toBe('string');
    expect(Array.isArray(shipped.releases)).toBe(true);
    const accepted = await labels('features/verity-sandbox-toolkit');
    expect(accepted[0]).toBe('this Server bundled toolkit');
    expect(accepted).toContain('release 11.0.0');
    expect(accepted).toContain('release 12.0.0');
  });
});

describe('evaluateRunnerBoundaryEvidence refusals on unreadable identity files', () => {
  const file = (path: string, content: string): ReadonlyMap<string, ImageFileEvidence> =>
    new Map([[path, entry(path, 'file', { content: Buffer.from(content) })]]);

  it.each([
    ['/etc/passwd', '/etc/passwd is missing or is not a regular file'],
    ['/etc/group', '/etc/group is missing or is not a regular file'],
  ])('refuses when %s is a symlink rather than a regular file', (path, reason) => {
    // The symlink even carries perfectly valid bytes — the whole point is that a
    // planted link may resolve outside the image, so the TYPE decides, not the
    // content that happened to come back with it.
    const result = evaluate(
      evidence(
        new Map([
          [
            path,
            entry(path, 'symlink', {
              linkTarget: '/tmp/planted',
              content: Buffer.from(
                path === '/etc/passwd'
                  ? 'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1000::/home/vscode:/bin/sh\nverity-runner:x:1101:1101::/nonexistent:/usr/sbin/nologin\n'
                  : 'root:x:0:\nvscode:x:1000:vscode\nverity-runtime:x:1101:verity-runner\n',
              ),
            }),
          ],
        ]),
      ),
    );
    expect(result.ok === false && result.reason).toBe(reason);
  });

  it('refuses an /etc/passwd line that is not seven colon-separated fields', () => {
    const result = evaluate(evidence(file('/etc/passwd', 'root:x:0:0:root:/root\n')));
    expect(result.ok === false && result.reason).toBe(
      '/etc/passwd could not be parsed unambiguously',
    );
  });

  it('refuses an /etc/passwd uid that is not a plain decimal number', () => {
    // `0x0` parses as 0 under Number() — reading it as root is exactly the
    // ambiguity the boundary refuses to resolve on the image's behalf.
    const result = evaluate(evidence(file('/etc/passwd', 'root:x:0x0:0:root:/root:/bin/sh\n')));
    expect(result.ok === false && result.reason).toBe(
      '/etc/passwd could not be parsed unambiguously',
    );
  });

  it('refuses an /etc/group line that is not four colon-separated fields', () => {
    const result = evaluate(evidence(file('/etc/group', 'root:x:0\n')));
    expect(result.ok === false && result.reason).toBe(
      '/etc/group could not be parsed unambiguously',
    );
  });

  it('refuses a verity-runner that does not sit in the reserved runtime GID', () => {
    const result = evaluate(
      evidence(
        file(
          '/etc/passwd',
          'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1000::/home/vscode:/bin/sh\nverity-runner:x:1101:1000::/nonexistent:/usr/sbin/nologin\n',
        ),
      ),
    );
    expect(result.ok === false && result.reason).toBe(
      'verity-runner does not use the reserved runtime GID 1101',
    );
  });
});

describe('evaluateRunnerBoundaryEvidence agent identity parsing', () => {
  it('refuses a user spec with more than user:group', () => {
    const result = evaluate(evidence(), 'vscode:vscode:extra');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent identity vscode:vscode:extra is invalid',
    );
  });

  it('refuses an empty user part', () => {
    const result = evaluate(evidence(), ':vscode');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent identity :vscode is invalid',
    );
  });

  it('resolves a numeric user against the image passwd', () => {
    expect(evaluate(evidence(), '1000').ok).toBe(true);
  });

  it('refuses a numeric user the image passwd does not define', () => {
    const result = evaluate(evidence(), '4242');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent identity 4242 is missing or ambiguous',
    );
  });

  it('refuses a named user the image passwd does not define', () => {
    const result = evaluate(evidence(), 'ghost');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent identity ghost is missing or ambiguous',
    );
  });

  it('refuses the reserved Runner UID as the agent identity', () => {
    const result = evaluate(evidence(), '1101');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent shares the reserved Runner UID 1101',
    );
  });

  it('resolves a named secondary group and accepts it when it is not the runtime GID', () => {
    expect(evaluate(evidence(), 'vscode:vscode').ok).toBe(true);
  });

  it('refuses a secondary group name the image /etc/group does not define', () => {
    const result = evaluate(evidence(), 'vscode:staff');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent group staff is missing or ambiguous',
    );
  });

  it('refuses a numeric secondary group that is the reserved runtime GID', () => {
    const result = evaluate(evidence(), 'vscode:1101');
    expect(result.ok === false && result.reason).toBe(
      'the sandbox agent is a member of the reserved Runner runtime GID 1101',
    );
  });

  it('falls back to uid 0 when neither the request nor the image names a user', () => {
    // No configured user at all means the container runs as root, which the
    // boundary must refuse rather than silently treat as "unspecified".
    const result = evaluate(evidence(new Map(), '   '));
    expect(result.ok === false && result.reason).toBe('the sandbox agent runs as root');
  });
});

describe('evaluateRunnerBoundaryEvidence filesystem ownership', () => {
  it('refuses a parent directory the evidence does not contain at all', () => {
    const files = new Map(evidence().files);
    files.delete('/usr/local');
    const result = evaluate({ configuredUser: 'vscode', files });
    expect(result.ok === false && result.reason).toBe(
      '/usr/local is missing, not a directory, or traverses a symlink',
    );
  });

  it('refuses a parent directory that is not root-owned', () => {
    const result = evaluate(
      evidence(new Map([['/usr', entry('/usr', 'directory', { uid: 1000 })]])),
    );
    expect(result.ok === false && result.reason).toBe('/usr is not root-owned');
  });

  it('refuses a boundary binary that is not root-owned', () => {
    const path = RUNNER_BOUNDARY_BINARIES[1] ?? '';
    const result = evaluate(evidence(new Map([[path, entry(path, 'file', { uid: 1000 })]])));
    expect(result.ok === false && result.reason).toBe(`${path} is not root-owned`);
  });

  it('refuses a group-writable boundary binary', () => {
    const path = RUNNER_BOUNDARY_BINARIES[2] ?? '';
    const result = evaluate(evidence(new Map([[path, entry(path, 'file', { mode: 0o775 })]])));
    expect(result.ok === false && result.reason).toBe(`${path} is group- or world-writable`);
  });
});

describe('parseDockerArchive header validation', () => {
  const header = (
    name: string,
    fields: {
      mode?: number;
      uid?: number;
      gid?: number;
      size?: number;
      typeFlag?: string;
      linkTarget?: string;
      rawSize?: string;
    } = {},
  ): Buffer => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 'utf8');
    block.write(`${(fields.mode ?? 0o755).toString(8).padStart(7, '0')}\0`, 100, 'ascii');
    block.write(`${(fields.uid ?? 0).toString(8).padStart(7, '0')}\0`, 108, 'ascii');
    block.write(`${(fields.gid ?? 0).toString(8).padStart(7, '0')}\0`, 116, 'ascii');
    if (fields.rawSize !== undefined) block.write(fields.rawSize, 124, 'ascii');
    else block.write(`${(fields.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    block.write(fields.typeFlag ?? '0', 156, 'ascii');
    if (fields.linkTarget !== undefined) block.write(fields.linkTarget, 157, 'utf8');
    return block;
  };

  it('rejects an archive too short to hold a tar header', () => {
    expect(() => parseDockerArchive('/etc/passwd', Buffer.alloc(511))).toThrow(
      'archive has no header',
    );
  });

  it('rejects an entry larger than the evidence limit', () => {
    expect(() =>
      parseDockerArchive('/etc/passwd', header('passwd', { size: 4 * 1024 * 1024 + 1 })),
    ).toThrow('archive metadata is invalid');
  });

  it('rejects a size field that is not octal at all', () => {
    expect(() => parseDockerArchive('/etc/passwd', header('passwd', { rawSize: 'zz\0' }))).toThrow(
      'archive metadata is invalid',
    );
  });

  it('rejects a header whose declared content has not all arrived', () => {
    expect(() => parseDockerArchive('/etc/passwd', header('passwd', { size: 40 }))).toThrow(
      'archive content is truncated',
    );
  });

  it('reads an all-NUL numeric field as zero rather than NaN', () => {
    const block = Buffer.alloc(512);
    block.write('passwd', 0, 'utf8');
    expect(parseDockerArchive('/etc/passwd', block)).toEqual({
      path: '/etc/passwd',
      type: 'file',
      uid: 0,
      gid: 0,
      mode: 0,
      content: Buffer.alloc(0),
    });
  });

  it('reports a symlink entry with the target it points at', () => {
    expect(
      parseDockerArchive(
        '/usr/local/bin/verity-runner-worker',
        header('verity-runner-worker', { typeFlag: '2', linkTarget: '/tmp/planted' }),
      ),
    ).toEqual({
      path: '/usr/local/bin/verity-runner-worker',
      type: 'symlink',
      uid: 0,
      gid: 0,
      mode: 0o755,
      linkTarget: '/tmp/planted',
    });
  });

  it('reports an entry that is neither file, directory nor symlink as other', () => {
    expect(parseDockerArchive('/usr/local/bin', header('bin', { typeFlag: '6' }))).toMatchObject({
      type: 'other',
    });
  });

  it('carries the exact file bytes and permissions the daemon reported', () => {
    const content = Buffer.from('#!/bin/sh\n');
    const archive = Buffer.concat([
      header('verity-runner-supervisor', { size: content.length, mode: 0o755, uid: 0, gid: 0 }),
      content,
    ]);
    expect(parseDockerArchive('/usr/local/bin/verity-runner-supervisor', archive)).toEqual({
      path: '/usr/local/bin/verity-runner-supervisor',
      type: 'file',
      uid: 0,
      gid: 0,
      mode: 0o755,
      content,
    });
  });
});

describe('trustedToolkitIdentity broken-layout reporting', () => {
  // ENOTDIR under a parent that is a FILE is a broken deployment, not a Server
  // that ships no toolkit — reporting absence would mute the drift report.
  it('rethrows ENOTDIR rather than reporting the bundle as absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'toolkit-notdir-'));
    const file = join(root, 'a-file');
    await writeFile(file, 'not a directory\n');
    await expect(trustedToolkitIdentity(join(file, 'nested'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    await rm(root, { recursive: true, force: true });
  });
});

describe('defaultImageEvidenceCollector (ADR 0006 D1 evidence gathering)', () => {
  const CONTAINER_ID = 'f'.repeat(64);
  const PASSWD =
    'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1000::/home/vscode:/bin/sh\nverity-runner:x:1101:1101::/nonexistent:/usr/sbin/nologin\n';
  const GROUP = 'root:x:0:\nvscode:x:1000:vscode\nverity-runtime:x:1101:verity-runner\n';

  function tarBlock(
    name: string,
    fields: { mode?: number; uid?: number; gid?: number; size?: number; typeFlag?: string } = {},
  ): Buffer {
    const block = Buffer.alloc(512);
    block.write(name, 0, 'utf8');
    block.write(`${(fields.mode ?? 0o755).toString(8).padStart(7, '0')}\0`, 100, 'ascii');
    block.write(`${(fields.uid ?? 0).toString(8).padStart(7, '0')}\0`, 108, 'ascii');
    block.write(`${(fields.gid ?? 0).toString(8).padStart(7, '0')}\0`, 116, 'ascii');
    block.write(`${(fields.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    block.write(fields.typeFlag ?? '0', 156, 'ascii');
    return block;
  }

  const fileArchive = (name: string, content: Buffer, mode = 0o644): Buffer =>
    Buffer.concat([tarBlock(name, { size: content.length, mode }), content]);

  const directoryArchive = (name: string): Buffer => tarBlock(name, { typeFlag: '5', mode: 0o755 });

  /** The eleven entries the collector asks for, as Docker would return them. */
  const FIXTURES = new Map<string, Buffer>([
    ['/etc/passwd', fileArchive('passwd', Buffer.from(PASSWD))],
    ['/etc/group', fileArchive('group', Buffer.from(GROUP))],
    ['/', directoryArchive('/')],
    ['/usr', directoryArchive('usr/')],
    ['/usr/local', directoryArchive('local/')],
    ['/usr/local/bin', directoryArchive('bin/')],
    ...RUNNER_BOUNDARY_BINARIES.map(
      (path) =>
        [path, fileArchive(path.slice(path.lastIndexOf('/') + 1), BINARY_BYTES, 0o755)] as const,
    ),
  ]);

  interface ArchiveServer {
    dockerHost: string;
    endpoints: string[];
    close: () => Promise<void>;
  }

  async function startArchiveServer(
    handler: (path: string, response: nodeHttp.ServerResponse) => void = (path, response) => {
      const archive = FIXTURES.get(path);
      if (archive === undefined) {
        response.statusCode = 404;
        response.end('{"message":"not found"}');
        return;
      }
      response.statusCode = 200;
      response.end(archive);
    },
    opts: { unixSocket?: boolean } = {},
  ): Promise<ArchiveServer> {
    const endpoints: string[] = [];
    const server = nodeHttp.createServer((request, response) => {
      response.on('error', () => undefined);
      endpoints.push(request.url ?? '');
      const path = new URL(request.url ?? '', 'http://docker.local').searchParams.get('path') ?? '';
      handler(path, response);
    });
    let dockerHost: string;
    let dir: string | undefined;
    if (opts.unixSocket === true) {
      dir = mkdtempSync(join(tmpdir(), 'attest-sock-'));
      const socketPath = join(dir, 'docker.sock');
      await new Promise<void>((resolve) => server.listen({ path: socketPath }, () => resolve()));
      dockerHost = `unix://${socketPath}`;
    } else {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      dockerHost = `http://127.0.0.1:${String(port)}`;
    }
    return {
      dockerHost,
      endpoints,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** The `docker` CLI half: a stopped container id, then its Config.User. */
  function cliServing(user: string | number = 'vscode'): (args: readonly string[]) => string {
    return (args) => {
      if (args[0] === 'create') return `${CONTAINER_ID}\n`;
      if (args[0] === 'container') return `${JSON.stringify(user)}\n`;
      return '';
    };
  }

  beforeEach(() => {
    dockerCli.calls.length = 0;
    dockerCli.run = cliServing();
  });

  it('creates a stopped snapshot, reads its user, gathers evidence and removes it', async () => {
    const server = await startArchiveServer();
    try {
      const collected = await defaultImageEvidenceCollector({
        imageRef: 'ghcr.io/heey-global/dev-base:2026.06',
        dockerHost: server.dockerHost,
      });

      // The snapshot must never be able to run: `--entrypoint /bin/false` is the
      // whole reason this is evidence and not execution inside the image.
      expect(dockerCli.calls.map((call) => call.args)).toEqual([
        ['create', '--entrypoint', '/bin/false', 'ghcr.io/heey-global/dev-base:2026.06'],
        ['container', 'inspect', '--format', '{{json .Config.User}}', CONTAINER_ID],
        ['rm', '-f', CONTAINER_ID],
      ]);
      expect(dockerCli.calls.every((call) => call.file === 'docker')).toBe(true);
      expect(dockerCli.calls[0]?.env.DOCKER_HOST).toBe(server.dockerHost);

      // Evidence is read from the stopped CONTAINER, not the mutable image tag.
      expect(server.endpoints[0]).toBe(
        `/containers/${CONTAINER_ID}/archive?path=${encodeURIComponent('/etc/passwd')}`,
      );
      expect(server.endpoints).toContain(
        `/containers/${CONTAINER_ID}/archive?path=${encodeURIComponent('/usr/local/bin')}`,
      );
      expect(server.endpoints).toHaveLength(6 + RUNNER_BOUNDARY_BINARIES.length);

      expect(collected.configuredUser).toBe('vscode');
      expect(collected.files.get('/etc/passwd')).toEqual({
        path: '/etc/passwd',
        type: 'file',
        uid: 0,
        gid: 0,
        mode: 0o644,
        content: Buffer.from(PASSWD),
      });
      expect(collected.files.get('/usr/local')).toEqual({
        path: '/usr/local',
        type: 'directory',
        uid: 0,
        gid: 0,
        mode: 0o755,
      });
      // End to end: evidence taken straight off the daemon attests.
      expect(evaluate(collected)).toEqual({
        ok: true,
        toolkitIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      });
    } finally {
      await server.close();
    }
  });

  it('reads evidence over a mounted docker unix socket', async () => {
    const server = await startArchiveServer(undefined, { unixSocket: true });
    try {
      const collected = await defaultImageEvidenceCollector({
        imageRef: 'dev-base:local',
        dockerHost: server.dockerHost,
        timeoutMs: 5_000,
      });
      expect(collected.files.get('/usr/local/bin')?.type).toBe('directory');
      expect(server.endpoints[1]).toBe(
        `/containers/${CONTAINER_ID}/archive?path=${encodeURIComponent('/etc/group')}`,
      );
    } finally {
      await server.close();
    }
  });

  it('reassembles a file whose header arrives before all of its bytes', async () => {
    const content = Buffer.from(PASSWD);
    const server = await startArchiveServer((path, response) => {
      if (path !== '/etc/passwd') {
        const archive = FIXTURES.get(path);
        response.statusCode = archive === undefined ? 404 : 200;
        response.end(archive);
        return;
      }
      response.statusCode = 200;
      // Header first, content one tick later — the reader must keep waiting
      // instead of treating the short read as a corrupt archive.
      response.write(tarBlock('passwd', { size: content.length, mode: 0o644 }));
      setTimeout(() => response.end(content), 10);
    });
    try {
      const collected = await defaultImageEvidenceCollector({
        imageRef: 'dev-base:local',
        dockerHost: server.dockerHost,
      });
      expect(collected.files.get('/etc/passwd')?.content).toEqual(content);
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      'the daemon refuses the archive read',
      (path: string, response: nodeHttp.ServerResponse): void => {
        // The refusal body is a perfectly well-formed tar entry. Only the status
        // code says this is not evidence, so the status code has to be what
        // decides — a refused read must never be parsed as an image fact.
        response.statusCode = path === '/etc/group' ? 403 : 200;
        response.end(FIXTURES.get(path));
      },
    ],
    [
      'the archive names a nested path the evidence set never contains',
      (path: string, response: nodeHttp.ServerResponse): void => {
        response.statusCode = 200;
        response.end(path === '/etc/group' ? tarBlock('etc/group') : FIXTURES.get(path));
      },
    ],
    [
      'the response ends before a full tar header',
      (path: string, response: nodeHttp.ServerResponse): void => {
        response.statusCode = 200;
        response.end(path === '/etc/group' ? Buffer.alloc(16) : FIXTURES.get(path));
      },
    ],
  ])('refuses safely when %s', async (_label, handler) => {
    const server = await startArchiveServer(handler);
    try {
      await expect(
        defaultImageEvidenceCollector({
          imageRef: 'dev-base:local',
          dockerHost: server.dockerHost,
        }),
      ).rejects.toThrow('/etc/group could not be read safely from the sandbox image');
      // The stopped snapshot is removed even when the read failed.
      expect(dockerCli.calls.at(-1)?.args).toEqual(['rm', '-f', CONTAINER_ID]);
    } finally {
      await server.close();
    }
  });

  it('refuses an archive that keeps streaming past the evidence limit', async () => {
    const chunk = Buffer.alloc(512 * 1024, 120);
    const server = await startArchiveServer((path, response) => {
      if (path !== '/etc/passwd') {
        response.statusCode = 200;
        response.end(FIXTURES.get(path));
        return;
      }
      response.statusCode = 200;
      // A header that declares exactly the limit, then a body that never stops.
      response.write(tarBlock('passwd', { size: 4 * 1024 * 1024 }));
      const pump = (): void => {
        if (response.writableEnded || response.destroyed) return;
        response.write(chunk, () => setTimeout(pump, 0));
      };
      pump();
    });
    try {
      await expect(
        defaultImageEvidenceCollector({
          imageRef: 'dev-base:local',
          dockerHost: server.dockerHost,
        }),
      ).rejects.toThrow('/etc/passwd could not be read safely from the sandbox image');
    } finally {
      await server.close();
    }
  });

  it('refuses when the daemon never answers within the timeout', async () => {
    const server = await startArchiveServer(() => {
      /* hold the request open so the per-request timeout is what ends it */
    });
    try {
      await expect(
        defaultImageEvidenceCollector({
          imageRef: 'dev-base:local',
          dockerHost: server.dockerHost,
          timeoutMs: 120,
        }),
      ).rejects.toThrow('/etc/passwd could not be read safely from the sandbox image');
    } finally {
      await server.close();
    }
  });

  it('refuses when the docker endpoint cannot be reached at all', async () => {
    const server = await startArchiveServer();
    const { dockerHost } = server;
    await server.close();
    await expect(
      defaultImageEvidenceCollector({ imageRef: 'dev-base:local', dockerHost }),
    ).rejects.toThrow('/etc/passwd could not be read safely from the sandbox image');
  });

  it('reports a snapshot that could not be created without leaking daemon detail', async () => {
    dockerCli.run = () => {
      throw new Error('docker: Error response from daemon: pull access denied for secret/img');
    };
    await expect(
      defaultImageEvidenceCollector({
        imageRef: 'secret/img:1',
        dockerHost: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow('a stopped filesystem snapshot could not be created from the sandbox image');
  });

  it('reports an image configuration that could not be inspected', async () => {
    dockerCli.run = (args) => {
      if (args[0] === 'create') return `${CONTAINER_ID}\n`;
      if (args[0] === 'container') throw new Error('inspect blew up');
      return '';
    };
    await expect(
      defaultImageEvidenceCollector({
        imageRef: 'dev-base:local',
        dockerHost: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow('the sandbox image configuration could not be inspected');
    expect(dockerCli.calls.at(-1)?.args).toEqual(['rm', '-f', CONTAINER_ID]);
  });

  it('refuses a create that did not return a container id', async () => {
    dockerCli.run = () => 'Cannot connect to the Docker daemon\n';
    await expect(
      defaultImageEvidenceCollector({
        imageRef: 'dev-base:local',
        dockerHost: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow('docker returned no container id');
    // Nothing was created, so nothing may be removed under a guessed id.
    expect(dockerCli.calls).toHaveLength(1);
  });

  it('refuses an image whose configured user is not a string', async () => {
    dockerCli.run = cliServing(1000);
    await expect(
      defaultImageEvidenceCollector({
        imageRef: 'dev-base:local',
        dockerHost: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow('image user is not a string');
  });

  it('attestRunnerSupervisorBoundary surfaces the collector safe reason verbatim', async () => {
    dockerCli.run = () => {
      throw new Error('docker: pull access denied for secret/img');
    };
    // No evidenceCollector → the default one runs, and its EvidenceError reason
    // is the only thing a caller may see about a failed snapshot.
    await expect(
      attestRunnerSupervisorBoundary({
        imageRef: 'secret/img:1',
        dockerHost: 'http://127.0.0.1:1',
        featureDir: 'features/verity-sandbox-toolkit',
        ...IDS,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'a stopped filesystem snapshot could not be created from the sandbox image',
    });
  });
});
