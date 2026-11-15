import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import {
  devcontainerBuildInputsConfined,
  devcontainerBuildArgs,
  defaultDevcontainerBuildSpawner,
  DEVCONTAINER_NODE_FEATURE_REF,
} from './provisioner.js';
import { DockerError } from './docker.js';
import { type ClaudeEgressIdentityService } from './claude-egress-identity.js';

const SANDBOX_USER = '00000000-0000-4000-8000-000000000001';

/** Recreates the relay reconciler and turn repair start, with the initiator each records. */
const RECONCILE = {
  confirmWarnings: true,
  initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
};

const TURN_REPAIR = {
  confirmWarnings: true,
  initiator: { kind: 'session', sessionId: 'requesting-session' },
};

const verifiedNodeVersion = readFileSync(
  new URL('../../../.nvmrc', import.meta.url),
  'utf8',
).trim();

/** The start failure runsc reports for a filestore left by an unclean teardown,
 *  as worded in runsc/container/container.go (createGoferFilestoreInSelf) of the
 *  release pinned in deploy/gvisor/versions.env, wrapped the way dockerd relays it. */
function staleFilestoreError(containerId: string, docker29 = false): DockerError {
  const filestore = `/proc/4242/root/var/lib/docker/overlay2/layer/merged/.gvisor.filestore.${containerId}`;
  return new DockerError({
    kind: 'other',
    status: 500,
    message: docker29
      ? `OCI runtime create failed: creating container: cannot create gofer process: creating gofer filestore files: "/var/lib/docker/rootfs/overlayfs/layer" mount source already has a filestore file ".gvisor.filestore.${containerId}"; repeated submounts are not supported with overlay optimizations`
      : `failed to create task for container: OCI runtime create failed: runsc-project: ` +
        `"/var/lib/docker/overlay2/layer/merged" mount source already has a filestore file at ` +
        `"${filestore}"; repeated submounts are not supported with overlay optimizations`,
  });
}

/**
 * Decode a container spec's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` triples the way git itself does, into `key -> value`.
 *
 * Reading the entries through the count is the point. git stops at
 * `GIT_CONFIG_COUNT` and ignores every pair beyond it, so a spec that carries
 * the right keys under a count that does not reach them configures nothing —
 * and an assertion that looked the variables up by name directly would still be
 * green. A later entry wins, matching git's last-one-wins precedence.
 */
/** A fixed wall-clock start for the deferral-report tests. Any value does; a
 *  round one keeps a failure message readable. */
const START_MS = Date.parse('2026-09-17T12:00:00.000Z');

/** `cpu.weight` a cgroup v2 container gets when Docker sends no `CpuShares` —
 *  what every Verity container other than a sandbox runs at. */
const CGROUP_V2_DEFAULT_CPU_WEIGHT = 100;

/**
 * runc's `CpuShares` -> cgroup v2 `cpu.weight` conversion
 * (`ConvertCPUSharesToCgroupV2Value`), so a test can assert the weight a sandbox
 * actually ends up scheduled at instead of the Docker-API number that produces
 * it. The two do not rank alike, which is the whole reason to convert: shares
 * 1024 — Docker's nominal default, and the obvious "reset to neutral" value —
 * converts to 39, well under the 100 an unweighted container gets.
 */
function cgroupV2CpuWeight(shares: number | undefined): number {
  // `trunc`, not `floor`: Go divides integers toward zero, and the two disagree
  // for `shares === 1` — the one legal-looking input that makes the numerator
  // negative. No value this repository produces reaches that input, but a helper
  // documented as mirroring runc should not diverge from it anywhere it can be
  // read back as evidence of what the kernel will see.
  return shares === undefined || shares === 0
    ? CGROUP_V2_DEFAULT_CPU_WEIGHT
    : 1 + Math.trunc(((shares - 2) * 9999) / 262142);
}

/**
 * Run `body` against a controllable `Date.now()`, starting at `from`.
 *
 * Stub only the clock read: database socket I/O must retain real timers.
 */
async function withClockFrom(
  from: number,
  body: (advanceTo: (at: number) => void) => Promise<void>,
): Promise<void> {
  const now = vi.spyOn(Date, 'now').mockReturnValue(from);
  try {
    await body((at) => void now.mockReturnValue(at));
  } finally {
    now.mockRestore();
  }
}

function gitConfigEnv(env: string[]): Record<string, string> {
  const byName = new Map(
    env
      .filter((entry) => entry.includes('='))
      .map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      }),
  );
  const count = Number.parseInt(byName.get('GIT_CONFIG_COUNT') ?? '0', 10);
  const config: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const key = byName.get(`GIT_CONFIG_KEY_${String(index)}`);
    const value = byName.get(`GIT_CONFIG_VALUE_${String(index)}`);
    if (key === undefined || value === undefined) {
      throw new Error(`GIT_CONFIG_COUNT=${String(count)} but entry ${String(index)} is missing`);
    }
    config[key] = value;
  }
  return config;
}

/** Fake {@link ClaudeEgressIdentityService} returning fixed sandbox material and
 *  recording revocations. `gatewayMaterial` is never used by the provisioner. */
function fakeEgressIdentity(): {
  service: ClaudeEgressIdentityService;
  revoked: string[];
  revokedSandboxes: Array<{ projectId: string; userId: string }>;
} {
  const revoked: string[] = [];
  const revokedSandboxes: Array<{ projectId: string; userId: string }> = [];
  const service: ClaudeEgressIdentityService = {
    async gatewayMaterial() {
      throw new Error('gatewayMaterial is not used by the provisioner');
    },
    async sandboxMaterial({ projectId }) {
      return {
        projectId,
        fingerprint256: 'ab'.repeat(32),
        caCertPem: 'CA-CERT-PEM',
        clientCertPem: 'CLIENT-CERT-PEM',
        clientKeyPem: 'CLIENT-KEY-PEM',
      };
    },
    async revokeSandbox(sandbox) {
      revokedSandboxes.push(sandbox);
    },
    async revokeProject(projectId: string) {
      revoked.push(projectId);
    },
  };
  return { service, revoked, revokedSandboxes };
}

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('devcontainerBuildInputsConfined', () => {
  /** Write `devcontainer.json` into a throwaway `.devcontainer/` and answer the
   *  predicate for it. */
  function confined(json: string): boolean {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-confined-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), json);
      return devcontainerBuildInputsConfined(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts what the content hash actually covers', () => {
    // These read nothing the `.devcontainer/` hash does not already see, so the
    // derived-tag cache is sound for them and they must keep skipping the build.
    expect(confined('{ "image": "node:24-bookworm" }')).toBe(true);
    expect(confined('{ "build": { "dockerfile": "Dockerfile" } }')).toBe(true);
    expect(confined('{ "build": { "dockerfile": "Dockerfile", "context": "." } }')).toBe(true);
    expect(confined('{ "build": { "context": "./sub", "dockerfile": "sub/Dockerfile" } }')).toBe(
      true,
    );
    expect(confined('{ "features": { "ghcr.io/devcontainers/features/git:1": {} } }')).toBe(true);
    expect(confined('{ "features": { "./features/local": {} } }')).toBe(true);
    // JSONC: the repo's own file carries comments, and a scanner that choked on
    // them would report every commented devcontainer as escaping.
    expect(confined('{\n  // the usual\n  "build": { "dockerfile": "Dockerfile" }\n}')).toBe(true);
  });

  it('rejects a build that reads bytes outside .devcontainer/', () => {
    // Each of these keeps its hash — and so its cached tag — while the files it
    // builds from change. Reported as confined, they cache a stale image
    // forever; that is the failure being guarded, not the extra build.
    expect(confined('{ "build": { "dockerfile": "Dockerfile", "context": ".." } }')).toBe(false);
    expect(confined('{ "build": { "dockerfile": "../Dockerfile" } }')).toBe(false);
    expect(confined('{ "build": { "context": "/etc" } }')).toBe(false);
    // Legacy top-level spelling the devcontainer CLI still honours.
    expect(confined('{ "dockerFile": "../Dockerfile" }')).toBe(false);
    expect(confined('{ "context": "..", "dockerFile": "Dockerfile" }')).toBe(false);
    // Compose names files and services this runtime does not model at all.
    expect(confined('{ "dockerComposeFile": "../compose.yaml", "service": "dev" }')).toBe(false);
    // Raw build arguments can name a Dockerfile or additional context anywhere.
    expect(confined('{ "build": { "options": ["-f", "../Dockerfile"] } }')).toBe(false);
    // Relative Feature refs are local build inputs too.
    expect(confined('{ "features": { "../tools/my-feature": {} } }')).toBe(false);
    expect(confined('{ "features": { "/opt/features/local": {} } }')).toBe(false);
  });

  it('treats an unresolvable build declaration as unconfined', () => {
    // "Cannot tell" has to fall on the side that rebuilds. The alternative is a
    // stale image that nothing reports.
    expect(confined('{ "build": "Dockerfile" }')).toBe(false);
    expect(confined('{ "build": { "dockerfile": ["Dockerfile"] } }')).toBe(false);
    expect(confined('{ "build": { "context": "${localWorkspaceFolder}" } }')).toBe(false);
    expect(confined('{ "features": { "${localWorkspaceFolder}/feature": {} } }')).toBe(false);
  });

  it('ignores path-like keys nested outside their supported location', () => {
    // Only top-level `features` and fields directly inside top-level `build`
    // affect the devcontainer build. A recursive scan would reject harmless
    // application metadata and put sound cached images on the rebuild path.
    expect(confined('{ "customizations": { "build": { "context": ".." } } }')).toBe(true);
    expect(confined('{ "customizations": { "features": { "../elsewhere": {} } } }')).toBe(true);
  });

  it('accepts a clone with no devcontainer.json at all', () => {
    // `.devcontainer/` can hold only a Dockerfile; there is then no declaration
    // naming anything outside it.
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-confined-empty-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'Dockerfile'), 'FROM node:24-bookworm\n');
      expect(devcontainerBuildInputsConfined(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('devcontainerBuildArgs (R3.1/#299)', () => {
  it('gives the builder an isolated home and no ambient service secrets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'verity-builder-env-'));
    const previousPath = process.env.PATH;
    const previousSecret = process.env.VERITY_BUILD_TEST_SECRET;
    const previousEndpoint = process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT;
    try {
      writeFileSync(
        join(directory, 'devcontainer'),
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ secret: process.env.VERITY_BUILD_TEST_SECRET ?? null, home: process.env.HOME, dockerConfig: process.env.DOCKER_CONFIG, dockerHost: process.env.DOCKER_HOST, args: process.argv.slice(2) }));
`,
        { mode: 0o755 },
      );
      writeFileSync(join(directory, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT = 'unix:///test/buildkit.sock';
      process.env.PATH = `${directory}:${previousPath ?? ''}`;
      process.env.VERITY_BUILD_TEST_SECRET = 'must-not-reach-image-metadata';
      const result = await defaultDevcontainerBuildSpawner({
        workspaceFolder: '/project',
        imageName: 'test:1',
        dockerHost: 'unix:///test/docker.sock',
      });
      const output = JSON.parse(result.stdout) as {
        secret: string | null;
        home: string;
        dockerConfig: string;
        dockerHost: string;
        args: string[];
      };
      // Image metadata has its own substitution pass, outside config validation.
      expect(output.secret).toBeNull();
      expect(output.home).not.toBe(process.env.HOME);
      expect(output.dockerConfig).toBe(output.home);
      expect(output.dockerHost).toBe('unix:///test/docker.sock');
      expect(existsSync(output.home)).toBe(false);
      const configIndex = output.args.indexOf('--config');
      expect(configIndex).toBeGreaterThan(-1);
      expect(output.args[configIndex + 1]).toBe('/project/.devcontainer/devcontainer.json');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEndpoint === undefined) delete process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT;
      else process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT = previousEndpoint;
      if (previousSecret === undefined) delete process.env.VERITY_BUILD_TEST_SECRET;
      else process.env.VERITY_BUILD_TEST_SECRET = previousSecret;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // With `--load`, BuildKit only finishes the build once buildx closes the stream it
  // feeds into `docker load`; a stream left open kept a tagged image's build running
  // until the timeout. The image has to arrive as a complete file, loaded afterwards.
  it('exports the image to a file and loads it into the Engine as a separate step', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'verity-builder-load-'));
    const calls = join(directory, 'calls.log');
    const previousPath = process.env.PATH;
    const previousEndpoint = process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT;
    try {
      writeFileSync(
        join(directory, 'devcontainer'),
        `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, 'devcontainer ' + args.join(' ') + '\\n');
const spec = args.includes('--output') ? args[args.indexOf('--output') + 1] : '';
if (!spec.startsWith('type=docker,dest=/')) process.exit(2);
writeFileSync(spec.replace(/^type=docker,dest=/, ''), 'archive');
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> ${JSON.stringify(calls)}\n` +
          `[ "$1" = load ] && { [ "$(cat "$3")" = archive ] || exit 3; }\nexit 0\n`,
        { mode: 0o755 },
      );
      process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT = 'unix:///test/buildkit.sock';
      process.env.PATH = `${directory}:${previousPath ?? ''}`;
      await defaultDevcontainerBuildSpawner({
        workspaceFolder: '/project',
        imageName: 'test:1',
        dockerHost: 'unix:///test/docker.sock',
      });
      const log = readFileSync(calls, 'utf8').trim().split('\n');
      const build = log.find((line) => line.startsWith('devcontainer build'))!;
      expect(build).not.toContain('--load');
      const archive = /--output type=docker,dest=(\S+)/.exec(build)?.[1];
      expect(archive).toBeDefined();
      const load = log.findIndex((line) => line === `docker load --input ${archive}`);
      expect(load).toBeGreaterThan(log.indexOf(build));
      // The archive lives in the per-build directory that is removed afterwards.
      expect(existsSync(archive!)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEndpoint === undefined) delete process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT;
      else process.env.VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT = previousEndpoint;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('omits --additional-features entirely when no feature ref is present', () => {
    expect(devcontainerBuildArgs({ workspaceFolder: '/work', imageName: 'tag:1' })).toEqual([
      'build',
      '--workspace-folder',
      '/work',
      '--config',
      '/work/.devcontainer/devcontainer.json',
      '--image-name',
      'tag:1',
    ]);
    // An empty ref is treated as absent (no flag).
    expect(
      devcontainerBuildArgs({
        workspaceFolder: '/work',
        imageName: 'tag:1',
        additionalFeatures: '',
      }),
    ).not.toContain('--additional-features');
  });

  it('adds --no-cache only for a forced rebuild', () => {
    expect(devcontainerBuildArgs({ workspaceFolder: '/work', imageName: 'tag:1' })).not.toContain(
      '--no-cache',
    );
    expect(
      devcontainerBuildArgs({ workspaceFolder: '/work', imageName: 'tag:1', noCache: false }),
    ).not.toContain('--no-cache');
    expect(
      devcontainerBuildArgs({ workspaceFolder: '/work', imageName: 'tag:1', noCache: true }),
    ).toEqual([
      'build',
      '--workspace-folder',
      '/work',
      '--config',
      '/work/.devcontainer/devcontainer.json',
      '--image-name',
      'tag:1',
      '--no-cache',
    ]);
  });

  it('appends the node Feature plus the Verity toolkit when a toolkit ref is present', () => {
    const args = devcontainerBuildArgs({
      workspaceFolder: '/work',
      imageName: 'tag:1',
      additionalFeatures: '/opt/verity-features/verity-sandbox-toolkit',
    });
    const idx = args.indexOf('--additional-features');
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(args[idx + 1] ?? '{}')).toEqual({
      [DEVCONTAINER_NODE_FEATURE_REF]: { version: verifiedNodeVersion },
      '/opt/verity-features/verity-sandbox-toolkit': { installRunnerSupervisor: true },
    });
  });
});
