import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const release = 'release-20260714.0';
const digest = 'a'.repeat(64);
const validInspect = {
  Config: {
    User: '65532:65532',
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', 'printf "%s\\n" verity-gvisor-smoke-ok'],
    Volumes: null,
  },
  HostConfig: {
    Runtime: 'runsc',
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: null,
    Devices: [],
    DeviceRequests: null as Array<Record<string, string>> | null,
    DeviceCgroupRules: null,
    Binds: null,
    Mounts: null,
    SecurityOpt: ['no-new-privileges:true'],
    RestartPolicy: { Name: 'no' },
    PidsLimit: 32,
    Memory: 67_108_864,
    NanoCpus: 250_000_000,
    Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16777216' } as Record<string, string>,
  },
};
let tempRoot: string | null = null;

/** Whether every named executable is on this host's PATH. */
function hostHasTools(...tools: string[]): boolean {
  return tools.every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0,
  );
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function harness(
  startBody = "printf '%s\\n' verity-gvisor-smoke-ok",
  removeBody = ':',
  inspectBody = JSON.stringify([validInspect]),
) {
  tempRoot = mkdtempSync(join(tmpdir(), 'verity-gvisor-smoke-test-'));
  const bin = join(tempRoot, 'bin');
  const calls = join(tempRoot, 'docker-calls.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'sha512sum'), '#!/bin/sh\ncat >/dev/null\n', {
    mode: 0o755,
  });
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  info) printf '%s\\n' '{"path":"/opt/verity/runsc/${release}/runsc","runtimeArgs":["--platform=systrap","--network=none"]}' ;;
  create) printf '%s\\n' container-1 ;;
  inspect) printf '%s\\n' '${inspectBody}' ;;
  start) ${startBody} ;;
  rm) ${removeBody} ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(docker, 0o755);
  return {
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      VERITY_GVISOR_SMOKE_IMAGE: `example.invalid/smoke@sha256:${digest}`,
    },
  };
}

// The harness shims `docker` and `sha512sum` into a temp PATH, but `jq` does real
// JSON work the script depends on and cannot be faked. Without it the script's own
// missing-tool guard exits before any behaviour under test runs, which surfaced as
// nine assertion failures rather than as "not runnable on this host". CI and the
// deploy image both ship jq, so the coverage stays where it matters.
const describeSmoke = hostHasTools('jq') ? describe : describe.skip;

describeSmoke('deploy/bin/verity-gvisor-smoke', () => {
  it('runs and cleans up a digest-pinned, networkless runsc container', async () => {
    const test = harness();
    const result = await execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env });

    expect(result.stdout).toContain('gVisor smoke passed');
    const calls = readFileSync(test.calls, 'utf8');
    expect(calls).toContain('info --format {{json .Runtimes.runsc}}');
    expect(calls).toContain(`pull example.invalid/smoke@sha256:${digest}`);
    expect(calls).toContain('--runtime runsc --network none --read-only');
    expect(calls).toContain('start --attach');
    expect(calls).toContain('rm --force container-1');
  });

  it('rejects a mutable smoke image before creating a container', async () => {
    const test = harness();
    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', {
        env: { ...test.env, VERITY_GVISOR_SMOKE_IMAGE: 'example.invalid/smoke:latest' },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('full sha256 digest') });

    expect(readFileSync(test.calls, 'utf8')).not.toContain('create ');
  });

  it('force-removes the container when the runsc workload fails', async () => {
    const test = harness('exit 17');
    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ code: 17 });

    expect(readFileSync(test.calls, 'utf8')).toContain('rm --force');
  });

  it('fails closed when the pinned host binary checksum is wrong', async () => {
    const test = harness();
    const sha512sum = join(tempRoot!, 'bin', 'sha512sum');
    writeFileSync(sha512sum, '#!/bin/sh\ncat >/dev/null\nexit 1\n', { mode: 0o755 });

    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('pinned') });
    expect(() => readFileSync(test.calls, 'utf8')).toThrow();
  });

  it('fails closed on a mismatched Docker registration', async () => {
    const test = harness();
    const docker = join(tempRoot!, 'bin', 'docker');
    const calls = test.calls;
    writeFileSync(
      docker,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = info ]; then printf '%s\\n' '{"path":"/usr/bin/runc","runtimeArgs":[]}'; fi\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('registration') });
    expect(readFileSync(test.calls, 'utf8')).not.toContain('create ');
  });

  it('does not report success when final container cleanup fails', async () => {
    const test = harness(undefined, 'exit 19');
    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ code: 19 });
  });

  it('rejects root process identity and cleans up the created container', async () => {
    const inspect = structuredClone(validInspect);
    inspect.Config.User = '0:0';
    const test = harness(undefined, undefined, JSON.stringify([inspect]));

    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('isolation profile') });
    expect(readFileSync(test.calls, 'utf8')).toContain('rm --force container-1');
  });

  it('rejects extra tmpfs mounts and device requests', async () => {
    const inspect = structuredClone(validInspect);
    inspect.HostConfig.Tmpfs['/run'] = 'rw,nosuid,nodev';
    inspect.HostConfig.DeviceRequests = [{ Driver: 'nvidia' }];
    const test = harness(undefined, undefined, JSON.stringify([inspect]));

    await expect(
      execFileAsync('deploy/bin/verity-gvisor-smoke', { env: test.env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('isolation profile') });
  });
});
