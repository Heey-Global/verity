import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDockerClient, type DockerRuntimeRegistration } from '../docker.js';
import {
  PINNED_PROJECT_RUNSC_ARGS,
  PINNED_RUNSC_ARGS,
  PINNED_RUNSC_PATH,
  PINNED_RUNSC_RELEASE,
} from '../gvisor-runtime-config.js';
import {
  HOST_RUNTIMES_LABEL,
  HostRuntimeError,
  parseHostRuntimeRequirements,
  readTargetHostRuntimes,
  reconcileHostRuntimes,
  type HostRuntimeRequirements,
} from './host-runtimes.js';

// The declaration every build of deploy/Dockerfile carries, read out of the Dockerfile itself:
// what this suite exercises is what a real target image hands the Updater.
const labelLine = /^LABEL org\.verity\.host-runtimes="(.*)"$/mu.exec(
  readFileSync('deploy/Dockerfile', 'utf8'),
);
const declared = parseHostRuntimeRequirements(JSON.parse(labelLine![1]!.replaceAll('\\"', '"')));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function requestDir(agent?: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'verity-host-runtime-request-'));
  dirs.push(dir);
  if (agent !== undefined) await writeFile(join(dir, 'agent.json'), JSON.stringify(agent));
  return dir;
}

/** A dockerd whose registrations change when the fake host component answers. */
function daemon(initial: Record<string, DockerRuntimeRegistration>) {
  const runtimes = { ...initial };
  return {
    runtimes,
    docker: { inspectRuntime: vi.fn(async (name: string) => runtimes[name]) },
  };
}

const secretOnly = { runsc: { path: PINNED_RUNSC_PATH, args: [...PINNED_RUNSC_ARGS] } };
const both = {
  ...secretOnly,
  'runsc-project': { path: PINNED_RUNSC_PATH, args: [...PINNED_PROJECT_RUNSC_ARGS] },
};

describe('the host runtimes a release declares', () => {
  it('is what the Server verifies against, in the image every build produces', () => {
    expect(declared).not.toBeNull();
    expect(declared).toEqual({
      release: PINNED_RUNSC_RELEASE,
      sha512: expect.objectContaining({}),
      runtimes: { runsc: [...PINNED_RUNSC_ARGS], 'runsc-project': [...PINNED_PROJECT_RUNSC_ARGS] },
    });
  });

  it('is readable through the production Docker client', () => {
    // A client without these would make readTargetHostRuntimes declare nothing, and every
    // update would skip the host check.
    const docker = createDockerClient({ baseUrl: 'http://docker.invalid' });
    expect(typeof docker.inspectImageLabels).toBe('function');
    expect(typeof docker.inspectRuntime).toBe('function');
  });

  it('treats a release from before the label as declaring nothing', async () => {
    await expect(
      readTargetHostRuntimes({ inspectImageLabels: async () => ({}) }, 'image'),
    ).resolves.toBeUndefined();
  });

  it('refuses a label it cannot read rather than skipping the check', async () => {
    const docker = { inspectImageLabels: async () => ({ [HOST_RUNTIMES_LABEL]: '{"release":1}' }) };
    await expect(readTargetHostRuntimes(docker, 'image')).rejects.toThrow(HostRuntimeError);
  });

  it('refuses arguments the host component would refuse', () => {
    const widened = {
      ...declared!,
      runtimes: { ...declared!.runtimes, runsc: ['--network=host'] },
    };
    expect(parseHostRuntimeRequirements(widened)).toBeNull();
  });
});

describe('reconcileHostRuntimes', () => {
  const requirements = declared as HostRuntimeRequirements;
  const fast = {
    timeoutMs: 2_000,
    pollMs: 5,
    sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
  };

  it('asks nothing of a host that already matches', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir();
    await reconcileHostRuntimes({
      docker,
      requirements,
      requestId: 'u1',
      requestDir: dir,
      ...fast,
    });
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });

  it('has the host component add runsc-project, then verifies it through Docker', async () => {
    const { docker, runtimes } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    // Stands in for the path unit: answer once the request lands.
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async (body) => {
          clearInterval(answer);
          const request = JSON.parse(body) as { id: string; requirements: HostRuntimeRequirements };
          expect(request.requirements).toEqual(requirements);
          runtimes['runsc-project'] = {
            path: PINNED_RUNSC_PATH,
            args: [...PINNED_PROJECT_RUNSC_ARGS],
          };
          await writeFile(
            join(dir, 'result.json'),
            JSON.stringify({ version: 1, id: request.id, ok: true }),
          );
        },
        () => undefined,
      );
    }, 5);
    await reconcileHostRuntimes({
      docker,
      requirements,
      requestId: 'u2',
      requestDir: dir,
      ...fast,
    });
    clearInterval(answer);
  });

  it('tells the operator to run verity-install on a host that predates the service', async () => {
    const { docker } = daemon(secretOnly);
    const dir = await requestDir();
    await expect(
      reconcileHostRuntimes({ docker, requirements, requestId: 'u3', requestDir: dir, ...fast }),
    ).rejects.toThrow(/runsc-project .*the Verity installer/su);
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });

  it('does not wait on a host without systemd, where nothing can answer', async () => {
    const { docker } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'none' });
    await expect(
      reconcileHostRuntimes({ docker, requirements, requestId: 'u4', requestDir: dir, ...fast }),
    ).rejects.toThrow(/no systemd/u);
  });

  it("relays the host component's failure", async () => {
    const { docker } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async () => {
          clearInterval(answer);
          await writeFile(
            join(dir, 'result.json'),
            JSON.stringify({
              version: 1,
              id: 'u5',
              ok: false,
              message: 'runsc could not be downloaded',
            }),
          );
        },
        () => undefined,
      );
    }, 5);
    await expect(
      reconcileHostRuntimes({ docker, requirements, requestId: 'u5', requestDir: dir, ...fast }),
    ).rejects.toThrow(/could not register it: runsc could not be downloaded/u);
    clearInterval(answer);
  });

  it('waits for a fresh answer rather than rereading an earlier failure for the same operation', async () => {
    const { docker, runtimes } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    // A resumed operation whose first attempt failed (say, no egress); the operator has since
    // fixed the host. Reading that old failure back would fail the update the host now serves.
    const stale = join(dir, 'result.json');
    await writeFile(stale, JSON.stringify({ version: 1, id: 'u9', ok: false, message: 'old' }));
    await utimes(stale, new Date(0), new Date(0));
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async () => {
          clearInterval(answer);
          runtimes['runsc-project'] = {
            path: PINNED_RUNSC_PATH,
            args: [...PINNED_PROJECT_RUNSC_ARGS],
          };
          // Replaced by rename, as the host component does.
          await writeFile(`${stale}.tmp`, JSON.stringify({ version: 1, id: 'u9', ok: true }));
          await rename(`${stale}.tmp`, stale);
        },
        () => undefined,
      );
    }, 5);
    await reconcileHostRuntimes({
      docker,
      requirements,
      requestId: 'u9',
      requestDir: dir,
      ...fast,
    });
    clearInterval(answer);
  });

  it('gives up with an actionable message when nothing answers', async () => {
    const { docker } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    await expect(
      reconcileHostRuntimes({
        docker,
        requirements,
        requestId: 'u6',
        requestDir: dir,
        ...fast,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/journalctl -u verity-host-runtime/u);
  });

  it('does not accept a success that Docker does not confirm', async () => {
    const { docker } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    await writeFile(join(dir, 'result.json'), JSON.stringify({ version: 1, id: 'u7', ok: true }));
    await expect(
      reconcileHostRuntimes({ docker, requirements, requestId: 'u7', requestDir: dir, ...fast }),
    ).rejects.toThrow(/still does not report runsc-project/u);
  });

  it('resumes an interrupted operation from its own earlier answer', async () => {
    const { docker, runtimes } = daemon(secretOnly);
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    // The Updater died after the host answered; dockerd already has the runtime.
    runtimes['runsc-project'] = { path: PINNED_RUNSC_PATH, args: [...PINNED_PROJECT_RUNSC_ARGS] };
    await writeFile(join(dir, 'result.json'), JSON.stringify({ version: 1, id: 'u8', ok: true }));
    await reconcileHostRuntimes({
      docker,
      requirements,
      requestId: 'u8',
      requestDir: dir,
      ...fast,
    });
  });
});
