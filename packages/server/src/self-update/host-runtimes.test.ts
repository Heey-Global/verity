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
    expect(declared).toMatchObject({
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
  // A host on the current runtime service, which installs the archive the declared release pins.
  const currentAgent = {
    version: 1,
    trigger: 'systemd-path',
    runtimeArtifacts: ['binary', 'archive'],
  };
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
    const dir = await requestDir(currentAgent);
    // Stands in for the path unit: answer once the request lands.
    let answered = false;
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async (body) => {
          if (answered) return;
          answered = true;
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
    const dir = await requestDir(currentAgent);
    let answered = false;
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async () => {
          // Clearing the timer does not cancel reads already in flight.
          if (answered) return;
          answered = true;
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
    const dir = await requestDir(currentAgent);
    // A resumed operation whose first attempt failed (say, no egress); the operator has since
    // fixed the host. Reading that old failure back would fail the update the host now serves.
    const stale = join(dir, 'result.json');
    await writeFile(stale, JSON.stringify({ version: 1, id: 'u9', ok: false, message: 'old' }));
    await utimes(stale, new Date(0), new Date(0));
    let answered = false;
    const answer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async () => {
          // Clearing the timer does not cancel reads already in flight.
          if (answered) return;
          answered = true;
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
    const dir = await requestDir(currentAgent);
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
    const dir = await requestDir(currentAgent);
    await writeFile(join(dir, 'result.json'), JSON.stringify({ version: 1, id: 'u7', ok: true }));
    await expect(
      reconcileHostRuntimes({ docker, requirements, requestId: 'u7', requestDir: dir, ...fast }),
    ).rejects.toThrow(/still does not report runsc-project/u);
  });

  it('resumes an interrupted operation from its own earlier answer', async () => {
    const { docker, runtimes } = daemon(secretOnly);
    const dir = await requestDir(currentAgent);
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

describe('a release that pins a gVisor release archive', () => {
  const archiveRelease = 'release-20261026.0';
  const archivePath = `/opt/verity/runsc/${archiveRelease}/runsc`;
  const archived: HostRuntimeRequirements = {
    release: archiveRelease,
    sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
    archiveSha512: { x86_64: 'c'.repeat(128), aarch64: 'd'.repeat(128) },
    runtimes: { runsc: [...PINNED_RUNSC_ARGS], 'runsc-project': [...PINNED_PROJECT_RUNSC_ARGS] },
  };
  const registered = {
    runsc: { path: archivePath, args: [...PINNED_RUNSC_ARGS] },
    'runsc-project': { path: archivePath, args: [...PINNED_PROJECT_RUNSC_ARGS] },
  };
  const fast = {
    timeoutMs: 2_000,
    pollMs: 5,
    sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
  };
  // A host still on the last single-binary release, which the archive release replaces.
  const binaryPath = '/opt/verity/runsc/release-20260714.0/runsc';
  const binaryOnly = {
    runsc: { path: binaryPath, args: [...PINNED_RUNSC_ARGS] },
    'runsc-project': { path: binaryPath, args: [...PINNED_PROJECT_RUNSC_ARGS] },
  };
  const legacyAgent = { version: 1, trigger: 'systemd-path', builder: 'systemd-path' };
  const archiveAgent = { ...legacyAgent, runtimeArtifacts: ['binary', 'archive'] };

  /** Stands in for the path unit: register the runtimes and answer the first request. */
  function answerFirstRequest(dir: string, runtimes: Record<string, DockerRuntimeRegistration>) {
    let answered = false;
    const timer = setInterval(() => {
      void readFile(join(dir, 'request.json'), 'utf8').then(
        async (body) => {
          if (answered) return;
          answered = true;
          clearInterval(timer);
          const request = JSON.parse(body) as { id: string; requirements: unknown };
          expect(request.requirements).toEqual(archived);
          Object.assign(runtimes, registered);
          await writeFile(
            join(dir, 'result.json'),
            JSON.stringify({ version: 1, id: request.id, ok: true }),
          );
        },
        () => undefined,
      );
    }, 5);
    return () => clearInterval(timer);
  }

  it('parses the archive pin and refuses a malformed one', () => {
    expect(parseHostRuntimeRequirements(archived)).toEqual(archived);
    expect(
      parseHostRuntimeRequirements({ ...archived, archiveSha512: { x86_64: 'c'.repeat(128) } }),
    ).toBeNull();
    expect(parseHostRuntimeRequirements({ ...archived, extra: true })).toBeNull();
  });

  it('asks a host runtime service that installs archives directly', async () => {
    const { docker, runtimes } = daemon(binaryOnly);
    const dir = await requestDir(archiveAgent);
    const refreshHostComponents = vi.fn(async () => undefined);
    const stop = answerFirstRequest(dir, runtimes);
    try {
      await reconcileHostRuntimes({
        docker,
        requirements: archived,
        requestId: 'a1',
        requestDir: dir,
        refreshHostComponents,
        ...fast,
      });
    } finally {
      stop();
    }
    expect(refreshHostComponents).not.toHaveBeenCalled();
  });

  it('never sends an archive pin to a service that would refuse it', async () => {
    const { docker } = daemon(binaryOnly);
    const dir = await requestDir(legacyAgent);
    await expect(
      reconcileHostRuntimes({
        docker,
        requirements: archived,
        requestId: 'a2',
        requestDir: dir,
        ...fast,
      }),
    ).rejects.toThrow(/predates archives.*keeps serving.*Re-run the Verity installer once/su);
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });

  it('is done when the refreshed host components registered the runtimes themselves', async () => {
    const { docker, runtimes } = daemon(binaryOnly);
    const dir = await requestDir(legacyAgent);
    await reconcileHostRuntimes({
      docker,
      requirements: archived,
      requestId: 'a3',
      requestDir: dir,
      // The builder bundle runs the target's install-runsc-host.sh before anything else.
      refreshHostComponents: async () => {
        Object.assign(runtimes, registered);
        return undefined;
      },
      ...fast,
    });
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });

  it('asks the replaced service once the refresh advertised archives', async () => {
    const { docker, runtimes } = daemon(binaryOnly);
    const dir = await requestDir(legacyAgent);
    const stop = answerFirstRequest(dir, runtimes);
    try {
      await reconcileHostRuntimes({
        docker,
        requirements: archived,
        requestId: 'a4',
        requestDir: dir,
        refreshHostComponents: async () => {
          await writeFile(join(dir, 'agent.json'), JSON.stringify(archiveAgent));
          return undefined;
        },
        ...fast,
      });
    } finally {
      stop();
    }
    expect(runtimes.runsc?.path).toBe(archivePath);
  });

  it('keeps builder refresh details out of the runtime error and keeps the current version', async () => {
    const { docker, runtimes } = daemon(binaryOnly);
    const dir = await requestDir(legacyAgent);
    await expect(
      reconcileHostRuntimes({
        docker,
        requirements: archived,
        requestId: 'a5',
        requestDir: dir,
        refreshHostComponents: async () =>
          'The host could not update the devcontainer builder: builds are still running; builder update deferred',
        ...fast,
      }),
    ).rejects.toThrow(
      `This release needs Docker runtime runsc and runsc-project (${archived.release}), ` +
        "which gVisor ships as a release archive, and this host's runtime service predates archives. " +
        'The current version keeps serving. Re-run the Verity installer once on the host ' +
        '(it installs the host runtime service and registers the runtimes), then retry the update.',
    );
    expect(runtimes.runsc?.path).toBe(binaryPath);
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });
});

describe('runtime service renewal independent of the builder', () => {
  const serviceRequirements = { revision: 1, renewalProtocol: 1, features: ['binary', 'archive'] };
  const renewed = {
    version: 1,
    trigger: 'systemd-path',
    runtimeArtifacts: ['binary', 'archive'],
    runtimeService: serviceRequirements,
  };
  it('renews an old service and registers archive runtimes without requesting builder admission', async () => {
    const { docker, runtimes } = daemon({});
    const dir = await requestDir({ version: 1, trigger: 'systemd-path' });
    const refreshHostComponents = vi.fn(async () => 'builder compatibility unknown');
    const renewHostRuntimeService = vi.fn(async () => {
      await writeFile(join(dir, 'agent.json'), JSON.stringify(renewed));
      Object.assign(runtimes, both);
    });
    const onProgress = vi.fn(async () => undefined);
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'renew-1',
      requestDir: dir,
      serviceRequirements,
      renewHostRuntimeService,
      refreshHostComponents,
      onProgress,
    });
    expect(renewHostRuntimeService).toHaveBeenCalledOnce();
    expect(refreshHostComponents).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith('renewing');
  });
  it('renews for a future capability even when runtime registrations already match', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir(renewed);
    const renewHostRuntimeService = vi.fn(async () => {
      await writeFile(
        join(dir, 'agent.json'),
        JSON.stringify({
          ...renewed,
          runtimeService: {
            ...serviceRequirements,
            revision: 2,
            features: ['binary', 'archive', 'future'],
          },
        }),
      );
    });
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'renew-2',
      requestDir: dir,
      serviceRequirements: { ...serviceRequirements, revision: 2, features: ['future'] },
      renewHostRuntimeService,
    });
    expect(renewHostRuntimeService).toHaveBeenCalledOnce();
  });
  it('does not renew an already capable service', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir(renewed);
    const renewHostRuntimeService = vi.fn();
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'renew-3',
      requestDir: dir,
      serviceRequirements,
      renewHostRuntimeService,
    });
    expect(renewHostRuntimeService).not.toHaveBeenCalled();
  });
  it('recovers an uncommitted service despite matching advertised capabilities', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir(renewed);
    await writeFile(join(dir, 'service-install.pending'), '');
    const renewHostRuntimeService = vi.fn(async () => {
      await rm(join(dir, 'service-install.pending'));
    });
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'pending-service',
      requestDir: dir,
      serviceRequirements,
      renewHostRuntimeService,
    });
    expect(renewHostRuntimeService).toHaveBeenCalledOnce();
  });
  it('resolves a pending daemon transaction even with matching live registrations and an old success', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir(renewed);
    await writeFile(join(dir, 'daemon-install.pending'), '');
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ version: 1, id: 'pending-daemon', ok: true, message: 'old success' }),
    );
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'pending-daemon',
      requestDir: dir,
      serviceRequirements,
      timeoutMs: 2_000,
      pollMs: 5,
      sleep: async () => {
        const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as {
          id: string;
        };
        expect(request.id).not.toBe('pending-daemon');
        await rm(join(dir, 'daemon-install.pending'), { force: true });
        await writeFile(
          join(dir, 'result.json'),
          JSON.stringify({ version: 1, id: request.id, ok: true, message: 'recovered' }),
        );
      },
    });
    await expect(readFile(join(dir, 'daemon-install.pending'))).rejects.toThrow(/ENOENT/u);
  });
  it('accepts installer-registered runtimes without a systemd watcher', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir({ ...renewed, trigger: 'none' });
    const renewHostRuntimeService = vi.fn();
    await reconcileHostRuntimes({
      docker,
      requirements: declared!,
      requestId: 'registered-without-systemd',
      requestDir: dir,
      serviceRequirements,
      renewHostRuntimeService,
    });
    expect(renewHostRuntimeService).not.toHaveBeenCalled();
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });
  it('fails after one renewal if the installed service still lacks a declared capability', async () => {
    const { docker } = daemon(both);
    const dir = await requestDir(renewed);
    const renewHostRuntimeService = vi.fn(async () => undefined);
    await expect(
      reconcileHostRuntimes({
        docker,
        requirements: declared!,
        requestId: 'renew-4',
        requestDir: dir,
        serviceRequirements: { ...serviceRequirements, features: ['future'] },
        renewHostRuntimeService,
      }),
    ).rejects.toThrow(/does not advertise.*keeps serving/u);
    expect(renewHostRuntimeService).toHaveBeenCalledOnce();
    await expect(readFile(join(dir, 'request.json'))).rejects.toThrow(/ENOENT/u);
  });
});
