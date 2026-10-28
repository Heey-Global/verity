import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEVCONTAINER_BUILDER_CONTRACT,
  DEVCONTAINER_BUILDER_LABEL,
  reconcileDevcontainerBuilder,
} from './devcontainer-builder.js';

const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function hostDir(options: { receipt?: boolean; agent?: object } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'verity-host-builder-request-'));
  dirs.push(dir);
  if (options.receipt !== false)
    await writeFile(join(dir, 'devcontainer-builder.json'), '{"version":1,"gid":1102}\n');
  await writeFile(
    join(dir, 'agent.json'),
    JSON.stringify(
      options.agent ?? { version: 1, trigger: 'systemd-path', builder: 'systemd-path' },
    ),
  );
  return dir;
}

const labelled = (value: string | null = DEVCONTAINER_BUILDER_CONTRACT) => ({
  inspectImageLabels: vi.fn(async () =>
    value === null ? {} : { [DEVCONTAINER_BUILDER_LABEL]: value },
  ),
});

/** The host component answering whatever request is on file, once asked. */
function answer(
  dir: string,
  ok: boolean,
  message = 'the devcontainer builder now matches this release',
) {
  return async () => {
    const request = JSON.parse(await readFile(join(dir, 'builder-request.json'), 'utf8')) as {
      id: string;
    };
    await writeFile(
      join(dir, 'builder-result.json'),
      JSON.stringify({ version: 1, id: request.id, ok, message }),
    );
  };
}

describe('the devcontainer builder contract', () => {
  // A release that ships the bundle without the label never reaches the host; a host component
  // expecting another value refuses every image. Either way the builder silently stays old.
  it('is the same in the image label, the Updater and the host component', () => {
    const label = /^LABEL org\.verity\.devcontainer-builder="(.*)"$/mu.exec(
      readFileSync('deploy/Dockerfile', 'utf8'),
    );
    expect(label?.[1]).toBe(DEVCONTAINER_BUILDER_CONTRACT);
    const host = readFileSync('deploy/host/verity-host-builder', 'utf8');
    expect(host).toContain(`CONTRACT_LABEL='${DEVCONTAINER_BUILDER_LABEL}'`);
    expect(host).toContain(`CONTRACT='${DEVCONTAINER_BUILDER_CONTRACT}'`);
  });
});

describe('reconcileDevcontainerBuilder', () => {
  it('asks the host to install the bundle of the target image, naming only that image', async () => {
    const dir = await hostDir();
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
      sleep: answer(dir, true),
    });
    expect(outcome).toEqual({
      state: 'reconciled',
      message: 'the devcontainer builder now matches this release',
    });
    expect(JSON.parse(await readFile(join(dir, 'builder-request.json'), 'utf8'))).toEqual({
      version: 1,
      id: 'update-1',
      image,
    });
  });

  it.each([
    ['a release from before the bundle contract', null, true],
    ['a host the installer never set a builder up on', DEVCONTAINER_BUILDER_CONTRACT, false],
  ])('asks nothing for %s', async (_, label, receipt) => {
    const dir = await hostDir({ receipt });
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(label),
      image,
      requestId: 'update-1',
      requestDir: dir,
    });
    expect(outcome.state).toBe('skipped');
    await expect(readFile(join(dir, 'builder-request.json'))).rejects.toThrow();
  });

  // The host from before this component has nothing that answers; waiting would only delay the
  // update by the whole timeout before saying the same thing.
  it('names the one installer run a host with older host components needs', async () => {
    const dir = await hostDir({ agent: { version: 1, trigger: 'systemd-path' } });
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
    });
    expect(outcome).toMatchObject({ state: 'failed' });
    expect(outcome.state === 'failed' && outcome.message).toContain('Re-run the Verity installer');
    await expect(readFile(join(dir, 'builder-request.json'))).rejects.toThrow();
  });

  it('reports the reason the host gives for a failed installation', async () => {
    const dir = await hostDir();
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
      sleep: answer(
        dir,
        false,
        'the builder installation failed; the previous builder was restored',
      ),
    });
    expect(outcome).toEqual({
      state: 'failed',
      message:
        'The host could not update the devcontainer builder: the builder installation failed; the previous builder was restored',
    });
  });

  // The refusal an installed component with contract 1 gives, taken from its own die line.
  const olderHostRefusal = () => {
    const line = /die "(\$image does not declare \$CONTRACT_LABEL=\$CONTRACT;[^"]*)"/u.exec(
      readFileSync('deploy/host/verity-host-builder', 'utf8'),
    )?.[1];
    expect(line).toBeDefined();
    return (line ?? '')
      .replace('$image', image)
      .replace('$CONTRACT_LABEL', DEVCONTAINER_BUILDER_LABEL)
      .replace('$CONTRACT', '1');
  };
  // A host component from an earlier installer refuses every image of a newer contract,
  // in the words verity-host-builder uses; only the installer can replace it.
  it('names the installer run when the host component refuses a newer contract', async () => {
    const dir = await hostDir();
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
      sleep: answer(dir, false, olderHostRefusal()),
    });
    expect(outcome).toMatchObject({ state: 'failed' });
    expect(outcome.state === 'failed' && outcome.message).toContain('older builder contract');
    expect(outcome.state === 'failed' && outcome.message).toContain('Re-run the Verity installer');
  });

  it('gives up when nothing answers before the deadline', async () => {
    const dir = await hostDir();
    let clock = 0;
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
      timeoutMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(outcome).toMatchObject({ state: 'failed' });
    expect(outcome.state === 'failed' && outcome.message).toContain('verity-host-builder');
  });

  it('reuses the answer a resumed operation already got', async () => {
    const dir = await hostDir();
    await writeFile(
      join(dir, 'builder-result.json'),
      JSON.stringify({ version: 1, id: 'update-1', ok: true, message: 'done' }),
    );
    const outcome = await reconcileDevcontainerBuilder({
      docker: labelled(),
      image,
      requestId: 'update-1',
      requestDir: dir,
    });
    expect(outcome).toEqual({ state: 'reconciled', message: 'done' });
    await expect(readFile(join(dir, 'builder-request.json'))).rejects.toThrow();
  });
});
