import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE,
  LABEL_FILE,
  PIN_FILE,
  expectedFiles,
  readPins,
  renderPins,
  resolvePublished,
} from './gvisor-pins.mjs';

const sha512 = (data: string | Uint8Array) => createHash('sha512').update(data).digest('hex');
const read = (path: string) => readFileSync(path, 'utf8');
const hasTar = ['tar', 'bzip2'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('gVisor pin rendering', () => {
  const current = readPins(read(PIN_FILE));
  const published = {
    release: current.RUNSC_RELEASE!,
    sha512: { x86_64: current.RUNSC_SHA512_X86_64!, aarch64: current.RUNSC_SHA512_AARCH64! },
    ...(current.RUNSC_ARCHIVE_SHA512_X86_64 === undefined
      ? {}
      : {
          archiveSha512: {
            x86_64: current.RUNSC_ARCHIVE_SHA512_X86_64,
            aarch64: current.RUNSC_ARCHIVE_SHA512_AARCH64!,
          },
        }),
  };

  it('reproduces every pinned file from the pins it already holds', () => {
    // The renderer writes what a Renovate branch commits; it must not reformat what it owns.
    const files = expectedFiles(published, read);
    for (const path of [PIN_FILE, LABEL_FILE, CONFIG_FILE])
      expect(files[path], path).toBe(read(path));
  });

  it('switches every pin to an archive release and back', () => {
    const archive = {
      release: 'release-20261026.0',
      sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
      archiveSha512: { x86_64: 'c'.repeat(128), aarch64: 'd'.repeat(128) },
    };
    const files = expectedFiles(archive, read);
    expect(readPins(files[PIN_FILE])).toMatchObject({
      RUNSC_RELEASE: 'release-20261026.0',
      RUNSC_SHA512_X86_64: 'a'.repeat(128),
      RUNSC_ARCHIVE_SHA512_X86_64: 'c'.repeat(128),
      RUNSC_ARCHIVE_SHA512_AARCH64: 'd'.repeat(128),
    });
    // Everything else in the pin file stays where it is.
    expect(readPins(files[PIN_FILE]).RUNSC_PROJECT_ARGS).toBe(current.RUNSC_PROJECT_ARGS);
    const label = /^LABEL org\.verity\.host-runtimes="(.*)"$/mu.exec(files[LABEL_FILE])?.[1];
    expect(JSON.parse(label!.replaceAll('\\"', '"'))).toMatchObject({
      release: 'release-20261026.0',
      archiveSha512: archive.archiveSha512,
    });
    expect(files[CONFIG_FILE]).toContain("PINNED_RUNSC_RELEASE = 'release-20261026.0';");

    const back = renderPins(files[PIN_FILE], { ...published, archiveSha512: undefined });
    expect(back).not.toContain('RUNSC_ARCHIVE_SHA512');
  });
});

describe.skipIf(!hasTar)('what gVisor published', () => {
  const release = 'release-20261026.0';

  function archive(runsc: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gvisor-pins-fixture-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'runsc'), runsc);
    const file = join(dir, 'gvisor.tar.bz2');
    expect(spawnSync('tar', ['-cjf', file, '-C', dir, 'runsc']).status).toBe(0);
    return new Uint8Array(readFileSync(file));
  }

  /** A release bucket and a GitHub release, answering from `files`. */
  function upstream(files: Record<string, Uint8Array | string>) {
    const fetch = async (url: string) => {
      const body = files[url];
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(typeof body === 'string' ? body : Buffer.from(body));
    };
    return {
      fetch: fetch as typeof globalThis.fetch,
      bucket: 'https://bucket',
      github: 'https://gh',
    };
  }

  function archiveRelease(overrides: Record<string, Uint8Array | string> = {}) {
    const x86 = archive('runsc x86_64');
    const arm = archive('runsc aarch64');
    const sums = `${sha512(arm)}  gvisor-aarch64.tar.bz2\n${sha512(x86)}  gvisor-x86_64.tar.bz2\n`;
    return {
      x86,
      arm,
      files: {
        'https://bucket/20261026.0/x86_64/gvisor.tar.bz2': x86,
        'https://bucket/20261026.0/x86_64/gvisor.tar.bz2.sha512': `${sha512(x86)}  gvisor.tar.bz2\n`,
        'https://bucket/20261026.0/aarch64/gvisor.tar.bz2': arm,
        'https://bucket/20261026.0/aarch64/gvisor.tar.bz2.sha512': `${sha512(arm)}  gvisor.tar.bz2\n`,
        [`https://gh/${release}/SHA512SUMS`]: sums,
        ...overrides,
      },
    };
  }

  it('pins both archives and the runsc inside each', async () => {
    const { x86, arm, files } = archiveRelease();
    await expect(resolvePublished(release, upstream(files))).resolves.toEqual({
      release,
      sha512: { x86_64: sha512('runsc x86_64'), aarch64: sha512('runsc aarch64') },
      archiveSha512: { x86_64: sha512(x86), aarch64: sha512(arm) },
    });
  });

  it('refuses an archive the bucket and GitHub disagree on', async () => {
    const { files } = archiveRelease({
      [`https://gh/${release}/SHA512SUMS`]: `${'e'.repeat(128)}  gvisor-x86_64.tar.bz2\n`,
    });
    await expect(resolvePublished(release, upstream(files))).rejects.toThrow(/disagree/u);
  });

  it('refuses a download that does not match its published checksum', async () => {
    const { files } = archiveRelease({
      'https://bucket/20261026.0/x86_64/gvisor.tar.bz2': archive('tampered'),
    });
    await expect(resolvePublished(release, upstream(files))).rejects.toThrow(
      /does not match its published checksum/u,
    );
  });

  it('pins a single-binary release as before', async () => {
    const files = {
      'https://bucket/20260714.0/x86_64/runsc': 'x86',
      'https://bucket/20260714.0/x86_64/runsc.sha512': `${sha512('x86')}  runsc\n`,
      'https://bucket/20260714.0/aarch64/runsc': 'arm',
      'https://bucket/20260714.0/aarch64/runsc.sha512': `${sha512('arm')}  runsc\n`,
    };
    await expect(resolvePublished('release-20260714.0', upstream(files))).resolves.toEqual({
      release: 'release-20260714.0',
      sha512: { x86_64: sha512('x86'), aarch64: sha512('arm') },
    });
  });

  it('refuses a release that publishes nothing a host could install', async () => {
    await expect(resolvePublished('release-20260824.0', upstream({}))).rejects.toThrow(
      /publishes neither/u,
    );
  });

  it('refuses a release that ships an archive for only one architecture', async () => {
    const { files } = archiveRelease();
    delete files['https://bucket/20261026.0/aarch64/gvisor.tar.bz2.sha512'];
    await expect(resolvePublished(release, upstream(files))).rejects.toThrow(
      /publishes neither|only some architectures/u,
    );
  });
});

describe('the gVisor pin workflow', () => {
  const workflow = parse(read('.github/workflows/renovate-gvisor.yml')) as {
    on: { pull_request: { paths: string[] } };
    jobs: Record<string, { if: string; steps: { run?: string }[] }>;
  };

  it('derives the pins on Renovate branches and checks them everywhere else', () => {
    expect(workflow.on.pull_request.paths).toContain(PIN_FILE);
    const renovate = workflow.jobs.derive!.if.trim();
    expect(renovate).toContain("github.event.sender.login == 'renovate[bot]'");
    expect(workflow.jobs.check!.if.replace(/\s+/gu, ' ')).toBe(
      `!(${renovate.replace(/\s+/gu, ' ')})`,
    );
    expect(workflow.jobs.derive!.steps.at(-1)?.run).toContain('scripts/renovate-gvisor-pins.mjs');
    expect(workflow.jobs.check!.steps.at(-1)?.run).toBe('node scripts/gvisor-pins.mjs check');
  });
});
