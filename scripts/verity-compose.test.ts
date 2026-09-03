import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SHARED_SESSION_ROOT } from '../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { desiredSpec } from '../packages/server/src/self-update/managed-control-plane-runner.js';

const execFileAsync = promisify(execFile);

/** The two spellings Compose accepts for a service volume: the
 *  `source:target[:mode]` short string — which is also how a BIND is written —
 *  and the long form that alone can carry a volume subpath. */
type ComposeVolume =
  | string
  | {
      type?: string;
      source: string;
      target: string;
      read_only?: boolean;
      volume?: { subpath?: string };
    };

/** One normalized mount, in the shape `ContainerSpec` states it. `volume` is the
 *  named volume or, for a bind, the host path — enough to compare the two
 *  topologies as mounts rather than as two unrelated notations. */
interface NormalizedMount {
  volume: string;
  target: string;
  subpath?: string;
  readOnly?: boolean;
}

/** Resolve Compose's `${VAR:-default}` the way a `docker compose` run with no
 *  such variable set would. The mount list stayed literal while it held named
 *  volumes only; the daemon socket is the first entry written as a variable, and
 *  comparing the raw `${…}` text against a resolved host path would fail for a
 *  reason that has nothing to do with drift. */
const interpolate = (value: string): string =>
  value.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/gu, (_match, _name, fallback: string) => fallback);

/** Compose entry → {@link NormalizedMount}. Absent (rather than
 *  `false`/`undefined`) is what `desiredSpec` writes for a writable, whole-volume
 *  mount, so this omits the same keys. */
function composeMount(entry: ComposeVolume): NormalizedMount {
  if (typeof entry === 'string') {
    const [volume = '', target = '', mode] = interpolate(entry).split(':');
    return { volume, target, ...(mode === 'ro' ? { readOnly: true } : {}) };
  }
  return {
    volume: interpolate(entry.source),
    target: interpolate(entry.target),
    ...(entry.volume?.subpath === undefined ? {} : { subpath: entry.volume.subpath }),
    ...(entry.read_only === true ? { readOnly: true } : {}),
  };
}

/** `ContainerSpec` splits what Compose keeps in one list: named volumes live in
 *  `volumeMounts`, host paths in `binds` (`hostPath:target`). Rejoin them so the
 *  comparison sees the same thing Compose does. */
function specMounts(spec: {
  volumeMounts?: NormalizedMount[];
  binds?: string[];
}): NormalizedMount[] {
  return [
    ...(spec.volumeMounts ?? []),
    ...(spec.binds ?? []).map((bind) => {
      const [volume = '', target = '', mode] = bind.split(':');
      return { volume, target, ...(mode === 'ro' ? { readOnly: true } : {}) };
    }),
  ];
}

/** Key the comparison by mount target — unique within a container, and the one
 *  thing neither side may reorder its way out of. */
const byTarget = (mounts: readonly NormalizedMount[]): Record<string, NormalizedMount> =>
  Object.fromEntries(mounts.map((mount) => [mount.target, mount]));

/** Any digest/id/architecture: the mount list is independent of all three, and
 *  pinning real values here would make this track release churn. */
const controlRunnerSpec = (dockerSocket?: { hostPath: string; gid: string }) =>
  desiredSpec('ghcr.io/example/verity@sha256:0', 'dep-1', 'amd64', '1101', dockerSocket);

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('deploy/bin/verity-compose', () => {
  it('keeps direct Server TLS and pairing identity in the runner overlay', () => {
    const base = parse(readFileSync('deploy/docker-compose.yml', 'utf8')) as {
      services: Record<string, { command?: string[]; environment?: Record<string, string> }>;
    };
    const overlay = parse(readFileSync('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const names = [
      'HOST',
      'VERITY_MANAGED_DEPLOYMENT_ID',
      'VERITY_TLS_MODE',
      'VERITY_TLS_KEY_PATH',
      'VERITY_TLS_CERT_PATH',
      'VERITY_PAIRING_IDENTITY_KEY_PATH',
      'VERITY_PAIRING_CODE_PATH',
      'VERITY_PAIRING_EXPIRES_AT_PATH',
    ];
    const baseEnvironment = base.services['verity']?.environment ?? {};
    const overlayEnvironment = overlay.services['verity']?.environment ?? {};
    expect(base.services['verity']?.command).toEqual(['direct-server']);
    expect(Object.fromEntries(names.map((name) => [name, overlayEnvironment[name]]))).toEqual(
      Object.fromEntries(names.map((name) => [name, baseEnvironment[name]])),
    );
    for (const name of names.filter((name) => name !== 'VERITY_MANAGED_DEPLOYMENT_ID')) {
      expect(overlayEnvironment[name]).toBeTruthy();
    }
    expect(baseEnvironment['VERITY_MANAGED_DEPLOYMENT_ID']).toBe('');
    expect(baseEnvironment['VERITY_TLS_MODE']).toBe('direct');
  });

  it('keeps PostgreSQL reachable from managed Server generations on verity-net', () => {
    const compose = parse(readFileSync('deploy/docker-compose.yml', 'utf8')) as {
      services: Record<string, { networks?: unknown; environment?: Record<string, string> }>;
    };
    // A generated managed Server is single-homed on verity-net. PostgreSQL must
    // therefore retain the default network rather than an isolated Compose-only
    // bridge that managed generations cannot join.
    expect(compose.services['postgres']?.networks).toBeUndefined();
    expect(compose.services['postgres']?.environment).not.toHaveProperty(
      'POSTGRES_HOST_AUTH_METHOD',
    );
    expect(compose.services['postgres']?.environment?.['POSTGRES_PASSWORD']).toContain(
      'VERITY_POSTGRES_PASSWORD',
    );
    expect(compose.services['verity']?.environment?.['DATABASE_URL']).toContain(
      '${VERITY_POSTGRES_PASSWORD:',
    );
  });
  it('gives bootstrap and the Updater the same managed ACP environment sources', () => {
    const overlay = parse(readFileSync('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const expected = {
      VERITY_RUNNER_SUPERVISOR: '1',
      VERITY_CONTROL_PLANE_RUNNER: '1',
      VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR: '/run/verity-control-identity',
      // ADR 0006 Amendment 1's kill switch is read by the managed Server's reconciler, so it
      // is only flippable on that topology if it is sealed like the flags above.
      VERITY_CONTROL_PLANE_RUNNER_DOCKER: '${VERITY_CONTROL_PLANE_RUNNER_DOCKER:-1}',
    };
    expect(overlay.services['managed-bootstrap']?.environment).toEqual(expected);
    expect(overlay.services['verity-updater']?.environment).toEqual(expected);
  });

  /**
   * The control-plane Runner is the one container with TWO worktree trees: its
   * `verity-control` clone at /work, and the shared namespace the Server actually
   * allocates control-plane session worktrees in. The spawn broker confines an
   * agent to the trees it was told about, so a mount nobody tells it about is a
   * mount every turn dies on — which is exactly how "agent cwd escaped the
   * worktree root" took out every control-plane session. Both topologies declare
   * the mount separately; the launcher they share is the single place that turns
   * the matching broker root on.
   */
  it('tells the control-plane Runner broker about the shared session mount it is given', () => {
    const overlay = parse(readFileSync('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
      services: Record<string, { volumes?: unknown[] }>;
    };
    expect(overlay.services['verity-control-runner']?.volumes).toContainEqual({
      type: 'volume',
      source: 'verity-data',
      target: SHARED_SESSION_ROOT,
      volume: { subpath: 'sessions' },
    });
    expect(
      readFileSync('packages/server/src/self-update/managed-control-plane-runner.ts', 'utf8'),
    ).toContain(`target: '${SHARED_SESSION_ROOT}', subpath: 'sessions'`);
    expect(readFileSync('deploy/bin/verity-control-plane-runner-start', 'utf8')).toMatch(
      /^export VERITY_AGENT_SHARED_SESSION_ROOT=1$/mu,
    );
    // A project Sandbox has one tree and must stay that way: its launcher never
    // sets the flag, so its broker keeps /work alone.
    expect(
      readFileSync('features/verity-sandbox-toolkit/bin/verity-runner-stack-start', 'utf8'),
    ).not.toContain('VERITY_AGENT_SHARED_SESSION_ROOT');
  });

  /**
   * The SAME container is declared twice — by the Compose overlay for the
   * pre-managed topology, and by the managed `desiredSpec` the Updater
   * reconciles once a host has adopted the sealed authority. A host runs one or
   * the other, so a mount added to only one side is invisible until the topology
   * flips, and then presents as the feature simply not being there. Nothing but
   * a comment held the two lists together, which is the shape of drift that has
   * already cost this deployment twice (the MCP gateway route, #1570).
   *
   * Compare the whole list, not a membership check: an EXTRA mount on one side
   * is as much a drift as a missing one, and `readOnly` in particular is a
   * boundary rather than a detail.
   *
   * (Comparison machinery adapted from the sibling
   * `feat/control-plane-readonly-workspaces` work, which built and
   * mutation-checked it for the named-volume case. Extended here for `binds` —
   * `ContainerSpec` keeps host paths in a separate list from named volumes,
   * which the daemon socket is the first control-plane mount to need — and for
   * Compose's `${VAR:-default}` interpolation, which a literal volume name never
   * exercised.)
   */
  it('declares the same control-plane Runner mounts in Compose and in desiredSpec', () => {
    const overlay = parse(readFileSync('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
      services: Record<string, { volumes?: ComposeVolume[] }>;
    };
    const compose = (overlay.services['verity-control-runner']?.volumes ?? []).map(composeMount);
    expect(compose.length).toBeGreaterThan(0);
    expect(byTarget(compose)).toEqual(
      byTarget(specMounts(controlRunnerSpec({ hostPath: '/var/run/docker.sock', gid: '999' }))),
    );
  });

  /**
   * ADR 0006 Amendment 1's grant, and its off switch, on the managed topology.
   *
   * The socket is a BIND — `volumeMounts` resolves its source by named volume
   * and a daemon socket is a host path — and it must never be read-only:
   * connecting to a Unix socket writes the inode, so a read-only mount refuses
   * it even for root. The kill switch has to remove the mount, not merely stop
   * documenting it; a switch that leaves the socket in place has not killed
   * anything.
   */
  it('grants the control-plane Runner the daemon socket, and takes it away again', () => {
    const granted = controlRunnerSpec({ hostPath: '/run/docker.sock', gid: '986' });
    expect(granted.binds).toEqual(['/run/docker.sock:/var/run/docker.sock']);
    // The host path comes from the sealed Server spec, so a host whose socket
    // lives elsewhere moves both containers together rather than hardcoding one.
    expect(granted.binds?.[0]?.startsWith('/run/docker.sock:')).toBe(true);
    expect(granted.groupAdd).toEqual(['1101', '986']);
    expect(granted.env).toContain('VERITY_CONTROL_PLANE_RUNNER_DOCKER=1');

    const withheld = controlRunnerSpec();
    expect(withheld.binds).toBeUndefined();
    expect(withheld.groupAdd).toEqual(['1101']);
    expect(withheld.env).toContain('VERITY_CONTROL_PLANE_RUNNER_DOCKER=0');
  });

  /**
   * The mount reaches nobody on its own. The agent is a `setpriv` child at uid
   * 1000 launched with `--clear-groups`, so a 0660 root:docker socket answers
   * EACCES however the container's own groups are set — the launcher has to hand
   * the group to the child explicitly, and it reads the GID off the mounted
   * inode rather than trusting configuration.
   *
   * What that decision DOES is exercised for real, against real sockets and in
   * both directions, by `verity-control-plane-docker-grant.test.ts`. This
   * launcher cannot be run in a test at all — it demands uid 0 and a mounted
   * identity directory long before it reaches any of this — so what is pinned
   * here is the WIRING between the two, every line of which has a failure mode
   * that looks exactly like "not deployed yet".
   */
  it('hands the control-plane agent the docker group it needs to open the socket', () => {
    const launcher = readFileSync('deploy/bin/verity-control-plane-runner-start', 'utf8');
    // The real socket path, and the agent identity the refusal compares against —
    // both halves of it, since the socket's owner class matters as much as its
    // group class.
    expect(launcher).toContain(
      '"$(/usr/local/bin/verity-control-plane-docker-grant /var/run/docker.sock "$VERITY_AGENT_UID" "$VERITY_AGENT_GID" "$VERITY_RUNNER_RUNTIME_GID")"',
    );
    // The refusal has to stay FATAL. A bare `DOCKER_GRANT_GID="$(...)"` swallows
    // the non-zero exit under `set -e` — the assignment itself succeeds — which
    // turns the refusal back into the silent grant it exists to prevent.
    expect(launcher).toMatch(/if ! DOCKER_GRANT_GID=[^\n]*\n\s*exit 1\n/u);
    // The gid handed to the broker is the one the script printed. An
    // `export VERITY_AGENT_DOCKER_GID=999` would satisfy looser assertions while
    // reintroducing exactly the guessed GID this mechanism exists to avoid.
    expect(launcher).toContain('export VERITY_AGENT_DOCKER_GID="$DOCKER_GRANT_GID"');
    // The comparison needs the agent identity already resolved. Called a few
    // lines higher, it compares against empty strings and never refuses.
    for (const name of [
      'export VERITY_AGENT_UID=',
      'export VERITY_AGENT_GID=',
      'export VERITY_RUNNER_RUNTIME_GID=',
    ]) {
      expect(launcher.indexOf(name), name).toBeLessThan(
        launcher.indexOf('verity-control-plane-docker-grant'),
      );
    }
    // An image that ships the launcher without the script it calls does not
    // degrade quietly — it refuses to start the Runner at all.
    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      'COPY deploy/bin/verity-control-plane-docker-grant /usr/local/bin/verity-control-plane-docker-grant',
    );
    expect(dockerfile).toMatch(
      /chmod 0755 [^\n]*\/usr\/local\/bin\/verity-control-plane-docker-grant/u,
    );
    // A project Sandbox shares the broker but not this launcher, so its agent
    // argv must stay exactly what it was.
    expect(
      readFileSync('features/verity-sandbox-toolkit/bin/verity-runner-stack-start', 'utf8'),
    ).not.toContain('VERITY_AGENT_DOCKER_GID');
  });

  /**
   * The control-plane Runner's MCP gateway URL is spelled in THREE places — the Compose
   * overlay, the managed `desiredSpec` the Updater reconciles, and the launcher's own default
   * for a hand-run Runner. All three said `/internal/mcp`, the project-socket route, which
   * derives its project from the connection identity. This Runner has no project socket, so
   * that route answered 401 to the MCP client's `initialize` and every control-plane turn ran
   * with no brokered tool while reporting nothing. Hold the three to one value, and hold that
   * value to the control-plane route the Server actually registers.
   */
  it('points every control-plane Runner spec at the control-plane MCP gateway route', () => {
    const url = 'http://verity:8083/internal/control-plane/mcp';
    const overlay = parse(readFileSync('deploy/docker-compose.runner-supervisor.yml', 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(overlay.services['verity-control-runner']?.environment?.['VERITY_MCP_GATEWAY_URL']).toBe(
      url,
    );
    expect(
      readFileSync('packages/server/src/self-update/managed-control-plane-runner.ts', 'utf8'),
    ).toContain(`'VERITY_MCP_GATEWAY_URL=${url}'`);
    expect(readFileSync('deploy/bin/verity-control-plane-runner-start', 'utf8')).toContain(
      `\${VERITY_MCP_GATEWAY_URL:-${url}}`,
    );
    // And that route exists on the Server. A URL the three agree on but nothing serves is
    // the same 404-shaped failure by another road.
    expect(readFileSync('packages/server/src/mcp-gateway-route.ts', 'utf8')).toContain(
      "app.post(\n    '/internal/control-plane/mcp',",
    );
  });

  /**
   * A sealed-runner control-plane turn returns before `materializeControlPlaneAgentEnv` runs,
   * so the signer that path installs never reached this container: git fell back to plain
   * `ssh-keygen` and reported `No private key found for public key …`. That reads as a lost
   * key rather than a boundary, and invites the improvisations AGENTS.md forbids. The image
   * ships the refusal; the launcher is what points git at it, through the two env names the
   * spawn broker forwards to the agent child.
   */
  it('installs the explaining git signer for control-plane agents', () => {
    const launcher = readFileSync('deploy/bin/verity-control-plane-runner-start', 'utf8');
    expect(launcher).toContain('GIT_CONFIG_KEY_${GIT_CONFIG_INDEX}=gpg.ssh.program');
    expect(launcher).toContain(
      'GIT_CONFIG_VALUE_${GIT_CONFIG_INDEX}=/usr/local/bin/verity-control-plane-git-sign',
    );
    // Appended, never index 0: GIT_CONFIG_COUNT addresses one shared list, so claiming the
    // first slot would silently drop every entry the deployment already passed in.
    expect(launcher).toContain('GIT_CONFIG_INDEX="${GIT_CONFIG_COUNT:-0}"');
    expect(readFileSync('deploy/Dockerfile', 'utf8')).toContain(
      'COPY deploy/bin/verity-control-plane-git-sign /usr/local/bin/verity-control-plane-git-sign',
    );
    // The spawn broker is the hop that decides whether the agent ever sees it.
    expect(
      readFileSync('features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs', 'utf8'),
    ).toContain("copy('GIT_CONFIG_COUNT')");
  });

  it('refuses to sign and says where to go instead, while leaving verification alone', async () => {
    await expect(
      execFileAsync('deploy/bin/verity-control-plane-git-sign', ['-Y', 'sign', '-n', 'git']),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Do repo work in a project session for this repository'),
    });
    // Every other invocation reaches the real ssh-keygen, so signature VERIFICATION keeps
    // working — git uses one program for both, and refusing wholesale would break reading
    // history. The complaint below is ssh-keygen's own, which is the point.
    const passthrough = await execFileAsync('deploy/bin/verity-control-plane-git-sign', [
      '-Y',
      'check-novalidate',
    ]).catch((error: { stderr?: string }) => error);
    expect(passthrough.stderr).toContain('check-novalidate');
    expect(passthrough.stderr).not.toContain('cannot sign commits');
  });

  it('prepares host bind directories before invoking docker compose', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const workspaceRoot = join(tempRoot, 'workspaces');
    const secretRoot = join(tempRoot, 'secrets');
    const capture = join(tempRoot, 'docker-args.txt');
    mkdirSync(bin);
    const fakeDocker = join(bin, 'docker');
    writeFileSync(fakeDocker, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + capture + '"\n', {
      mode: 0o755,
    });
    chmodSync(fakeDocker, 0o755);

    await execFileAsync('deploy/bin/verity-compose', ['version'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_HOST_CLONE_ROOT: workspaceRoot,
        VERITY_SECRET_MATERIALIZATION_ROOT: secretRoot,
      },
    });

    expect(readFileSync(capture, 'utf8').trim()).toBe(
      [
        'compose',
        '-f',
        join(process.cwd(), 'deploy/docker-compose.yml'),
        '-f',
        join(process.cwd(), 'deploy/docker-compose.runner-supervisor.yml'),
        'version',
      ].join('\n'),
    );
    expect(statSync(workspaceRoot).isDirectory()).toBe(true);
    expect(statSync(secretRoot).isDirectory()).toBe(true);
    expect(statSync(workspaceRoot).mode & 0o777).toBe(0o755);
    expect(statSync(secretRoot).mode & 0o777).toBe(0o700);
  });

  it('forwards an explicitly owned Compose file stack without prepending defaults', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const capture = join(tempRoot, 'docker.args');
    const workspaceRoot = join(tempRoot, 'workspaces');
    const secretRoot = join(tempRoot, 'secrets');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    chmodSync(docker, 0o755);

    await execFileAsync('deploy/bin/verity-compose', ['-f', 'custom.yml', 'config'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_HOST_CLONE_ROOT: workspaceRoot,
        VERITY_SECRET_MATERIALIZATION_ROOT: secretRoot,
      },
    });

    expect(readFileSync(capture, 'utf8').trim()).toBe('compose\n-f\ncustom.yml\nconfig');
    expect(statSync(workspaceRoot).isDirectory()).toBe(true);
    expect(statSync(secretRoot).isDirectory()).toBe(true);

    await execFileAsync('deploy/bin/verity-compose', ['-fcustom.yml', 'config'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_HOST_CLONE_ROOT: workspaceRoot,
        VERITY_SECRET_MATERIALIZATION_ROOT: secretRoot,
      },
    });
    expect(readFileSync(capture, 'utf8').trim()).toBe('compose\n-fcustom.yml\nconfig');
  });

  it('does not treat service command arguments as global Compose files', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const capture = join(tempRoot, 'docker.args');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    chmodSync(docker, 0o755);

    await execFileAsync('deploy/bin/verity-compose', ['run', 'worker', '--file', 'payload.txt'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });

    expect(readFileSync(capture, 'utf8').trim()).toBe(
      [
        'compose',
        '-f',
        join(process.cwd(), 'deploy/docker-compose.yml'),
        '-f',
        join(process.cwd(), 'deploy/docker-compose.runner-supervisor.yml'),
        'run',
        'worker',
        '--file',
        'payload.txt',
      ].join('\n'),
    );
  });

  it('uses only the base file when Claude supervision is explicitly disabled', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const capture = join(tempRoot, 'docker.args');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    chmodSync(docker, 0o755);

    await execFileAsync('deploy/bin/verity-compose', ['up', '-d'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_RUNNER_SUPERVISOR: '0',
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });

    expect(readFileSync(capture, 'utf8').trim()).toBe(
      ['compose', '-f', join(process.cwd(), 'deploy/docker-compose.yml'), 'up', '-d'].join('\n'),
    );
  });

  it('runs the gVisor preflight before Compose when explicitly required', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const deployBin = join(tempRoot, 'deploy', 'bin');
    const calls = join(tempRoot, 'calls.txt');
    mkdirSync(deployBin, { recursive: true });
    const wrapper = readFileSync('deploy/bin/verity-compose', 'utf8');
    writeFileSync(join(deployBin, 'verity-compose'), wrapper, { mode: 0o755 });
    writeFileSync(
      join(deployBin, 'verity-gvisor-smoke'),
      `#!/bin/sh\nprintf '%s\\n' smoke >> '${calls}'\n`,
      { mode: 0o755 },
    );
    const bin = join(tempRoot, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' compose >> '${calls}'\n`, {
      mode: 0o755,
    });

    await execFileAsync(join(deployBin, 'verity-compose'), ['version'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_GVISOR_REQUIRED: '1',
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });

    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['smoke', 'compose']);
  });

  it('does not invoke Compose when the required gVisor preflight fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const deployBin = join(tempRoot, 'deploy', 'bin');
    const calls = join(tempRoot, 'calls.txt');
    mkdirSync(deployBin, { recursive: true });
    writeFileSync(
      join(deployBin, 'verity-compose'),
      readFileSync('deploy/bin/verity-compose', 'utf8'),
      { mode: 0o755 },
    );
    writeFileSync(join(deployBin, 'verity-gvisor-smoke'), '#!/bin/sh\nexit 23\n', {
      mode: 0o755,
    });
    const bin = join(tempRoot, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf compose >> '${calls}'\n`, {
      mode: 0o755,
    });

    await expect(
      execFileAsync(join(deployBin, 'verity-compose'), ['up'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_GVISOR_REQUIRED: '1',
        },
      }),
    ).rejects.toMatchObject({ code: 23 });
    expect(() => readFileSync(calls, 'utf8')).toThrow();
  });

  it('bootstraps authority before switching to managed ownership', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, {
      mode: 0o755,
    });

    await execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
        VERITY_UPDATER_TOKEN_HOST_PATH: token,
        VERITY_HOST_ARCHITECTURE: 'amd64',
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });

    const invocations = readFileSync(calls, 'utf8').trim().split('\n');
    expect(invocations).toHaveLength(5);
    expect(invocations[0]).toContain('--profile managed-migration run --rm managed-bootstrap');
    expect(invocations[1]).toContain('ps -a --filter name=^/verity-managed-server ');
    expect(invocations[2]).toContain('stop verity');
    expect(invocations[3]).toContain(
      'docker-compose.managed.yml --profile managed up -d --remove-orphans',
    );
    expect(invocations[4]).toContain('exec -T verity-managed-gateway node -e');
  });

  it('does not touch Compose when managed-up inputs are unsafe', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, `${'a'.repeat(64)}\n`, { mode: 0o644 });
    chmodSync(token, 0o644);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf called > '${calls}'\n`, {
      mode: 0o755,
    });

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_GVISOR_REQUIRED: '0',
        },
      }),
    ).rejects.toMatchObject({ code: 64 });
    expect(() => readFileSync(calls, 'utf8')).toThrow();
  });

  it('rejects trailing data in the updater token file', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, `${'a'.repeat(64)}\ntrailing`, { mode: 0o600 });
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf called > '${calls}'\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
        },
      }),
    ).rejects.toMatchObject({ code: 64 });
    expect(() => readFileSync(calls, 'utf8')).toThrow();
  });

  it('restores the legacy Server when managed readiness fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *' exec -T verity-managed-gateway '*) exit 1 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
          VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
          VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
        },
      }),
    ).rejects.toMatchObject({ code: 70 });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('stop verity-managed-gateway verity-updater');
    expect(invocations).toContain('rm -f verity-managed-server');
    expect(invocations).toContain('up -d verity');
  });

  it('restores the legacy Server when the managed Compose transition fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *' --profile managed up -d --remove-orphans') exit 1 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
          VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
          VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
        },
      }),
    ).rejects.toMatchObject({ code: 70 });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('stop verity-managed-gateway verity-updater');
    expect(invocations).toContain('rm -f verity-managed-server');
    expect(invocations).toContain('up -d verity');
  });

  it('restarts the legacy Server when its stop reports a partial failure', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *' stop verity') exit 1 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
          VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
          VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
        },
      }),
    ).rejects.toMatchObject({ code: 70 });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('stop verity');
    expect(invocations).toContain('up -d verity');
    expect(invocations).not.toContain('--profile managed up');
  });

  it('reconciles the complete topology when the managed Server is stopped', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = ps ]; then printf '%s\\n' verity-managed-server; fi\nif [ "$1" = inspect ]; then printf '%s\\n' 'managed-test-1 server false'; fi\ncase "$*" in *' ps --status running -q verity') printf '%s\\n' legacy-container ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
        VERITY_UPDATER_TOKEN_HOST_PATH: token,
        VERITY_HOST_ARCHITECTURE: 'amd64',
        VERITY_GVISOR_REQUIRED: '0',
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('inspect -f');
    expect(invocations).toContain('stop verity');
    expect(invocations).toContain('--profile managed up -d');
    expect(invocations).toContain('exec -T verity-managed-gateway node -e');
  });

  it('reconciles a generation Server the Updater promoted instead of migrating again', async () => {
    // After a self-update the live Server is `verity-managed-server-g<n>`; the
    // unsuffixed bootstrap name is gone. Reading that host as a fresh migration
    // would fence the legacy Server beside a running managed one.
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(
      join(bin, 'docker'),
      // The extra names share the prefix but are not shapes this deployment owns:
      // an operator's backup, and a generation past the bound managed-gateway.ts:84
      // routes to. Counting either would read as a conflict and refuse the run.
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = ps ]; then printf '%s\\n' verity-managed-server-g7 verity-managed-server-backup verity-managed-server-g2147483648; fi\nif [ "$1" = inspect ]; then printf '%s\\n' 'managed-test-1 server true'; fi\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
        VERITY_UPDATER_TOKEN_HOST_PATH: token,
        VERITY_HOST_ARCHITECTURE: 'amd64',
        VERITY_GVISOR_REQUIRED: '0',
        VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
        VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
      },
    });
    const invocations = readFileSync(calls, 'utf8');
    // The identity is read off the generation container, and the run stays on the
    // reconciliation path: no legacy fencing, no orphan removal.
    expect(invocations).toContain('verity-managed-server-g7');
    expect(invocations).not.toContain('stop verity\n');
    expect(invocations).not.toContain('--remove-orphans');
  });

  it('fences the generation Server rather than the bootstrap name on rollback', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = ps ]; then printf '%s\\n' verity-managed-server-g7; fi\ncase "$*" in\n  "inspect -f {{.State.Running}} verity-managed-server-g7") printf '%s\\n' false ;;\n  inspect*) printf '%s\\n' 'managed-test-1 server true' ;;\n  *' ps --status running -q verity') printf '%s\\n' legacy-container ;;\n  *' exec -T verity-managed-gateway '*) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
          VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
          VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
        },
      }),
    ).rejects.toMatchObject({ code: 70 });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('stop verity-managed-server-g7');
    // Removing the Server would destroy the deployment the Updater still owns.
    expect(invocations).not.toContain('rm -f');
    expect(invocations).toContain('up -d verity');
  });

  it('rejects a concurrent managed migration before touching Docker', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    const lock = join(tempRoot, '.verity-managed-up.lock');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf called > '${calls}'\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );
    const holder = spawn('flock', ['-n', lock, 'sleep', '5'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      holder.once('spawn', () => setTimeout(resolve, 50));
      holder.once('error', reject);
    });
    try {
      await expect(
        execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
            VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
            VERITY_UPDATER_TOKEN_HOST_PATH: token,
            VERITY_HOST_ARCHITECTURE: 'amd64',
            VERITY_GVISOR_REQUIRED: '0',
          },
        }),
      ).rejects.toMatchObject({ code: 75 });
      expect(() => readFileSync(calls, 'utf8')).toThrow();
    } finally {
      holder.kill('SIGTERM');
    }
  });

  it('does not start legacy when managed control services cannot be stopped', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'verity-compose-test-'));
    const bin = join(tempRoot, 'bin');
    const calls = join(tempRoot, 'calls.txt');
    const token = join(tempRoot, 'updater-token');
    mkdirSync(bin);
    writeFileSync(token, 'a'.repeat(64), { mode: 0o600 });
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n  *' exec -T verity-managed-gateway '*) exit 1 ;;\n  *' stop verity-managed-gateway verity-updater') exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'stat'),
      `#!/bin/sh\ncase "$2:$3" in\n  %a:'${token}') printf 600 ;;\n  %a:*) printf 755 ;;\n  %u:*) printf 0 ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
      { mode: 0o755 },
    );

    await expect(
      execFileAsync('deploy/bin/verity-compose', ['managed-up'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          VERITY_MANAGED_DEPLOYMENT_ID: 'managed-test-1',
          VERITY_UPDATER_TOKEN_HOST_PATH: token,
          VERITY_HOST_ARCHITECTURE: 'amd64',
          VERITY_GVISOR_REQUIRED: '0',
          VERITY_HOST_CLONE_ROOT: join(tempRoot, 'workspaces'),
          VERITY_SECRET_MATERIALIZATION_ROOT: join(tempRoot, 'secrets'),
        },
      }),
    ).rejects.toMatchObject({ code: 71 });
    const invocations = readFileSync(calls, 'utf8');
    expect(invocations).toContain('stop verity-managed-gateway verity-updater');
    expect(invocations).not.toContain('up -d verity');
  });
});
