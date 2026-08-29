import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  SIGNING_BROKER_TOKEN_FILE,
  SIGNING_BROKER_TOKEN_HASH_LABEL,
  signingBrokerTokenHash,
} from './git-signer.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { VeritySettingsRecord, ProjectRecord } from '@verity/store';
import {
  RUNNER_BOUNDARY_BINARIES,
  trustedToolkitIdentity,
  type ImageEvidenceCollector,
  type ImageFileEvidence,
} from './runner-boundary-attestation.js';
import {
  ProvisionerImpl,
  DeprovisionerImpl,
  ProvisioningError,
  AmbiguousGitPushError,
  gitAuthHeader,
  resolveImage,
  devcontainerContentHash,
  devcontainerImageTag,
  DEVCONTAINER_IMAGE_PREFIX,
  projectNetworkName,
  devcontainerBuildArgs,
  devcontainerLifecycleCommand,
  devcontainerLifecyclePath,
  unsupportedDevcontainerRuntimeKeys,
  runnerSupervisorBoundarySafe,
  RUNNER_BROKER_CAPABILITIES,
  CLAUDE_EGRESS_GATEWAY_URL_LABEL,
  type ProvisionerOptions,
  type ProjectRelayControl,
  type GitRunner,
  type DevcontainerBuildSpawner,
  type ContainerCommandRunner,
} from './provisioner.js';
import {
  DockerError,
  type DockerClient,
  type ContainerSpec,
  type ContainerInspect,
} from './docker.js';
import {
  CONTAINER_GENERATION_LABEL,
  ENV_DRIFT_RECREATE_LIMIT,
  ENV_DRIFT_RECREATES_PER_TICK,
  ORPHAN_DEFER_TICK_LIMIT,
  PROJECT_ID_LABEL,
  SANDBOX_ENV_COHORTS,
} from './project-relay-migration.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ClaudeEgressIdentityService } from './claude-egress-identity.js';
import type { ProjectRelayBinding } from './project-relay-lifecycle.js';

/** Fake {@link ClaudeEgressIdentityService} returning fixed sandbox material and
 *  recording revocations. `gatewayMaterial` is never used by the provisioner. */
function fakeEgressIdentity(): { service: ClaudeEgressIdentityService; revoked: string[] } {
  const revoked: string[] = [];
  const service: ClaudeEgressIdentityService = {
    async gatewayMaterial() {
      throw new Error('gatewayMaterial is not used by the provisioner');
    },
    async sandboxMaterial(projectId: string) {
      return {
        projectId,
        caCertPem: 'CA-CERT-PEM',
        clientCertPem: 'CLIENT-CERT-PEM',
        clientKeyPem: 'CLIENT-KEY-PEM',
      };
    },
    async revokeProject(projectId: string) {
      revoked.push(projectId);
    },
  };
  return { service, revoked };
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

/** Build a fake {@link DockerClient} that records all calls + returns canned
 *  success/id/{inspect} so a provisioner test doesn't hit a real daemon. */
function fakeDocker(overrides?: Partial<DockerClient> & { createdContainerId?: string }): {
  client: DockerClient;
  calls: Array<{ method: string; payload: unknown }>;
} {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const createdId = overrides?.createdContainerId ?? 'container-abc';
  const base: Pick<
    DockerClient,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'removeContainer'
    | 'inspectContainer'
    | 'ensureNetwork'
  > = {
    ensureNetwork: vi.fn(async (name: string) => {
      calls.push({ method: 'ensureNetwork', payload: name });
    }),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      calls.push({ method: 'createContainer', payload: spec });
      return { id: createdId, warnings: [] };
    }),
    startContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'startContainer', payload: id });
    }),
    stopContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'stopContainer', payload: id });
    }),
    removeContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'removeContainer', payload: id });
    }),
    inspectContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'inspectContainer', payload: id });
      return { id, running: true };
    }),
  };
  return { client: { ...base, ...overrides }, calls };
}

function defaultProjectRelay(): ProjectRelayControl {
  return {
    async start(binding) {
      return {
        identity: {
          projectId: binding.projectId,
          containerGeneration: binding.containerGeneration,
        },
        signingCapability: 'test-signing-capability',
        githubCapability: 'test-github-capability',
      };
    },
    async stop() {},
    brokerUrl: () => 'http://relay:8080',
    claudeGatewayUrl: () => 'https://relay:8443',
  };
}

function createProvisioner(
  options: Omit<ProvisionerOptions, 'projectRelay' | 'claudeEgressGatewayUrl'> & {
    projectRelay?: ProjectRelayControl;
    claudeEgressGatewayUrl?: string;
  },
): ProvisionerImpl {
  const {
    projectRelay = defaultProjectRelay(),
    claudeEgressGatewayUrl = 'https://verity:9443',
    ...rest
  } = options;
  return new ProvisionerImpl({
    ...rest,
    projectRelay,
    claudeEgressGatewayUrl,
  });
}

/** Build a fake {@link GitRunner} that records call args + returns canned
 *  output, dispatching on the first arg to"/><sub-command>" for canned stdout. */
function fakeGit(canned: Array<{ match: RegExp; stdout?: string; reject?: boolean }>): {
  runner: GitRunner;
  calls: Array<{ args: readonly string[] }>;
} {
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: GitRunner = async (args) => {
    calls.push({ args });
    const joined = args.join(' ');
    for (const c of canned) {
      if (c.match.test(joined)) {
        if (c.reject === true) {
          throw new Error(`fake git: simulated failure for ${joined}`);
        }
        return { stdout: c.stdout ?? '', stderr: '' };
      }
    }
    throw new Error(`fake git: no canned response for ${joined}`);
  };
  return { runner, calls };
}

describe('resolveImage (#174)', () => {
  const baseProject = {
    id: randomUUID(),
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-example-org-example-repo',
    imageRef: null,
    state: 'absent' as const,
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    stateChangedAt: new Date(),
  };

  it('uses the centrally-pinned default when project.imageRef is null', () => {
    expect(resolveImage(baseProject, 'ghcr.io/.../dev-base:default')).toBe(
      'ghcr.io/.../dev-base:default',
    );
  });

  it('uses the explicit per-repo override when project.imageRef is set', () => {
    expect(resolveImage({ ...baseProject, imageRef: 'override:v1' }, 'default:latest')).toBe(
      'override:v1',
    );
  });
});

describe('runnerSupervisorBoundarySafe (ADR 0006 D1)', () => {
  it('accepts the known non-root default image boundary', () => {
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: true,
        allowPrivilegeEscalation: false,
      }),
    ).toBe(true);
  });

  it('accepts a user devcontainer that ATTESTED the boundary', () => {
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: false,
        allowPrivilegeEscalation: false,
        attestedBoundary: true,
      }),
    ).toBe(true);
  });

  it('keeps deployment relaxations vetoing an attested image', () => {
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: false,
        allowPrivilegeEscalation: true,
        attestedBoundary: true,
      }),
    ).toBe(false);
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: false,
        allowPrivilegeEscalation: false,
        attestedBoundary: true,
        capAdd: ['SYS_ADMIN'],
      }),
    ).toBe(false);
  });

  it('rejects custom/devcontainer images and relaxed sandbox boundaries', () => {
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: false,
        allowPrivilegeEscalation: false,
      }),
    ).toBe(false);
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: false,
        allowPrivilegeEscalation: false,
        attestedBoundary: false,
      }),
    ).toBe(false);
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: true,
        allowPrivilegeEscalation: true,
      }),
    ).toBe(false);
    expect(
      runnerSupervisorBoundarySafe({
        usesManagedDefaultImage: true,
        allowPrivilegeEscalation: false,
        capAdd: ['NET_BIND_SERVICE'],
      }),
    ).toBe(false);
  });
});

describe('ProvisionerImpl (#174)', () => {
  const baseInput = {
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-example-org-example-repo',
    state: 'absent' as const,
  };

  async function seedProject(
    stateOverride: 'absent' | 'active' | 'cloning' | 'container_starting' | 'failed' = 'absent',
  ) {
    const id = randomUUID();
    await ctx.store.upsertProject({ id, ...baseInput, state: stateOverride });
    return id;
  }

  it('transitions absent → cloning → container_starting → active; clones via Basic `http.extraheader`', async () => {
    const id = await seedProject();
    await ctx.store.updateProjectSettings(id, { defaultBranch: 'develop' });
    const isDir = vi.fn(() => false);
    const { runner: git, calls: gitCalls } = fakeGit([
      // The clone command: `-c http.extraheader=Authorization: Basic <base64> clone <url> <dir>`
      { match: /\bclone\b/ },
      // Post-clone `remote set-url origin <clean-url>` defense layer (§19.3).
      { match: /remote set-url/ },
    ]);
    const { client: docker, calls: dockerCalls } = fakeDocker({
      createdContainerId: 'cid-1',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      opencodeConfigVolume: 'opencode-config-verity',
      piConfigVolume: 'pi-config-verity',
      git,
      isDirectory: isDir,
    });

    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');

    // Verify buffer.
    const transitions = dockerCalls.map((c) => c.method);
    expect(transitions).toContain('createContainer');
    expect(transitions).toContain('startContainer');

    // Clone has the extraheader suffix + clean URL (no embedded creds).
    const cloneCall = gitCalls.find((c) => c.args.includes('clone'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.args.join(' ')).toContain(
      'http.extraheader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r',
    );
    expect(cloneCall?.args.some((a) => a.includes('x-access-token'))).toBe(false);
    expect(cloneCall?.args.some((a) => a.includes('tok'))).toBe(false);
    expect(cloneCall?.args).toEqual(expect.arrayContaining(['--branch', 'develop']));

    // The set-url overwrite was called too (defense layer).
    const setUrlCall = gitCalls.find((c) => c.args.includes('set-url'));
    expect(setUrlCall).toBeDefined();
    expect(setUrlCall?.args.some((a) => a === 'https://github.com/example-org/example-repo')).toBe(
      true,
    );

    // Container spec carries image_ref (NULL → resolved to default).
    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.image).toBe('ghcr.io/heey-global/dev-base:default');
    expect(spec.name).toBe('dev-example-org-example-repo');
    expect(spec.network).toBe(projectNetworkName(id));
    expect(spec.binds).toContain('/var/lib/verity-dev/example-org-example-repo:/work');
    // No gh-token file is mounted (the sandbox redeems its capability at the token
    // broker instead); without ghTokenCapabilities wired, no capability either.
    expect((spec.binds ?? []).some((b) => b.includes('.gh-token'))).toBe(false);
    expect(spec.binds).toContain('/opt/agent-seed:/opt/agent-seed:ro');
    expect(spec.binds).toContain('/dev/null:/etc/profile.d/gh-token.sh:ro');
    expect(spec.binds).not.toContain('claude-config-verity:/home/dev/.claude');
    expect(spec.binds).not.toContain('codex-config-verity:/home/dev/.codex');
    expect(spec.binds).toContain('opencode-config-verity:/home/dev/.config/opencode');
    expect(spec.binds).toContain('pi-config-verity:/home/dev/.pi');
    expect(spec.env).toEqual(
      expect.arrayContaining([
        'CLAUDE_CONFIG_DIR=/home/dev/.claude',
        'CODEX_HOME=/run/verity/codex',
        'IS_SANDBOX=1',
        'PATH=/opt/agent-seed/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ]),
    );
    expect((spec.env ?? []).some((e) => e.startsWith('VERITY_GH_TOKEN_FILE='))).toBe(false);
    expect(spec.labels?.['verity.project-id']).toBe(id);
    expect(spec.restartPolicy).toBe('unless-stopped');
    // A hard memory ceiling is ALWAYS set (default 4 GiB) so a runaway sandbox
    // OOMs inside its own cgroup instead of taking the whole host down.
    expect(spec.pidsLimit).toBe(512);
    expect(spec.memoryBytes).toBe(4 * 1024 * 1024 * 1024);
    // …and the combined ceiling matches it, so the container cannot swap. Omitting it
    // lets Docker default to twice the memory limit, which turns the OOM this cap
    // exists to produce into an unbounded swap-thrash the session never recovers from.
    expect(spec.memorySwapBytes).toBe(spec.memoryBytes);
    // The CPU quota is safe-by-default too; otherwise one project build can starve
    // the control plane and every neighbouring sandbox on the same host.
    expect(spec.nanoCpus).toBe(2_000_000_000);
    // A crashing worker must not dump core into the session worktree.
    expect(spec.ulimits).toEqual([{ name: 'core', soft: 0, hard: 0 }]);
  });

  it('initializes a local project with an empty first commit instead of cloning', async () => {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      ...baseInput,
      owner: 'local',
      repo: 'my-project',
      containerName: 'verity-local--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    const { runner: git, calls: gitCalls } = fakeGit([
      { match: /^init -b main / },
      { match: /commit --allow-empty -m chore: initialize project$/ },
    ]);
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-local' });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: '',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
    });

    const result = await provisioner.provision(id);

    expect(result.state).toBe('active');
    expect(gitCalls.some((call) => call.args.includes('clone'))).toBe(false);
    expect(gitCalls[0]?.args).toEqual([
      'init',
      '-b',
      'main',
      '/var/lib/verity-dev/local-my-project',
    ]);
    expect(gitCalls[1]?.args).toEqual(
      expect.arrayContaining(['commit', '--allow-empty', '-m', 'chore: initialize project']),
    );
    const created = dockerCalls.find((call) => call.method === 'createContainer');
    expect((created?.payload as ContainerSpec).binds).toContain(
      '/var/lib/verity-dev/local-my-project:/work',
    );
  });

  /** What `git init` leaves in a fresh `.git/config`, written `key=value`. A key with no
   *  `=` stands for one git wrote without a value. */
  const INIT_CONFIG = [
    'core.repositoryformatversion=0',
    'core.filemode=true',
    'core.bare=false',
    'core.logallrefupdates=true',
  ];

  /** The name half of a `key=value` entry. */
  const entryName = (entry: string): string => entry.split('=')[0] as string;

  const INIT_CONFIG_KEYS = INIT_CONFIG.map(entryName);

  /**
   * Provisions a `local` project and returns the created container spec (undefined when
   * the provision failed), the git calls it made, and the keys `.git/config` still lists
   * afterwards.
   *
   * The config fake is stateful on purpose: `--list` answers with what is left, and
   * `--unset-all` removes it, so the verification re-read sees the effect of the unsets
   * rather than a canned reply. `honorUnset: false` models the pass failing to remove
   * something. Entries are given as `key=value`, or as a bare key for one git wrote
   * without a value.
   */
  async function provisionLocal(
    overrides: Partial<Parameters<typeof createProvisioner>[0]> = {},
    config: { entries?: string[]; honorUnset?: boolean } = {},
  ): Promise<{
    spec: ContainerSpec | undefined;
    gitCalls: Array<{ args: readonly string[] }>;
    remainingConfigKeys: string[];
    failure: unknown;
  }> {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      ...baseInput,
      owner: 'local',
      repo: 'my-project',
      containerName: 'verity-local--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    const { runner: base } = fakeGit([
      { match: /^init -b main / },
      { match: /commit --allow-empty -m chore: initialize project$/ },
    ]);
    const entries = [...(config.entries ?? INIT_CONFIG)];
    const gitCalls: Array<{ args: readonly string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      const joined = args.join(' ');
      if (/^config --file \S+ --list -z$/.test(joined)) {
        // git's own `-z` shape: `key\nvalue\0`, and a bare `key\0` when it has none.
        const listed = entries.map((entry) => {
          const split = entry.indexOf('=');
          return split === -1 ? entry : `${entry.slice(0, split)}\n${entry.slice(split + 1)}`;
        });
        return { stdout: `${listed.map((entry) => `${entry}\0`).join('')}`, stderr: '' };
      }
      const unset = /^config --file \S+ --unset-all (.+)$/.exec(joined);
      if (unset !== null) {
        if (config.honorUnset !== false) {
          for (let at = entries.length - 1; at >= 0; at -= 1) {
            if (entryName(entries[at] as string) === unset[1]) entries.splice(at, 1);
          }
        }
        return { stdout: '', stderr: '' };
      }
      return base(args);
    };
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-local' });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: '',
      defaultImageRef: 'image:test',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
      ...overrides,
    });

    const failure = await provisioner.provision(id).then(
      () => undefined,
      (error: unknown) => error ?? new Error('provision rejected'),
    );
    return {
      spec: dockerCalls.find((call) => call.method === 'createContainer')?.payload as
        ContainerSpec | undefined,
      gitCalls,
      remainingConfigKeys: entries.map(entryName),
      failure,
    };
  }

  /** The config keys a provision unset, in the order it unset them. */
  const unsetKeys = (calls: Array<{ args: readonly string[] }>): string[] =>
    calls
      .filter((call) => call.args.includes('--unset-all'))
      .map((call) => call.args[call.args.length - 1] as string);

  // `/work` has to stay writable — the session commits there — and that includes
  // `.git/config`, whose `filter.*.clean`, `merge.*.driver` and `diff.*.textconv` keys
  // all name a program git runs. For a `local` project Verity drives git over the same
  // clone from the server, so a sandbox-writable config is a way to pick that program.
  it("freezes a local clone's git config against its own sandbox", async () => {
    const { spec } = await provisionLocal({
      localConfigState: () => 'file',
    });

    expect(spec?.binds).toContain(
      '/var/lib/verity-dev/local-my-project/.git/config:/work/.git/config:ro',
    );
    // Only that one file: the workspace itself, and the rest of `.git`, stay writable.
    expect(spec?.binds).toContain('/var/lib/verity-dev/local-my-project:/work');
  });

  // The mount stops the NEXT write; it preserves everything already there. A project
  // provisioned before it existed can carry a hook path, a filter or a merge driver its
  // own sandbox wrote — freezing that unexamined would make it permanent, and the server
  // still runs git over the clone (`worktree add` applies smudge filters and fires
  // `post-checkout`).
  it('strips what an earlier session wrote before freezing the config', async () => {
    const { spec, gitCalls, remainingConfigKeys } = await provisionLocal(
      { localConfigState: () => 'file' },
      {
        entries: [
          ...INIT_CONFIG,
          'core.hookspath=/work/.git/hooks',
          'core.fsmonitor=/work/watch.sh',
          'core.worktree=/etc',
          'filter.LFS.clean=/work/clean.sh',
          'merge.ours.driver=/work/drive.sh',
          'diff.enc.textconv=/work/dec.sh',
          'credential.helper=/work/cred.sh',
          'submodule.dep.update=!/work/sub.sh',
          'remote.origin.url=ext::sh -c whoami',
          'include.path=../../elsewhere',
          'extensions.worktreeconfig=true',
        ],
      },
    );

    expect(remainingConfigKeys).toEqual(INIT_CONFIG_KEYS);
    // Nothing git itself wrote is touched, so the repository keeps working.
    expect(unsetKeys(gitCalls)).not.toEqual(expect.arrayContaining(INIT_CONFIG_KEYS));
    // git lowercases section and key but preserves a subsection's case, and that is the
    // spelling `--unset-all` matches on.
    expect(unsetKeys(gitCalls)).toContain('filter.LFS.clean');
    // The read-only mount is still what the sandbox gets; the pass only decides WHAT is
    // frozen into it.
    expect(spec?.binds).toContain(
      '/var/lib/verity-dev/local-my-project/.git/config:/work/.git/config:ro',
    );
  });

  // These describe how the object store is READ, not a program to run. Dropping
  // `extensions.objectFormat` would make a SHA-256 repository unreadable.
  it('keeps the keys that say how the repository is laid out', async () => {
    const layout = [
      ...INIT_CONFIG,
      'core.repositoryformatversion=1',
      'extensions.objectformat=sha256',
      'extensions.refstorage=reftable',
    ];
    const { gitCalls, remainingConfigKeys } = await provisionLocal(
      { localConfigState: () => 'file' },
      { entries: layout },
    );

    expect(remainingConfigKeys).toEqual(layout.map(entryName));
    expect(unsetKeys(gitCalls)).toEqual([]);
  });

  // The key names alone would let a sandbox freeze a repository into a state it cannot be
  // opened from — `core.bare = true` on a checkout, an object format git does not know.
  // Dropping the entry puts git's own default back, which is the readable one.
  it('drops an allowed key that carries a value Verity does not recognize', async () => {
    const { gitCalls, remainingConfigKeys } = await provisionLocal(
      { localConfigState: () => 'file' },
      {
        entries: [
          'core.repositoryformatversion=0',
          'core.filemode', // written without a value, which git reads as true
          'extensions.objectformat=sha256-but-not-really',
          'core.logallrefupdates=TRUE', // git parses a boolean case-insensitively
        ],
      },
    );

    expect(remainingConfigKeys).toEqual(['core.repositoryformatversion', 'core.logallrefupdates']);
    expect(unsetKeys(gitCalls)).toEqual(['core.filemode', 'extensions.objectformat']);
  });

  // `core.bare` is a boolean git accepts either way, but a managed clone is a working
  // checkout: sessions commit in worktrees of it and Verity merges in it. Frozen at
  // `true` it would have no worktree at all, and the freeze makes that permanent.
  it('keeps a local clone out of bare mode whichever way the value is spelled', async () => {
    const { gitCalls, remainingConfigKeys } = await provisionLocal(
      { localConfigState: () => 'file' },
      { entries: ['core.bare=true', 'core.repositoryformatversion=0'] },
    );

    expect(unsetKeys(gitCalls)).toEqual(['core.bare']);
    expect(remainingConfigKeys).toEqual(['core.repositoryformatversion']);

    const off = await provisionLocal(
      { localConfigState: () => 'file' },
      { entries: ['core.bare=off'] },
    );
    expect(unsetKeys(off.gitCalls)).toEqual([]);
  });

  // Mounting a config that still holds something unrecognized would hand it to git with
  // Verity's own privileges. There is no half-sanitized state worth starting.
  it('fails the provision when a key survives the pass', async () => {
    const { spec, failure } = await provisionLocal(
      { localConfigState: () => 'file' },
      { entries: [...INIT_CONFIG, 'core.hookspath=/work/.git/hooks'], honorUnset: false },
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not be sanitized/);
    expect(spec).toBeUndefined();
  });

  /** A clone directory on disk, so the real probe — not a seam — decides what is there. */
  function cloneOnDisk(config: (gitDir: string, root: string) => void): {
    root: string;
    dispose: () => void;
  } {
    const root = mkdtempSync(join(tmpdir(), 'verity-clone-'));
    const gitDir = join(root, 'local-my-project', '.git');
    mkdirSync(gitDir, { recursive: true });
    config(gitDir, root);
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  }

  // The sandbox can replace this path, and both users of it are privileged: `git config
  // --file` would rewrite whatever the link points at as the server's user, and the bind
  // mount would publish that file into the container.
  it('refuses a config that leaves the clone through a symlink', async () => {
    const { root, dispose } = cloneOnDisk((gitDir, base) => {
      writeFileSync(join(base, 'outside.ini'), '[core]\n\thooksPath = /work/hooks\n');
      symlinkSync(join(base, 'outside.ini'), join(gitDir, 'config'));
    });
    try {
      const { spec, gitCalls, failure } = await provisionLocal({ hostCloneRoot: root });

      expect((failure as Error).message).toMatch(/could not be sanitized/);
      expect(spec).toBeUndefined();
      // Neither read nor rewritten: the file it points at is exactly as it was.
      expect(gitCalls.some((call) => call.args.includes('--list'))).toBe(false);
      expect(readFileSync(join(root, 'outside.ini'), 'utf8')).toContain('hooksPath');
    } finally {
      dispose();
    }
  });

  // Same probe, the shape Verity itself creates: a plain file that git wrote.
  it('freezes a real config file inside the clone', async () => {
    const { root, dispose } = cloneOnDisk((gitDir) => {
      writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    });
    try {
      const { spec, failure } = await provisionLocal({ hostCloneRoot: root });

      expect(failure).toBeUndefined();
      expect(spec?.binds).toContain(`${root}/local-my-project/.git/config:/work/.git/config:ro`);
    } finally {
      dispose();
    }
  });

  // Nothing to freeze, nothing to strip — and a clone with no config yet is one the
  // bootstrap has not finished, so reading it would fail on its own terms.
  it('reads no config when the clone has none yet', async () => {
    const { gitCalls } = await provisionLocal({ localConfigState: () => 'absent' });

    expect(gitCalls.some((call) => call.args.includes('--list'))).toBe(false);
  });

  // Its sessions legitimately configure their own repository, and it merges through a
  // pull request rather than through Verity driving git over the clone.
  it('leaves a GitHub-backed clone config writable', async () => {
    const id = await seedProject();
    const { runner: git, calls: gitCalls } = fakeGit([
      { match: /\bclone\b/ },
      { match: /remote set-url/ },
    ]);
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-1' });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'image:test',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
      localConfigState: () => 'file',
    });

    await provisioner.provision(id);

    const spec = dockerCalls.find((call) => call.method === 'createContainer')
      ?.payload as ContainerSpec;
    expect((spec.binds ?? []).some((bind) => bind.includes('.git/config'))).toBe(false);
    // ... and Verity does not rewrite it either: a `remote.origin.url` and the identity
    // its sessions set are the repository working as intended.
    expect(gitCalls.some((call) => call.args.includes('--unset-all'))).toBe(false);
  });

  // Docker creates a missing bind source as an empty directory; mounting one over
  // `.git/config` would corrupt the repository. Let a half-prepared clone fail on its
  // own terms instead.
  it('skips the frozen config when the clone has none yet', async () => {
    const { spec } = await provisionLocal({ localConfigState: () => 'absent' });

    expect((spec?.binds ?? []).some((bind) => bind.includes('.git/config'))).toBe(false);
  });

  // With a data volume the sandbox is a sibling container, which cannot resolve the
  // server's host paths — every per-project mount has to become a subpath of the shared
  // volume, this one included, and it has to stay read-only across the translation.
  it('carries the frozen config through the data volume as a read-only subpath', async () => {
    const { spec } = await provisionLocal({
      hostCloneRoot: '/srv/verity/workspaces',
      dataVolume: 'verity-data',
      dataVolumeRoot: '/srv/verity',
      localConfigState: () => 'file',
    });

    expect(spec?.volumeMounts).toEqual(
      expect.arrayContaining([
        {
          volume: 'verity-data',
          target: '/work/.git/config',
          subpath: 'workspaces/local-my-project/.git/config',
          readOnly: true,
        },
      ]),
    );
    expect((spec?.binds ?? []).some((bind) => bind.includes('.git/config'))).toBe(false);
  });

  it('finishes the bootstrap commit after an interrupted local initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-init-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /rev-parse --verify HEAD$/, reject: true },
        { match: /commit --allow-empty -m chore: initialize project$/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await provisioner.provision(id);

      expect(calls.some((call) => call.args[0] === 'init')).toBe(false);
      expect(calls.some((call) => call.args.includes('--allow-empty'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('links a local clone to GitHub with an authenticated non-force push', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-link-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = {
      ...(await ctx.store.upsertProject({
        id: randomUUID(),
        ...baseInput,
        owner: 'local',
        repo: 'my-project',
        containerName: 'verity-local--my-project',
        kind: 'local',
        cloneDir: 'local-my-project',
      })),
    };
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: '' },
        { match: /remote add origin/ },
        { match: /push -u origin main$/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok');

      const addOrigin = calls.find((call) => call.args.includes('add'));
      expect(addOrigin?.args).toEqual([
        '-C',
        join(root, 'local-my-project'),
        'remote',
        'add',
        'origin',
        'https://github.com/acme/published',
      ]);
      const push = calls.find((call) => call.args.includes('push'))?.args ?? [];
      expect(push).toEqual(expect.arrayContaining(['push', '-u', 'origin', 'main']));
      expect(push).not.toContain('--force');
      expect(push.join(' ')).toContain('http.extraheader=Authorization: Basic');
      expect(push.join(' ')).not.toContain('tok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges a non-empty GitHub target with local conflict resolution before pushing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-nonempty-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-sha\trefs/heads/other\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/other\tHEAD\n' },
        { match: /fetch origin \+refs\/heads\/other:refs\/remotes\/origin\/other/ },
        {
          match: /merge --allow-unrelated-histories --no-edit -X ours refs\/remotes\/origin\/other/,
        },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main$/ },
      ]);
      const { client: docker } = fakeDocker();
      const openPullRequest = vi.fn(async () => ({ number: 7, url: 'https://gh/pull/7' }));
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
        openPullRequest,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).resolves.toEqual({
        importBranch: 'verity/import-main',
        pullRequest: { number: 7, url: 'https://gh/pull/7' },
      });
      expect(calls.find((call) => call.args.includes('merge'))?.args).toEqual(
        expect.arrayContaining([
          '--allow-unrelated-histories',
          '-X',
          'ours',
          'user.email=verity@localhost',
          'commit.gpgsign=false',
        ]),
      );
      // The default branch is never written directly: an operator's protection rule
      // on it would reject the push, and there would be no review to route through.
      expect(calls.some((call) => call.args.includes('main:other'))).toBe(false);
      expect(calls.find((call) => call.args.includes('push'))?.args).not.toContain('-u');
      expect(openPullRequest).toHaveBeenCalledWith(
        { owner: 'acme', repo: 'published' },
        'tok',
        expect.objectContaining({ head: 'verity/import-main', base: 'other' }),
      );
      expect(calls.some((call) => call.args.includes('--force'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an import branch that already carries this merge, and steps aside otherwise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-import-reuse-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    const link = async (
      remoteImportSha: string,
    ): Promise<{ branch: string | undefined; pushed: string | undefined }> => {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'merged-head\n' },
        { match: /remote get-url origin/, reject: true },
        {
          match: /ls-remote --heads --tags/,
          stdout: `remote-head\trefs/heads/main\n${remoteImportSha}\trefs/heads/verity/import-main\n`,
        },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin/ },
        { match: /merge --allow-unrelated-histories/ },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
        openPullRequest: async () => ({ number: 1, url: 'https://gh/pull/1' }),
      });
      const result = await provisioner.linkCloneToGitHub(
        project,
        { owner: 'acme', repo: 'published' },
        'tok',
      );
      return {
        branch: result.importBranch,
        pushed: calls.find((call) => call.args.includes('push'))?.args.at(-1),
      };
    };
    try {
      // Same merge already on the branch: a retry after a pull request that failed to
      // open reuses it instead of littering the repository with copies.
      expect(await link('merged-head')).toEqual({
        branch: 'verity/import-main',
        pushed: 'HEAD:refs/heads/verity/import-main',
      });
      // Someone else's branch of that name: step aside rather than overwrite it.
      expect((await link('other-work')).branch).toBe('verity/import-main-2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a pull request it could not open instead of stranding the branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-pr-failure-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'merged-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin/ },
        { match: /merge --allow-unrelated-histories/ },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
        openPullRequest: async () => {
          throw new Error('GitHub declined to open the pull request: tok is not allowed');
        },
      });

      // The branch is on GitHub. Failing the link here would strand it behind a
      // project that still believes it is local, so the link stands and says why.
      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).resolves.toEqual({
        importBranch: 'verity/import-main',
        pullRequestError: expect.stringContaining('GitHub declined'),
      });
      expect(calls.some((call) => call.args.includes('reset'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts the token from a pull-request failure it reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-pr-redact-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'merged-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin/ },
        { match: /merge --allow-unrelated-histories/ },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
        openPullRequest: async () => {
          throw new Error('upstream said ghs_supersecret is not allowed');
        },
      });

      const result = await provisioner.linkCloneToGitHub(
        project,
        { owner: 'acme', repo: 'published' },
        'ghs_supersecret',
      );
      expect(result.pullRequestError).not.toContain('ghs_supersecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signs the history before pushing, excluding what the remote already published', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-sign-link-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    // The rewrite itself is covered against real git in sign-history.test.ts;
    // what only this level can show is that the link path runs it at all, before
    // the push, and hands it the ref whose ancestry the remote already has.
    const link = async (signStep: { match: RegExp; stdout?: string; reject?: boolean }) => {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'merged-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin/ },
        { match: /merge --allow-unrelated-histories/ },
        signStep,
        { match: /push origin HEAD:refs\/heads\/verity\/import-main/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        veritySettings: async () =>
          ({
            gitSshPrivateKey: 'private-key',
            gitUserName: 'Fleet',
            gitUserEmail: 'fleet@example.test',
          }) as unknown as VeritySettingsRecord,
        git,
        openPullRequest: async () => ({ number: 1, url: 'https://gh/pull/1' }),
      });
      const result = await provisioner.linkCloneToGitHub(
        project,
        { owner: 'acme', repo: 'published' },
        'tok',
      );
      return { result, calls };
    };
    try {
      const { result, calls } = await link({ match: /rev-list --topo-order/, stdout: '' });
      const revList = calls.findIndex((call) => call.args.includes('rev-list'));
      expect(revList).toBeGreaterThanOrEqual(0);
      // Whatever the remote published keeps its object ids: excluded by ref, so
      // the import branch still shares the ancestry its pull request targets.
      expect(calls[revList]!.args.join(' ')).toContain('--not refs/remotes/origin/main');
      // Before the push, or it would have signed nothing that got pushed.
      expect(revList).toBeLessThan(calls.findIndex((call) => call.args.includes('push')));
      expect(result.pullRequest?.url).toBe('https://gh/pull/1');

      // Best-effort: a rewrite that fails must not fail the link. GitHub is the
      // authority on whether the signatures were needed — the push either goes
      // through or reports what the ruleset actually objected to.
      const failed = await link({ match: /rev-list --topo-order/, reject: true });
      expect(failed.result.pullRequest?.url).toBe('https://gh/pull/1');
      expect(failed.calls.some((call) => call.args.includes('push'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not merge or push staged local changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-dirty-link-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'local-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: 'M  staged.txt\n' },
        { match: /remote remove origin/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).rejects.toThrow(/uncommitted changes/);
      expect(calls.some((call) => call.args.includes('merge'))).toBe(false);
      expect(calls.some((call) => call.args.includes('push'))).toBe(false);
      expect(calls.find((call) => call.args.includes('remove'))?.args).toEqual(
        expect.arrayContaining(['remote', 'remove', 'origin']),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('links a clone whose only untracked entry is its .verity-sessions directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-sessions-link-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'local-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        // Only reachable if the flag is dropped again: every project that has run a
        // session carries this entry, and it must not read as a dirty working tree.
        { match: /status --porcelain$/, stdout: '?? .verity-sessions/\n' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin \+refs\/heads\/main:refs\/remotes\/origin\/main/ },
        {
          match: /merge --allow-unrelated-histories --no-edit -X ours refs\/remotes\/origin\/main/,
        },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main$/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).resolves.toEqual({
        importBranch: 'verity/import-main',
        pullRequestError: 'opening pull requests is not configured',
      });
      expect(calls.find((call) => call.args.includes('status'))?.args).toEqual(
        expect.arrayContaining(['--untracked-files=no']),
      );
      expect(calls.some((call) => call.args.includes('push'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the local clone when merging existing GitHub history fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-merge-failure-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'local-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin \+refs\/heads\/main:refs\/remotes\/origin\/main/ },
        { match: /merge --allow-unrelated-histories/, reject: true },
        { match: /rev-parse --verify --quiet MERGE_HEAD$/, stdout: 'merge-head\n' },
        { match: /merge --abort/ },
        { match: /remote remove origin/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).rejects.toThrow(/merging the existing GitHub repository/);
      expect(calls.some((call) => call.args.includes('--abort'))).toBe(true);
      expect(calls.some((call) => call.args.includes('reset'))).toBe(false);
      expect(calls.find((call) => call.args.includes('remove'))?.args).toEqual(
        expect.arrayContaining(['remote', 'remove', 'origin']),
      );
      expect(calls.some((call) => call.args.includes('push'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not call for repair when the merge never started', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-merge-unstarted-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'local-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin \+refs\/heads\/main:refs\/remotes\/origin\/main/ },
        { match: /merge --allow-unrelated-histories/, reject: true },
        // No MERGE_HEAD: the merge was refused before it touched the tree, so
        // `git merge --abort` would fail too — and that is not damage.
        { match: /rev-parse --verify --quiet MERGE_HEAD$/, reject: true },
        { match: /remote remove origin/ },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      const rejection = provisioner
        .linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok')
        .catch((error: unknown) => error);
      const error = await rejection;
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(error).not.toBeInstanceOf(AmbiguousGitPushError);
      expect((error as Error).message).toMatch(/merging the existing GitHub repository/);
      expect(calls.some((call) => call.args.includes('--abort'))).toBe(false);
      expect(calls.find((call) => call.args.includes('remove'))?.args).toEqual(
        expect.arrayContaining(['remote', 'remove', 'origin']),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps push ambiguity when restoring a merged local branch also fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-merged-push-failure-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'local-head\n' },
        { match: /remote get-url origin/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: 'remote-head\trefs/heads/main\n' },
        { match: /remote add origin/ },
        { match: /status --porcelain --untracked-files=no$/, stdout: '' },
        { match: /ls-remote --symref .* HEAD$/, stdout: 'ref: refs/heads/main\tHEAD\n' },
        { match: /fetch origin \+refs\/heads\/main:refs\/remotes\/origin\/main/ },
        { match: /merge --allow-unrelated-histories/ },
        { match: /push origin HEAD:refs\/heads\/verity\/import-main$/, reject: true },
        { match: /reset --merge local-head/, reject: true },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).rejects.toBeInstanceOf(AmbiguousGitPushError);
      expect(calls.find((call) => call.args.includes('reset'))?.args).toEqual(
        expect.arrayContaining(['reset', '--merge', 'local-head']),
      );
      expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts credentials when the authenticated remote probe fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-probe-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const token = 'secret-token-value';
      const header = gitAuthHeader(token);
      const { runner: git } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc\n' },
        { match: /remote get-url origin/, reject: true },
        {
          match: /ls-remote --heads --tags/,
          reject: true,
        },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git: async (args) => {
          try {
            return await git(args);
          } catch {
            throw new Error(`failed ${header} ${token}`);
          }
        },
      });

      let caught: unknown;
      try {
        await provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, token);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProvisioningError);
      expect(String((caught as Error & { cause?: unknown }).cause)).not.toContain(token);
      expect(String((caught as Error & { cause?: unknown }).cause)).not.toContain(header);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an origin that points somewhere else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-origin-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc\n' },
        {
          match: /remote get-url origin$/,
          stdout: 'https://secret-password@github.com/acme/other\n',
        },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      let message = '';
      try {
        await provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok');
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/origin already points/);
      expect(message).not.toContain('secret-password');
      expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
      expect(calls.some((call) => call.args.includes('set-url'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes after a crash that pushed the exact local branch before persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-resume-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc123\n' },
        { match: /remote get-url origin$/, stdout: 'https://github.com/acme/published\n' },
        { match: /ls-remote --heads --tags/, stdout: 'abc123\trefs/heads/main\n' },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).resolves.toEqual({});
      expect(calls.some((call) => call.args.includes('push'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps origin when push completion is ambiguous so a retry can recover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-local-ambiguous-'));
    mkdirSync(join(root, 'local-my-project', '.git'), { recursive: true });
    const project = await ctx.store.upsertProject({
      id: randomUUID(),
      ...baseInput,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
    });
    try {
      const { runner: git, calls } = fakeGit([
        { match: /symbolic-ref --short HEAD$/, stdout: 'main\n' },
        { match: /rev-parse --verify HEAD$/, stdout: 'abc123\n' },
        { match: /remote get-url origin$/, reject: true },
        { match: /ls-remote --heads --tags/, stdout: '' },
        { match: /remote add origin/ },
        { match: /push -u origin main$/, reject: true },
      ]);
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: '',
        defaultImageRef: 'image:test',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        git,
      });

      await expect(
        provisioner.linkCloneToGitHub(project, { owner: 'acme', repo: 'published' }, 'tok'),
      ).rejects.toThrow(/pushing main/);
      expect(calls.some((call) => call.args.includes('remove'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the turn admission barrier for an exclusive project mutation', async () => {
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: '',
      defaultImageRef: 'image:test',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = provisioner.withProjectExclusiveMutation('p-exclusive', () => gate);
    expect(provisioner.tryBeginProjectSandboxActivity('p-exclusive')).toBe(false);
    let admitted = false;
    const waitingTurn = provisioner.waitForTurnSandboxRepair('p-exclusive', 'new-turn').then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    release();
    await mutation;
    await waitingTurn;
    expect(admitted).toBe(true);
  });

  it('single-flights concurrent provision calls for the same project', async () => {
    const id = await seedProject();
    let releaseClone!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const gitCalls: Array<{ args: readonly string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      if (args.includes('clone')) await cloneGate;
      return { stdout: '', stderr: '' };
    };
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-1' });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      opencodeConfigVolume: 'opencode-config-verity',
      piConfigVolume: 'pi-config-verity',
      git,
      isDirectory: () => false,
    });

    // Second call arrives while the first is blocked mid-clone (the shape of a
    // repeated repair tap). It must join the running attempt, not start a
    // parallel clone/container phase against the same container name.
    const first = provisioner.provision(id);
    const second = provisioner.provision(id);
    // A recreate during the run must refuse rather than stop+remove the
    // container the in-flight attempt is about to start.
    await expect(provisioner.recreateContainer(id)).rejects.toThrow(/already provisioning/);
    await expect(
      provisioner.withProjectExclusiveMutation(id, async () => undefined),
    ).rejects.toThrow(/mutation in progress/);
    releaseClone();
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe('active');
    expect(b).toBe(a);
    expect(gitCalls.filter((c) => c.args.includes('clone'))).toHaveLength(1);
    expect(dockerCalls.filter((c) => c.method === 'createContainer')).toHaveLength(1);

    // The gate clears once the attempt settles: a later provision starts fresh.
    const again = await provisioner.provision(id);
    expect(again.state).toBe('active');
  });

  it('publishes every configured dev-server port pair', async () => {
    const id = await seedProject();
    await ctx.store.createDevServer({
      projectId: id,
      name: 'Web',
      containerPort: '3000',
    });
    await ctx.store.createDevServer({
      projectId: id,
      name: 'Docs',
      containerPort: '4173',
      sortOrder: 1,
    });
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    const spec = calls.find((call) => call.method === 'createContainer')?.payload as ContainerSpec;
    expect(spec.portBindings).toEqual([
      { hostPort: '3000', containerPort: '3000' },
      { hostPort: '3001', containerPort: '4173' },
    ]);
  });

  it('keeps the swap ceiling pinned to a configured memory ceiling', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      isDirectory: () => false,
      sandboxMemoryBytes: 6 * 1024 * 1024 * 1024,
      sandboxNanoCpus: 3_000_000_000,
    });

    await provisioner.provision(id);

    const spec = calls.find((call) => call.method === 'createContainer')?.payload as ContainerSpec;
    // Raising VERITY_SANDBOX_MEMORY has to move BOTH ceilings. A MemorySwap left at
    // Docker's default would hand the sandbox another 6 GiB of swap on top of the
    // limit that was just raised — the failure this pairing exists to prevent.
    expect(spec.memoryBytes).toBe(6 * 1024 * 1024 * 1024);
    expect(spec.memorySwapBytes).toBe(6 * 1024 * 1024 * 1024);
    expect(spec.nanoCpus).toBe(3_000_000_000);
  });

  it('mounts and starts the opt-in protected Runner supervisor without routing turns', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-1' });
    const prepareRunnerRuntime = vi.fn();
    const containerCommand = vi.fn<ContainerCommandRunner>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity/workspaces',
      dataVolume: 'verity-data',
      dataVolumeRoot: '/srv/verity',
      runnerSupervisor: true,
      runnerSupervisorTrustedDefaultImage: true,
      dockerHostForBuild: 'unix:///var/run/docker.sock',
      prepareRunnerRuntime,
      containerCommand,
      isDirectory: (path) => path === `/srv/verity/runners/${id}`,
    });

    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');
    expect(prepareRunnerRuntime).toHaveBeenCalledWith(`/srv/verity/runners/${id}`, {
      uid: 1101,
      gid: 1101,
    });

    const created = dockerCalls.find((call) => call.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.volumeMounts).toEqual(
      expect.arrayContaining([
        {
          volume: 'verity-data',
          target: '/run/verity-runner',
          subpath: `runners/${id}`,
          readOnly: false,
        },
      ]),
    );
    expect(spec.env).toEqual(
      expect.arrayContaining([
        'VERITY_RUNNER_RUNTIME=/run/verity-runner',
        'VERITY_RUNNER_RUNTIME_UID=1101',
        'VERITY_RUNNER_RUNTIME_GID=1101',
        'VERITY_AGENT_UID=1000',
        'VERITY_AGENT_GID=1000',
      ]),
    );
    // Stage-5b Slice 2b: on the runner-supervisor path the Claude config/
    // transcript home lives on the shared runner-runtime mount so the worker's
    // session .jsonl lands where the server-side tail persists it. The mount is
    // /run/verity-runner ↔ <dataVolumeRoot>/runners/<projectId>, so the config
    // dir must be exactly /run/verity-runner/claude and never the default home.
    expect(spec.env).toContain('CLAUDE_CONFIG_DIR=/run/verity-runner/claude');
    expect(spec.env).toContain('CODEX_HOME=/run/verity/codex');
    expect(spec.env).not.toContain('CLAUDE_CONFIG_DIR=/home/dev/.claude');
    expect(spec.capAdd).toEqual(['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP']);
    expect(containerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: 'dev-example-org-example-repo',
        user: '0:1101',
        workdir: '/run/verity-runner',
        command: 'verity-runner-stack-start',
      }),
    );
    await provisioner.reconcileRunnerSupervisors([result]);
    expect(containerCommand).toHaveBeenCalledTimes(2);
    expect(containerCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 12_000 }),
    );
    containerCommand.mockRejectedValueOnce(new Error('docker exec unavailable'));
    await expect(provisioner.reconcileRunnerSupervisors([result])).rejects.toThrow(
      /reconciliation failed for 1 project/,
    );
  });

  describe('ADR 0006 D1 boundary attestation for user devcontainers', () => {
    function binarySource(path: string): string {
      if (path.endsWith('supervisor')) return 'verity-runner-supervisor.mjs';
      if (path.endsWith('worker')) return 'verity-runner-worker.mjs';
      return path.slice(path.lastIndexOf('/') + 1);
    }

    function attestationFiles(agentInRuntime = false): Map<string, ImageFileEvidence> {
      const file = (path: string, content: Buffer): ImageFileEvidence => ({
        path,
        type: 'file',
        uid: 0,
        gid: 0,
        mode: 0o755,
        content,
      });
      const directory = (path: string): ImageFileEvidence => ({
        path,
        type: 'directory',
        uid: 0,
        gid: 0,
        mode: 0o755,
      });
      return new Map([
        [
          '/etc/passwd',
          file(
            '/etc/passwd',
            Buffer.from(
              'root:x:0:0::/root:/bin/sh\nvscode:x:1000:1000::/home/vscode:/bin/sh\nverity-runner:x:1101:1101::/nonexistent:/usr/sbin/nologin\n',
            ),
          ),
        ],
        [
          '/etc/group',
          file(
            '/etc/group',
            Buffer.from(
              `root:x:0:\nvscode:x:1000:vscode\nverity-runtime:x:1101:verity-runner${agentInRuntime ? ',vscode' : ''}\n`,
            ),
          ),
        ],
        ['/', directory('/')],
        ['/usr', directory('/usr')],
        ['/usr/local', directory('/usr/local')],
        ['/usr/local/bin', directory('/usr/local/bin')],
        ...RUNNER_BOUNDARY_BINARIES.map(
          (path) =>
            [
              path,
              file(path, readFileSync(`features/verity-sandbox-toolkit/bin/${binarySource(path)}`)),
            ] as const,
        ),
      ]);
    }

    async function recreateDevcontainerProject(agentInRuntime: boolean): Promise<{
      warning: string | null;
      imageRef: string | null;
      toolkitIdentity: string | null | undefined;
      spec: ContainerSpec;
      prepareRunnerRuntime: ReturnType<typeof vi.fn>;
      collector: ReturnType<typeof vi.fn<ImageEvidenceCollector>>;
    }> {
      const root = mkdtempSync(join(tmpdir(), 'verity-attest-'));
      try {
        const devcontainerDir = join(root, 'example-org-example-repo', '.devcontainer');
        mkdirSync(devcontainerDir, { recursive: true });
        writeFileSync(
          join(devcontainerDir, 'devcontainer.json'),
          '{ "image": "node:24", "remoteUser": "vscode" }',
        );
        const id = await seedProject('active');
        const prepareRunnerRuntime = vi.fn();
        const collector = vi.fn<ImageEvidenceCollector>(async () => ({
          configuredUser: 'vscode',
          files: attestationFiles(agentInRuntime),
        }));
        const { client: docker, calls: dockerCalls } = fakeDocker({
          imageExists: vi.fn(async () => true),
          createdContainerId: 'cid-attested',
        });
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker,
          token: 'tok',
          defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
          ghTokenFilePath: '/etc/gh-token',
          hostCloneRoot: root,
          // No `dataVolume`: the clone lives in a tmpdir here, and the
          // volume-subpath check rejects mount sources outside its root. The
          // boundary decision is independent of how the mounts are expressed.
          dataVolumeRoot: '/srv/verity',
          runnerSupervisor: true,
          runnerSupervisorTrustedDefaultImage: true,
          dockerHostForBuild: 'unix:///var/run/docker.sock',
          devcontainerBuild: vi.fn<DevcontainerBuildSpawner>(async () => ({
            stdout: '',
            stderr: '',
          })),
          devcontainerFeature: {
            ref: '/opt/verity-features/verity-sandbox-toolkit',
            version: '1.0.0',
            identity: 'sha256:toolkit-v1',
          },
          containerCommand: vi.fn<ContainerCommandRunner>(async () => ({
            stdout: '',
            stderr: '',
          })),
          prepareRunnerRuntime,
          imageEvidenceCollector: collector,
          runnerBoundaryFeatureDir: 'features/verity-sandbox-toolkit',
          isDirectory: (path) => path === `/srv/verity/runners/${id}` || path === devcontainerDir,
        });

        const result = await provisioner.recreateContainer(id);
        expect(result.state).toBe('active');
        return {
          warning: result.provisionWarning,
          imageRef: result.imageRef,
          toolkitIdentity: (await ctx.store.getProject(id))?.toolkitIdentity,
          spec: dockerCalls.find((call) => call.method === 'createContainer')
            ?.payload as ContainerSpec,
          prepareRunnerRuntime,
          collector,
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('enables the supervisor for an image Verity did not build once it proves the boundary', async () => {
      const { warning, imageRef, toolkitIdentity, spec, prepareRunnerRuntime, collector } =
        await recreateDevcontainerProject(false);

      expect(warning).toBeNull();
      // A passing attestation is the only thing that earns a recorded identity:
      // this image's boundary bytes were compared against exactly these.
      expect(toolkitIdentity).toBe(await trustedToolkitIdentity('features/verity-sandbox-toolkit'));
      expect(prepareRunnerRuntime).toHaveBeenCalledOnce();
      expect(spec.capAdd).toEqual([...RUNNER_BROKER_CAPABILITIES]);
      expect(spec.env).toContain('VERITY_RUNNER_RUNTIME=/run/verity-runner');
      // Evidence is collected from the exact derived image that will run.
      expect(collector).toHaveBeenCalledWith(
        expect.objectContaining({ imageRef: expect.stringContaining('verity-devc-') }),
      );
      expect(imageRef).toMatch(/^verity-devc-/u);
    });

    it('keeps the loopback path and names the failed check when attestation fails', async () => {
      const { warning, toolkitIdentity, spec, prepareRunnerRuntime } =
        await recreateDevcontainerProject(true);

      expect(prepareRunnerRuntime).not.toHaveBeenCalled();
      // The image WAS compared and did not match. Recording the server's toolkit
      // here would read as "current" in the drift report — an all-clear for the
      // one image we just proved carries something else.
      expect(toolkitIdentity).toBeNull();
      expect(spec.capAdd).toBeUndefined();
      expect(spec.env).not.toContain('VERITY_RUNNER_RUNTIME=/run/verity-runner');
      expect(warning).toMatch(/boundary attestation failed/u);
      // Actionable: the operator learns WHICH property broke, not just "custom image".
      expect(warning).toMatch(/member of the reserved Runner runtime GID 1101/u);
    });

    // The managed default image is trusted by configuration, not by comparison:
    // its toolkit was baked whenever that image was built, which may be many
    // server releases ago. Recording this server's identity for it would make
    // the whole stale population report as current — the exact false all-clear
    // the drift report exists to remove.
    it('records no identity for a trusted default image, which is never compared', async () => {
      const id = await seedProject('active');
      const collector = vi.fn<ImageEvidenceCollector>(async () => ({
        configuredUser: 'vscode',
        files: attestationFiles(false),
      }));
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: fakeDocker({ createdContainerId: 'cid-default' }).client,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/srv/verity/workspaces',
        dataVolumeRoot: '/srv/verity',
        runnerSupervisor: true,
        runnerSupervisorTrustedDefaultImage: true,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' })),
        prepareRunnerRuntime: vi.fn(),
        imageEvidenceCollector: collector,
        runnerBoundaryFeatureDir: 'features/verity-sandbox-toolkit',
        isDirectory: (path) => path === `/srv/verity/runners/${id}`,
      });

      const result = await provisioner.recreateContainer(id);

      expect(result.state).toBe('active');
      expect(result.imageRef).toBe('ghcr.io/heey-global/dev-base:default');
      expect(collector).not.toHaveBeenCalled();
      expect((await ctx.store.getProject(id))?.toolkitIdentity).toBeNull();
    });

    it('re-attests a changed devcontainer image and records the image judged', async () => {
      const root = mkdtempSync(join(tmpdir(), 'verity-reattest-'));
      const devcontainerDir = join(root, 'example-org-example-repo', '.devcontainer');
      try {
        mkdirSync(devcontainerDir, { recursive: true });
        const configPath = join(devcontainerDir, 'devcontainer.json');
        writeFileSync(configPath, '{ "image": "node:24", "remoteUser": "vscode" }');
        const id = await seedProject('active');
        const collector = vi.fn<ImageEvidenceCollector>(async () => ({
          configuredUser: 'vscode',
          files: attestationFiles(false),
        }));
        const { client: docker } = fakeDocker({ imageExists: vi.fn(async () => true) });
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker,
          token: 'tok',
          defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
          ghTokenFilePath: '/etc/gh-token',
          hostCloneRoot: root,
          dataVolumeRoot: '/srv/verity',
          runnerSupervisor: true,
          runnerSupervisorTrustedDefaultImage: true,
          dockerHostForBuild: 'unix:///var/run/docker.sock',
          devcontainerBuild: vi.fn<DevcontainerBuildSpawner>(async () => ({
            stdout: '',
            stderr: '',
          })),
          devcontainerFeature: {
            ref: '/opt/verity-features/verity-sandbox-toolkit',
            version: '1.0.0',
            identity: 'sha256:toolkit-v1',
          },
          containerCommand: vi.fn<ContainerCommandRunner>(async () => ({
            stdout: '',
            stderr: '',
          })),
          prepareRunnerRuntime: vi.fn(),
          imageEvidenceCollector: collector,
          runnerBoundaryFeatureDir: 'features/verity-sandbox-toolkit',
          isDirectory: (path) => path === `/srv/verity/runners/${id}` || path === devcontainerDir,
        });

        const first = await provisioner.recreateContainer(id);
        writeFileSync(configPath, '{ "image": "node:24-bookworm", "remoteUser": "vscode" }');
        const second = await provisioner.recreateContainer(id);

        expect(collector).toHaveBeenCalledTimes(2);
        const attestedRefs = collector.mock.calls.map(([input]) => input.imageRef);
        expect(attestedRefs[0]).not.toBe(attestedRefs[1]);
        expect(first.imageRef).toBe(attestedRefs[0]);
        expect(second.imageRef).toBe(attestedRefs[1]);
        expect((await ctx.store.getProject(id))?.imageRef).toBe(attestedRefs[1]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('skips control-plane projects during runner supervisor reconciliation', async () => {
    const containerCommand = vi.fn<ContainerCommandRunner>(async () => ({
      stdout: '',
      stderr: '',
    }));
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker: fakeDocker().client,
      git: fakeGit([]).runner,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity/workspaces',
      dataVolumeRoot: '/srv/verity',
      runnerSupervisor: true,
      dockerHostForBuild: 'unix:///var/run/docker.sock',
      containerCommand,
      isDirectory: () => true,
    });
    const controlProject = await ctx.store.upsertProject({
      id: 'verity-control',
      kind: 'control_plane',
      owner: 'verity',
      repo: 'control',
      containerName: 'verity-control',
      state: 'active',
      overviewVisible: true,
    });

    await provisioner.reconcileRunnerSupervisors([controlProject]);

    expect(containerCommand).not.toHaveBeenCalled();
  });

  it('prepares the protected runtime with the real no-follow filesystem path', async () => {
    const id = await seedProject();
    const root = mkdtempSync(join(tmpdir(), 'verity-runner-runtime-'));
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker } = fakeDocker({ createdContainerId: 'cid-1' });
    const containerCommand = vi.fn<ContainerCommandRunner>(async () => ({
      stdout: '',
      stderr: '',
    }));
    try {
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        git,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: join(root, 'workspaces'),
        dataVolume: 'verity-data',
        dataVolumeRoot: root,
        runnerSupervisor: true,
        runnerSupervisorTrustedDefaultImage: true,
        runnerRuntimeUid: process.getuid?.() ?? 0,
        runnerRuntimeGid: process.getgid?.() ?? 0,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand,
        isDirectory: () => false,
      });

      await provisioner.provision(id);
      const stats = statSync(join(root, 'runners', id));
      // Server-owned, Runner-group rwx, owner traverse-only (--x, no read/write):
      // the same-uid sandbox agent can descend to its transcript dir under claude/
      // but cannot read or write the Runner's control files at this level.
      expect(stats.mode & 0o777).toBe(0o170);
      expect(stats.uid).toBe(process.getuid?.() ?? 0);
      expect(stats.gid).toBe(process.getgid?.() ?? 0);
      // The Server-written subdirectories MUST already exist: after the 0170
      // hardening the Server (which owns the inode) has traverse only, so a lazy
      // `mkdir -p` from the turn path — ServerCodexTranscript materializing a
      // rollout into codex-sessions/ — fails EACCES and kills every Codex turn.
      for (const child of ['claude', 'codex-sessions']) {
        const childStats = statSync(join(root, 'runners', id, child));
        expect(childStats.isDirectory()).toBe(true);
        expect(childStats.mode & 0o777).toBe(0o700);
      }
      // Re-provision is idempotent: owner lacks read, so the reconcile briefly
      // restores owner access to open the no-follow fd, then re-applies 0170.
      await provisioner.provision(id);
      expect(statSync(join(root, 'runners', id)).mode & 0o777).toBe(0o170);
      for (const child of ['claude', 'codex-sessions']) {
        expect(statSync(join(root, 'runners', id, child)).isDirectory()).toBe(true);
      }
    } finally {
      const runnerRuntime = join(root, 'runners', id);
      if (existsSync(runnerRuntime)) chmodSync(runnerRuntime, 0o770);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked runtime without modifying its target', async () => {
    const id = await seedProject();
    const root = mkdtempSync(join(tmpdir(), 'verity-runner-runtime-symlink-'));
    const target = join(root, 'target');
    mkdirSync(join(root, 'runners'), { recursive: true });
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, 'runners', id), 'dir');
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls } = fakeDocker({ createdContainerId: 'cid-1' });
    try {
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        git,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: join(root, 'workspaces'),
        dataVolume: 'verity-data',
        dataVolumeRoot: root,
        runnerSupervisor: true,
        runnerSupervisorTrustedDefaultImage: true,
        runnerRuntimeUid: process.getuid?.() ?? 0,
        runnerRuntimeGid: process.getgid?.() ?? 0,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/runtime preparation failed/i);
      expect(statSync(target).mode & 0o777).toBe(0o700);
      expect(calls.some((call) => call.method === 'createContainer')).toBe(false);
      expect((await ctx.store.getProject(id))?.state).toBe('failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a planted symlink where a runtime subdirectory belongs', async () => {
    const id = await seedProject();
    const root = mkdtempSync(join(tmpdir(), 'verity-runner-subdir-symlink-'));
    // The Runner gid has write on the runtime, so it can plant an entry here. A
    // symlink must never be adopted: the Server materializes transcripts and Codex
    // rollouts into these directories and would otherwise write through it.
    const target = mkdtempSync(join(tmpdir(), 'verity-runner-subdir-target-'));
    chmodSync(target, 0o700);
    mkdirSync(join(root, 'runners', id), { recursive: true, mode: 0o770 });
    symlinkSync(target, join(root, 'runners', id, 'codex-sessions'), 'dir');
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls } = fakeDocker({ createdContainerId: 'cid-1' });
    try {
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        git,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: join(root, 'workspaces'),
        dataVolume: 'verity-data',
        dataVolumeRoot: root,
        runnerSupervisor: true,
        runnerSupervisorTrustedDefaultImage: true,
        runnerRuntimeUid: process.getuid?.() ?? 0,
        runnerRuntimeGid: process.getgid?.() ?? 0,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/runtime preparation failed/i);
      // The symlink target must be untouched — nothing written through the link.
      expect(readdirSync(target)).toEqual([]);
      expect(statSync(target).mode & 0o777).toBe(0o700);
      expect(calls.some((call) => call.method === 'createContainer')).toBe(false);
    } finally {
      // Provisioning is expected to abort BEFORE the 0170 hardening, but restore
      // owner access anyway so a regression that gets that far still tears down
      // cleanly and reports its assertion instead of an unremovable directory.
      const runnerRuntime = join(root, 'runners', id);
      if (existsSync(runnerRuntime)) chmodSync(runnerRuntime, 0o770);
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('force-resolves the current default digest when provisioning a new project', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-1' });
    // The resolver hands a stale cached digest to zero-arg callers and the
    // current one only when the provision path forces a refresh.
    const defaultImageRef = vi.fn(async (forceRefresh?: boolean) =>
      forceRefresh === true ? 'ghcr.io/heey-global/verity-sandbox@sha256:new' : 'ghcr.io/stale',
    );
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef,
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    expect(defaultImageRef).toHaveBeenCalledWith(true);
    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    // The container is pinned to the freshly resolved digest, not the poll cache's.
    expect(spec.image).toBe('ghcr.io/heey-global/verity-sandbox@sha256:new');
  });

  it('keeps the cached (non-forced) resolve for a project with its own image_ref', async () => {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      ...baseInput,
      imageRef: 'ghcr.io/custom@sha256:override',
    });
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker({ createdContainerId: 'cid-1' });
    const defaultImageRef = vi.fn(async () => 'ghcr.io/default@sha256:new');
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef,
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    // A custom image discards the default, so the default resolver is irrelevant.
    expect(defaultImageRef).not.toHaveBeenCalled();
    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.image).toBe('ghcr.io/custom@sha256:override');
  });

  it('clears project session backend resume state after a successful container provision', async () => {
    const id = await seedProject();
    await ctx.store.createSession({
      sessionId: 's-project-codex',
      worktree: '/wt/s-project-codex',
      model: 'codex/default',
      projectId: id,
    });
    await ctx.store.createSession({
      sessionId: 's-unrelated',
      worktree: '/wt/s-unrelated',
      model: 'codex/default',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's-project-codex',
      backend: 'codex',
      backendSessionId: 'old-codex-thread',
      contextSeq: 10,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's-unrelated',
      backend: 'codex',
      backendSessionId: 'other-thread',
      contextSeq: 11,
    });
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    expect(await ctx.store.getSessionBackendState('s-project-codex', 'codex')).toBeUndefined();
    expect(await ctx.store.getSessionBackendState('s-unrelated', 'codex')).toMatchObject({
      backendSessionId: 'other-thread',
    });
  });

  it('uses a deployment-local agent-seed host path when configured', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      agentSeedHostPath: '/data/dev/verity/agent-seed',
    });

    await provisioner.provision(id);

    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.binds).toContain('/data/dev/verity/agent-seed:/opt/agent-seed:ro');
  });

  it('injects central git identity and signing mounts into project containers', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      veritySettings: async () => ({
        gitUserName: 'h-teske',
        gitUserEmail: 'holger+github@heey.global',
        gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
        gitSshPrivateKey: null,
        gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
        gitSshPublicKey: null,
        gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
        gitKnownHosts: null,
        gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
        gitAllowedSigners: null,
        githubAppId: null,
        githubAppInstallationId: null,
        githubAppPrivateKey: null,
        dopplerServiceToken: null,
        claudeCodeOauthCredentialsJson: null,
        codexAuthJson: null,
        googleDriveClientId: null,
        googleDriveAccountEmail: null,
        googleDriveRefreshToken: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      git,
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.env).toEqual(
      expect.arrayContaining(['GIT_USER_NAME=h-teske', 'GIT_USER_EMAIL=holger+github@heey.global']),
    );
    expect(spec.binds).toEqual(
      expect.arrayContaining([
        // The PRIVATE key is NEVER mounted (broker-only signing). Only the public
        // key + known_hosts + allowed_signers mount (non-secret).
        '/data/dev/.shared/github/id_ed25519.pub:/home/dev/.ssh/id_ed25519.pub:ro',
        '/data/dev/.shared/github/known_hosts:/home/dev/.ssh/known_hosts:ro',
        '/data/dev/.shared/github/allowed_signers:/home/dev/.ssh/allowed_signers:ro',
        // Public key also at verity-sandbox's neutral /run/verity/ssh convention.
        '/data/dev/.shared/github/id_ed25519.pub:/run/verity/ssh/id_ed25519.pub:ro',
      ]),
    );
    // The PRIVATE signing key never appears in ANY bind (broker-only, H4/H5).
    expect((spec.binds ?? []).some((b) => /id_ed25519(?!\.pub)/.test(b))).toBe(false);
  });

  it('materializes DB-backed public signing files but NEVER the private key (broker-only)', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-git-secrets-test-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        inspectContainer: vi.fn(async (container: string) => {
          return {
            id: container,
            running: true,
            networks: { 'verity-net': { ipAddress: '172.19.0.4' } },
          };
        }),
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        veritySettings: async () => ({
          gitUserName: 'h-teske',
          gitUserEmail: 'holger+github@heey.global',
          gitSshPrivateKeyPath: null,
          gitSshPrivateKey: 'private-key',
          gitSshPublicKeyPath: null,
          gitSshPublicKey: 'public-key',
          gitKnownHostsPath: null,
          gitKnownHosts: 'github.com ssh-ed25519 AAA',
          gitAllowedSignersPath: null,
          gitAllowedSigners: '*@heey.global key',
          githubAppId: null,
          githubAppInstallationId: null,
          githubAppPrivateKey: null,
          dopplerServiceToken: null,
          claudeCodeOauthCredentialsJson: null,
          codexAuthJson: null,
          googleDriveClientId: null,
          googleDriveAccountEmail: null,
          googleDriveRefreshToken: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const privateKeyPath = join(secretRoot, 'git', 'id_ed25519');
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      // The private key is NEVER written to disk nor mounted (broker-only, H4/H5).
      expect(existsSync(privateKeyPath)).toBe(false);
      expect((spec.binds ?? []).some((b) => /id_ed25519(?!\.pub)/.test(b))).toBe(false);
      // The non-secret public material IS materialized + mounted.
      expect(spec.binds).toEqual(
        expect.arrayContaining([
          `${join(secretRoot, 'git', 'id_ed25519.pub')}:/home/dev/.ssh/id_ed25519.pub:ro`,
          `${join(secretRoot, 'git', 'known_hosts')}:/home/dev/.ssh/known_hosts:ro`,
          `${join(secretRoot, 'git', 'allowed_signers')}:/home/dev/.ssh/allowed_signers:ro`,
          `${join(secretRoot, 'git', 'id_ed25519.pub')}:/run/verity/ssh/id_ed25519.pub:ro`,
        ]),
      );
      // Signing is brokered: the sandbox gets the broker URL + git pointed at the
      // wrapper. The key-derived token is a mounted FILE (#662), never an env var.
      expect(spec.env).toEqual(
        expect.arrayContaining([
          'VERITY_SIGNING_URL=http://relay:8080',
          'GIT_CONFIG_VALUE_0=/opt/agent-seed/bin/verity-git-sign',
        ]),
      );
      expect((spec.env ?? []).some((e) => e.startsWith('VERITY_SIGNING_TOKEN='))).toBe(false);
      const token = 'test-signing-capability';
      const tokenPath = join(
        secretRoot,
        'git',
        `signing_broker_token.${signingBrokerTokenHash(token)}`,
      );
      expect(spec.binds).toContain(`${tokenPath}:${SIGNING_BROKER_TOKEN_FILE}:ro`);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('projects stable gateway coordinates for an explicit egress Canary', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      const containerCommand = vi.fn<ContainerCommandRunner>(async () => ({
        stdout: '',
        stderr: '',
      }));
      const startRelay = vi.fn((binding: ProjectRelayBinding) =>
        defaultProjectRelay().start(binding),
      );
      const chownCalls: Array<{ path: string; uid: number; gid: number }> = [];
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://verity:9443/',
        claudeConnectorPort: 9443,
        claudeEgressServerName: 'verity-egress',
        claudeEgressGatewayForProject: (project) =>
          project.id === id
            ? {
                url: 'https://verity-agent-gateway:9443/',
                serverName: 'verity-agent-gateway',
              }
            : { url: 'https://verity:9443/', serverName: 'verity-egress' },
        projectRelay: { ...defaultProjectRelay(), start: startRelay },
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand,
        chownRunnerFile: (path, ownership) =>
          chownCalls.push({ path, uid: ownership.uid, gid: ownership.gid }),
        git,
        isDirectory: () => false,
      });

      const result = await provisioner.provision(id);

      const spec = dockerCalls.find((c) => c.method === 'createContainer')
        ?.payload as ContainerSpec;
      const caPath = join(secretRoot, 'claude-egress', `egress_ca.${id}.crt`);
      const certPath = join(secretRoot, 'claude-egress', `egress_client.${id}.crt`);
      const keyPath = join(secretRoot, 'claude-egress', `egress_client.${id}.key`);
      // Public CA + client cert/key are mounted read-only at fixed container paths.
      expect(spec.binds).toEqual(
        expect.arrayContaining([
          `${caPath}:/run/verity/claude-egress/ca.crt:ro`,
          `${certPath}:/run/verity/claude-egress/client.crt:ro`,
          `${keyPath}:/run/verity/claude-egress/client.key:ro`,
        ]),
      );
      // The six connector coordinates (non-secret) are env; the optional SNI too.
      expect(spec.env).toEqual(
        expect.arrayContaining([
          'VERITY_CLAUDE_CONNECTOR_PORT=9443',
          'VERITY_CLAUDE_CONNECTOR_AUTHORITY=127.0.0.1:9443',
          'VERITY_CLAUDE_EGRESS_URL=https://relay:8443',
          'VERITY_CLAUDE_EGRESS_CA=/run/verity/claude-egress/ca.crt',
          'VERITY_CLAUDE_EGRESS_CERT=/run/verity/claude-egress/client.crt',
          'VERITY_CLAUDE_EGRESS_KEY=/run/verity/claude-egress/client.key',
          'VERITY_CLAUDE_EGRESS_SERVERNAME=verity-agent-gateway',
        ]),
      );
      expect(spec.labels?.[CLAUDE_EGRESS_GATEWAY_URL_LABEL]).toBe('https://relay:8443');
      expect(startRelay).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeGateway: { host: 'verity-agent-gateway', port: 9443 },
        }),
      );
      // The PEMs themselves are never env — they ride the read-only file mounts.
      expect(
        (spec.env ?? []).some((e) => e.includes('CA-CERT-PEM') || e.includes('CLIENT-KEY-PEM')),
      ).toBe(false);
      expect(readFileSync(keyPath, 'utf8')).toContain('CLIENT-KEY-PEM');
      // Key is 0600 (no group/other bits); CA + cert are 0644.
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(caPath).mode & 0o777).toBe(0o644);
      expect(statSync(certPath).mode & 0o777).toBe(0o644);
      // The key file is handed to the Runner uid/gid via the chown seam.
      expect(chownCalls).toEqual([{ path: keyPath, uid: 1101, gid: 1101 }]);
      expect(containerCommand).toHaveBeenCalledTimes(2);
      expect(containerCommand).toHaveBeenNthCalledWith(1, {
        containerName: 'dev-example-org-example-repo',
        dockerHost: 'unix:///var/run/docker.sock',
        user: '0:0',
        workdir: '/',
        command: 'test "$(stat -c %u /proc/1)" -ne 1101',
      });
      expect(containerCommand).toHaveBeenNthCalledWith(2, {
        containerName: 'dev-example-org-example-repo',
        dockerHost: 'unix:///var/run/docker.sock',
        user: '1101:1101',
        workdir: '/',
        command: 'verity-egress-connector-start --standalone',
      });
      expect(spec.capAdd).toBeUndefined();
      await provisioner.reconcileRunnerSupervisors([result]);
      expect(containerCommand).toHaveBeenCalledTimes(3);
      expect(containerCommand).toHaveBeenLastCalledWith({
        containerName: 'dev-example-org-example-repo',
        dockerHost: 'unix:///var/run/docker.sock',
        user: '1101:1101',
        workdir: '/',
        command: 'verity-egress-connector-start --standalone',
        timeoutMs: 12_000,
      });
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('prepares the Claude egress key as runner-group-only readable without CAP_CHOWN', async () => {
    const runnerGid = process.getgid?.();
    if (runnerGid === undefined) return;

    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-group-key-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        runnerRuntimeUid: 1201,
        runnerRuntimeGid: runnerGid,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' })),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const keyPath = join(secretRoot, 'claude-egress', `egress_client.${id}.key`);
      const keyStats = statSync(keyPath);
      expect(keyStats.gid).toBe(runnerGid);
      expect(keyStats.uid).toBe(process.getuid?.() ?? keyStats.uid);
      expect(keyStats.mode & 0o777).toBe(0o040);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('replaces an existing runner-readable Claude egress key on reprovision', async () => {
    const runnerGid = process.getgid?.();
    if (runnerGid === undefined) return;

    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-reprovision-key-'));
    try {
      const keyDir = join(secretRoot, 'claude-egress');
      mkdirSync(keyDir, { recursive: true });
      const keyPath = join(keyDir, `egress_client.${id}.key`);
      writeFileSync(keyPath, 'STALE-KEY\n', { mode: 0o600 });
      chmodSync(keyPath, 0o040);

      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        runnerRuntimeUid: 1201,
        runnerRuntimeGid: runnerGid,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' })),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      expect(statSync(keyPath).mode & 0o777).toBe(0o040);
      chmodSync(keyPath, 0o600);
      expect(readFileSync(keyPath, 'utf8')).toContain('CLIENT-KEY-PEM');
      expect(readFileSync(keyPath, 'utf8')).not.toContain('STALE-KEY');
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('fails provisioning closed when the sandbox connector cannot start', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-start-failure-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service, revoked } = fakeEgressIdentity();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn(async () => {
          throw new Error('connector readiness failed');
        }),
        chownRunnerFile: () => {},
        git,
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(
        /Sandbox egress connector failed to start: connector readiness failed/,
      );
      expect(dockerCalls.some((call) => call.method === 'stopContainer')).toBe(true);
      expect(dockerCalls.some((call) => call.method === 'removeContainer')).toBe(true);
      expect(revoked).toEqual([id]);
      expect((await ctx.store.getProject(id))?.state).toBe('failed');
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('removes the container and revokes its identity when post-start projection fails', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-projection-failure-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service, revoked } = fakeEgressIdentity();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        onContainerStarted: async () => {
          throw new Error('gateway unavailable');
        },
        chownRunnerFile: () => {},
        git,
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(
        /post-start projection failed: gateway unavailable/,
      );
      expect(dockerCalls.some((call) => call.method === 'stopContainer')).toBe(true);
      expect(dockerCalls.some((call) => call.method === 'removeContainer')).toBe(true);
      expect(revoked).toEqual([id]);
      expect((await ctx.store.getProject(id))?.state).toBe('failed');
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('projects no Claude-egress material when the feature is unconfigured', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker({});
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    const spec = dockerCalls.find((c) => c.method === 'createContainer')?.payload as ContainerSpec;
    expect((spec.binds ?? []).some((b) => b.includes('claude-egress'))).toBe(false);
    expect(
      (spec.env ?? []).some(
        (e) => e.startsWith('VERITY_CLAUDE_EGRESS') || e.startsWith('VERITY_CLAUDE_CONNECTOR'),
      ),
    ).toBe(false);
  });

  it('stays dormant on partial egress configuration (all-or-nothing gate)', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-partial-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      const materialSpy = vi.spyOn(service, 'sandboxMaterial');
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        // claudeConnectorPort deliberately omitted → the gate is incomplete.
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      // The identity service is never consulted and nothing is projected.
      expect(materialSpy).not.toHaveBeenCalled();
      const spec = dockerCalls.find((c) => c.method === 'createContainer')
        ?.payload as ContainerSpec;
      expect((spec.binds ?? []).some((b) => b.includes('claude-egress'))).toBe(false);
      expect((spec.env ?? []).some((e) => e.startsWith('VERITY_CLAUDE_'))).toBe(false);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('fails closed (no container) when egress material issuance throws', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-throw-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      vi.spyOn(service, 'sandboxMaterial').mockRejectedValue(new Error('CA unavailable'));
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        git,
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/CA unavailable/);
      // No container is created with half-projected credentials.
      expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('omits VERITY_CLAUDE_EGRESS_SERVERNAME when no server name is configured', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-egress-nosni-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({});
      const { service } = fakeEgressIdentity();
      const containerCommand = vi.fn<ContainerCommandRunner>(async () => ({
        stdout: '',
        stderr: '',
      }));
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeEgressIdentity: service,
        claudeEgressGatewayUrl: 'https://relay:8443',
        claudeConnectorPort: 9443,
        runnerRuntimeUid: 1201,
        runnerRuntimeGid: 1202,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand,
        // claudeEgressServerName omitted → optional SNI env absent.
        chownRunnerFile: () => {},
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const spec = dockerCalls.find((c) => c.method === 'createContainer')
        ?.payload as ContainerSpec;
      // The required six are present; the optional SNI is not.
      expect(spec.env).toEqual(
        expect.arrayContaining([
          'VERITY_CLAUDE_EGRESS_URL=https://relay:8443',
          'VERITY_RUNNER_RUNTIME_UID=1201',
          'VERITY_RUNNER_RUNTIME_GID=1202',
        ]),
      );
      expect(containerCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          user: '1201:1202',
          command: 'verity-egress-connector-start --standalone',
        }),
      );
      expect((spec.env ?? []).some((e) => e.startsWith('VERITY_CLAUDE_EGRESS_SERVERNAME='))).toBe(
        false,
      );
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('routes signing through the mandatory relay and never mounts the key', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-failclosed-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        inspectContainer: vi.fn(async (container: string) => ({
          id: container,
          running: true,
          networks: { 'verity-net': { ipAddress: '172.19.0.4' } },
        })),
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        veritySettings: async () =>
          ({
            gitSshPrivateKey: 'private-key',
            gitSshPublicKey: 'public-key',
          }) as unknown as VeritySettingsRecord,
        git,
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).resolves.toMatchObject({ state: 'active' });
      const spec = dockerCalls.find((c) => c.method === 'createContainer')
        ?.payload as ContainerSpec;
      expect(spec.env).toContain('VERITY_SIGNING_URL=http://relay:8080');
      expect((spec.binds ?? []).some((bind) => /id_ed25519(?!\.pub)/.test(bind))).toBe(false);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('keeps Claude refresh credentials out of sandboxes and mounts Codex auth.json', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-backend-creds-test-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        claudeConnectorPort: 47_821,
        veritySettings: async () => ({
          gitUserName: null,
          gitUserEmail: null,
          gitSshPrivateKeyPath: null,
          gitSshPrivateKey: null,
          gitSshPublicKeyPath: null,
          gitSshPublicKey: null,
          gitKnownHostsPath: null,
          gitKnownHosts: null,
          gitAllowedSignersPath: null,
          gitAllowedSigners: null,
          githubAppId: null,
          githubAppInstallationId: null,
          githubAppPrivateKey: null,
          dopplerServiceToken: null,
          claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-access"}}',
          codexAuthJson: '{"tokens":{"access_token":"a"}}',
          googleDriveClientId: null,
          googleDriveAccountEmail: null,
          googleDriveRefreshToken: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const authPath = join(secretRoot, 'codex', 'auth.json');
      const configPath = join(secretRoot, 'codex', 'config.toml');
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      const claudeConfigDir = spec.env
        ?.find((entry) => entry.startsWith('CLAUDE_CONFIG_DIR='))
        ?.slice('CLAUDE_CONFIG_DIR='.length);
      expect(claudeConfigDir).toBeDefined();
      expect(spec.binds).not.toContainEqual(
        expect.stringContaining(`${claudeConfigDir}/.credentials.json`),
      );
      expect(existsSync(join(secretRoot, 'claude', '.credentials.json'))).toBe(false);
      expect(spec.binds).not.toContainEqual(expect.stringContaining('/codex/auth.json'));
      expect(existsSync(authPath)).toBe(false);
      expect(spec.binds).toContain(`${configPath}:/run/verity/codex/config.toml:ro`);
      expect(readFileSync(configPath, 'utf8')).toContain(
        'base_url = "http://127.0.0.1:47821/codex"',
      );
      expect(readFileSync(configPath, 'utf8')).not.toContain('access_token');
      expect(statSync(configPath).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('in broker mode does not mount/write the private signing key and mounts the broker token file', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-broker-test-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        inspectContainer: vi.fn(async (container: string) => ({
          id: container,
          running: true,
          networks: { 'verity-net': { ipAddress: '172.19.0.4' } },
        })),
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        veritySettings: async () => ({
          gitUserName: null,
          gitUserEmail: null,
          gitSshPrivateKeyPath: null,
          gitSshPrivateKey: 'the-private-signing-key',
          gitSshPublicKeyPath: null,
          gitSshPublicKey: 'ssh-ed25519 PUBKEY',
          gitKnownHostsPath: null,
          gitKnownHosts: null,
          gitAllowedSignersPath: null,
          gitAllowedSigners: 'me@x namespaces="git" ssh-ed25519 PUBKEY',
          githubAppId: null,
          githubAppInstallationId: null,
          githubAppPrivateKey: null,
          dopplerServiceToken: null,
          claudeCodeOauthCredentialsJson: null,
          codexAuthJson: null,
          googleDriveClientId: null,
          googleDriveAccountEmail: null,
          googleDriveRefreshToken: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      const binds = spec.binds ?? [];
      const env = spec.env ?? [];
      // The PRIVATE key is neither written to the host nor mounted anywhere.
      expect(existsSync(join(secretRoot, 'git', 'id_ed25519'))).toBe(false);
      expect(binds.some((b) => /\/id_ed25519:(?!.*\.pub)/.test(b))).toBe(false);
      expect(binds.some((b) => b.endsWith('id_ed25519:ro'))).toBe(false);
      // The PUBLIC key + allowed_signers still mount (non-secret; git needs them).
      expect(binds.some((b) => b.endsWith('id_ed25519.pub:ro'))).toBe(true);
      expect(binds.some((b) => b.endsWith('allowed_signers:ro'))).toBe(true);
      const token = 'test-signing-capability';
      // The broker URL is injected, but the key-derived token is a mounted file.
      expect(env).toContain('VERITY_SIGNING_URL=http://relay:8080');
      expect(env).toContain(`VERITY_SIGNING_DOCKER_CONTAINER=${spec.name}`);
      expect(env.some((e) => e.startsWith('VERITY_SIGNING_TOKEN='))).toBe(false);
      expect(env.some((e) => e.includes('the-private-signing-key'))).toBe(false);
      const tokenHash = signingBrokerTokenHash(token);
      const tokenPath = join(secretRoot, 'git', `signing_broker_token.${tokenHash}`);
      expect(readFileSync(tokenPath, 'utf8')).toBe(`${token}\n`);
      expect(statSync(tokenPath).mode & 0o777).toBe(0o644);
      expect(binds).toContain(`${tokenPath}:${SIGNING_BROKER_TOKEN_FILE}:ro`);
      expect(spec.labels?.[SIGNING_BROKER_TOKEN_HASH_LABEL]).toBe(tokenHash);
      // git is pointed at the broker wrapper via GIT_CONFIG_* env (image-agnostic).
      expect(spec.env).toContain('GIT_CONFIG_COUNT=1');
      expect(spec.env).toContain('GIT_CONFIG_KEY_0=gpg.ssh.program');
      expect(spec.env).toContain('GIT_CONFIG_VALUE_0=/opt/agent-seed/bin/verity-git-sign');
      expect(spec.network).toBe(projectNetworkName(id));
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('engages broker mode when the key is provided by PATH (fleet default), not DB contents', async () => {
    // The fleet mounts the signing key as a FILE (gitSshPrivateKeyPath), never as
    // DB contents. Broker mode must still engage: the server resolves the key from
    // the path and derives the sandbox token from those bytes.
    const id = await seedProject();
    const keyDir = mkdtempSync(join(tmpdir(), 'verity-broker-path-'));
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-broker-path-secrets-'));
    const keyPath = join(keyDir, 'id_ed25519');
    const KEY_CONTENTS = '-----BEGIN OPENSSH PRIVATE KEY-----\nfleet-key\n-----END KEY-----\n';
    writeFileSync(keyPath, KEY_CONTENTS);
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        veritySettings: async () => ({
          gitUserName: null,
          gitUserEmail: null,
          gitSshPrivateKeyPath: keyPath, // key provided by PATH…
          gitSshPrivateKey: null, // …NOT by DB contents
          gitSshPublicKeyPath: null,
          gitSshPublicKey: 'ssh-ed25519 PUBKEY',
          gitKnownHostsPath: null,
          gitKnownHosts: null,
          gitAllowedSignersPath: null,
          gitAllowedSigners: 'me@x namespaces="git" ssh-ed25519 PUBKEY',
          githubAppId: null,
          githubAppInstallationId: null,
          githubAppPrivateKey: null,
          dopplerServiceToken: null,
          claudeCodeOauthCredentialsJson: null,
          codexAuthJson: null,
          googleDriveClientId: null,
          googleDriveAccountEmail: null,
          googleDriveRefreshToken: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      const binds = spec.binds ?? [];
      const env = spec.env ?? [];
      // Broker mode engaged: the key is NOT mounted into the sandbox (H1 win)…
      expect(binds.some((b) => b.endsWith('id_ed25519:ro'))).toBe(false);
      const token = 'test-signing-capability';
      const tokenPath = join(
        secretRoot,
        'git',
        `signing_broker_token.${signingBrokerTokenHash(token)}`,
      );
      // …and the broker URL + token derived from the FILE contents are available.
      expect(env).toContain('VERITY_SIGNING_URL=http://relay:8080');
      expect(env.some((e) => e.startsWith('VERITY_SIGNING_TOKEN='))).toBe(false);
      expect(readFileSync(tokenPath, 'utf8')).toBe(`${token}\n`);
      expect(binds).toContain(`${tokenPath}:${SIGNING_BROKER_TOKEN_FILE}:ro`);
      expect(env).toContain('GIT_CONFIG_VALUE_0=/opt/agent-seed/bin/verity-git-sign');
      // The key contents never leak into the sandbox env.
      expect(env.some((e) => e.includes('fleet-key'))).toBe(false);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('always provisions an isolated project network with a relay (H2)', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-h2-net-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const ensureNetwork = vi.fn(async () => undefined);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        ensureNetwork,
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        git,
        isDirectory: () => false,
      });

      await expect(provisioner.provision(id)).resolves.toMatchObject({ state: 'active' });
      expect(ensureNetwork).toHaveBeenCalledWith(projectNetworkName(id), {
        labels: { 'verity.project-id': id },
      });
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      expect((created?.payload as ContainerSpec).network).toBe(projectNetworkName(id));
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('rejects an invalid relay Claude gateway before mutating Docker', () => {
    const { client: docker, calls } = fakeDocker();
    expect(() =>
      createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        claudeEgressGatewayUrl: 'http://gateway',
      }),
    ).toThrow('project relay gateway URL is invalid');
    expect(calls).toEqual([]);
  });

  it('rejects an invalid project-specific Claude gateway before mutating Docker', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeEgressGatewayForProject: () => ({
        url: 'http://invalid-project-gateway',
      }),
      git,
      isDirectory: () => false,
    });

    await expect(provisioner.provision(id)).rejects.toThrow(
      'project relay Claude gateway URL is invalid',
    );
    expect(calls).toEqual([]);
  });

  it('requires Docker network creation before mutating Docker', () => {
    const { client: docker, calls } = fakeDocker();
    const dockerWithoutNetworkCreation = { ...docker };
    delete dockerWithoutNetworkCreation.ensureNetwork;
    expect(() =>
      createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: dockerWithoutNetworkCreation,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
      }),
    ).toThrow('project relay provisioning requires Docker network creation');
    expect(calls).toEqual([]);
  });

  it('emits every cohort member from one unconditional place in the source', () => {
    // The runtime test below can only check the option shapes it thinks to enumerate,
    // and the property that makes partial presence a safe recreate trigger is stronger
    // than that: no configuration, present or future, may emit part of a cohort. This
    // is a cheap structural proxy for that claim, not the claim itself — it pins that
    // every member is assigned exactly once, that the assignments share one array
    // literal, and that nothing BETWEEN the first and last member is conditionally
    // spread. What it therefore catches is the likely regression: a later
    // Codex-specific knob wrapping one member. What it does NOT catch is a gate
    // around the whole block (harmless — that suppresses the cohort entirely, which
    // is the "none of it" case) or a refactor that builds the env list through a
    // helper, which would fail the exactly-once check instead and has to be
    // re-argued here by hand.
    // Comments stripped first, or a doc block that merely NAMES a cohort member —
    // this file has several — counts as a second assignment and fails the test with
    // a claim about the code that is not true of it. Line comments are matched only
    // at the start of a line: `//` also occurs inside the `https://` literals here,
    // and a string-unaware rule would truncate the line an assignment sits on and
    // quietly erase it, turning this pin vacuous rather than failing it. The
    // exactly-once check below is the backstop for the rest: any strip that eats an
    // assignment leaves zero matches and fails, rather than passing on less text.
    const source = readFileSync(new URL('provisioner.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    for (const cohort of SANDBOX_ENV_COHORTS) {
      const positions = cohort.map((key) => {
        const assignments = [...source.matchAll(new RegExp(`\`${key}=`, 'g'))];
        expect(assignments, `${key} must be assigned exactly once`).toHaveLength(1);
        return assignments[0]!.index;
      });
      // One array literal: no `];` between the first member and the last.
      const span = source.slice(Math.min(...positions), Math.max(...positions));
      expect(span, 'cohort members must share one array literal').not.toContain('];');
      // And nothing in that span is conditionally included.
      expect(span, 'no cohort member may sit behind a conditional spread').not.toContain('...(');
    }
  });

  it('writes every env cohort whole or not at all', async () => {
    // The invariant `classifyProjectContainer` condemns a sandbox on. It fails a
    // container that carries only PART of a cohort, which is safe only because a
    // recreate cannot reproduce that state — this container phase emits all of a
    // cohort or none of it. If that ever stops holding, the recreated container is
    // partial again and every reconcile tick recreates it, forever: `legacy` has no
    // attempt ceiling. Asserted from the created spec, in both directions:
    //   - egress projection configured    -> every member present and NON-EMPTY
    //     (an empty value counts as absent to the classifier, so it would be just
    //     as unresolvable as a missing one)
    //   - egress projection NOT opted into -> no member present at all
    // Run over every shape the gate distinguishes, not just all-on and all-off: the
    // gate has four independent conditions, and production holds the in-between ones
    // (an identity provisioned but the connector port left unset, or no secret root).
    // A shape that satisfied some conditions and emitted some of the cohort is exactly
    // the state that would loop.
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-cohort-'));
    try {
      const egressIdentity = (): ClaudeEgressIdentityService => fakeEgressIdentity().service;
      /** Each shape: what the provisioner is given, and whether the gate should open.
       *  The gate's fourth condition, the Claude gateway URL, is not an option — it
       *  comes from `projectRelay.claudeGatewayUrl()`, which is typed `string`, so no
       *  reachable configuration closes the gate that way. */
      const shapes: Array<{
        repo: string;
        cohortEmitted: boolean;
        opts: () => Partial<Parameters<typeof createProvisioner>[0]>;
      }> = [
        {
          repo: 'cohort-full',
          cohortEmitted: true,
          opts: () => ({
            claudeEgressIdentity: egressIdentity(),
            claudeEgressGatewayUrl: 'https://legacy-gateway:9443',
            claudeConnectorPort: 9444,
            gitSecretRoot: secretRoot,
          }),
        },
        {
          repo: 'cohort-plain',
          cohortEmitted: false,
          opts: () => ({ gitSecretRoot: secretRoot }),
        },
        {
          repo: 'cohort-no-port',
          cohortEmitted: false,
          opts: () => ({
            claudeEgressIdentity: egressIdentity(),
            claudeEgressGatewayUrl: 'https://legacy-gateway:9443',
            gitSecretRoot: secretRoot,
          }),
        },
        {
          repo: 'cohort-no-secret-root',
          cohortEmitted: false,
          opts: () => ({
            claudeEgressIdentity: egressIdentity(),
            claudeEgressGatewayUrl: 'https://legacy-gateway:9443',
            claudeConnectorPort: 9444,
          }),
        },
      ];

      const provisionWith = async (
        shape: (typeof shapes)[number],
      ): Promise<Array<{ key: string; value: string }>> => {
        // A distinct repo per variant: `(owner, repo)` is a unique identity claim,
        // so seeding the shared fixture twice would hand back an id with no row.
        const id = randomUUID();
        const { repo } = shape;
        await ctx.store.upsertProject({
          ...baseInput,
          id,
          repo,
          containerName: `dev-heey-global-${repo}`,
        });
        const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
        const { client: docker, calls: dockerCalls } = fakeDocker({
          ensureNetwork: vi.fn(async () => undefined),
        });
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker,
          token: 'tok',
          defaultImageRef: 'default',
          ghTokenFilePath: '/etc/gh-token',
          hostCloneRoot: '/var/lib/verity-dev',
          ...shape.opts(),
          projectRelay: {
            start: vi.fn(async (binding: ProjectRelayBinding) => ({
              identity: {
                projectId: binding.projectId,
                containerGeneration: binding.containerGeneration,
              },
              signingCapability: 'sign-capability',
              githubCapability: 'github-capability',
            })),
            stop: vi.fn(async () => undefined),
            brokerUrl: () => 'http://relay:8080',
            claudeGatewayUrl: () => 'https://relay:8443',
          },
          git,
          isDirectory: () => false,
          chownRunnerFile: vi.fn(),
          dockerHostForBuild: 'unix:///var/run/docker.sock',
          containerCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
        });
        await provisioner.provision(id);
        const created = dockerCalls.find((call) => call.method === 'createContainer');
        // Without this the "absent entirely" half would pass vacuously for any shape
        // that failed to provision at all, which is the opposite of what it pins.
        expect(created, `${repo}: no container was created`).toBeDefined();
        return ((created?.payload as ContainerSpec).env ?? []).flatMap((entry) => {
          const separator = entry.indexOf('=');
          return separator === -1
            ? []
            : [{ key: entry.slice(0, separator), value: entry.slice(separator + 1) }];
        });
      };

      expect(SANDBOX_ENV_COHORTS.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        const env = await provisionWith(shape);
        for (const cohort of SANDBOX_ENV_COHORTS) {
          for (const key of cohort) {
            const set = env.find((entry) => entry.key === key);
            if (shape.cohortEmitted) {
              expect(set, `${shape.repo}: ${key} must be emitted`).toBeDefined();
              expect(set?.value, `${shape.repo}: ${key} must never be emitted empty`).not.toBe('');
            } else {
              expect(set, `${shape.repo}: ${key} must be absent entirely`).toBeUndefined();
            }
          }
        }
      }
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('cuts broker and Claude coordinates over to one generation-bound relay', async () => {
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-relay-cutover-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const ensureNetwork = vi.fn(async () => undefined);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        ensureNetwork,
      });
      const startRelay = vi.fn(async (binding) => ({
        identity: {
          projectId: binding.projectId,
          containerGeneration: binding.containerGeneration,
        },
        signingCapability: 'sign-capability',
        githubCapability: 'github-capability',
      }));
      const stopRelay = vi.fn(async () => undefined);
      const ghTokenCapabilities = {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(async () => undefined),
      };
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        ghTokenCapabilities,
        claudeEgressIdentity: {
          gatewayMaterial: vi.fn(),
          sandboxMaterial: vi.fn(async () => ({
            projectId: id,
            caCertPem: 'ca',
            clientCertPem: 'cert',
            clientKeyPem: 'key',
          })),
          revokeProject: vi.fn(async () => undefined),
        },
        claudeEgressGatewayUrl: 'https://legacy-gateway:9443',
        claudeConnectorPort: 9444,
        projectRelay: {
          start: startRelay,
          stop: stopRelay,
          brokerUrl: () => 'http://relay:8080',
          claudeGatewayUrl: () => 'https://relay:8443',
        },
        git,
        isDirectory: () => false,
        chownRunnerFile: vi.fn(),
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      });

      await provisioner.provision(id);

      expect(startRelay).toHaveBeenCalledOnce();
      expect(stopRelay).toHaveBeenCalledOnce();
      expect(stopRelay).toHaveBeenCalledWith(id);
      expect(startRelay.mock.calls[0]?.[0]).toMatchObject({
        projectId: id,
        owner: 'example-org',
        repo: 'example-repo',
        containerGeneration: expect.any(String),
        claudeGateway: { host: '127.0.0.1', port: 9443 },
      });
      expect(ghTokenCapabilities.issue).not.toHaveBeenCalled();
      const created = dockerCalls.find((call) => call.method === 'createContainer');
      const methods = dockerCalls.map((call) => call.method);
      expect(methods.indexOf('stopContainer')).toBeLessThan(methods.indexOf('createContainer'));
      expect(methods.indexOf('removeContainer')).toBeLessThan(methods.indexOf('createContainer'));
      const spec = created?.payload as ContainerSpec;
      expect(spec.env).toContain('VERITY_GH_TOKEN_URL=http://relay:8080/internal/github/token');
      expect(spec.env).toContain('VERITY_CLAUDE_EGRESS_URL=https://relay:8443');
      expect(readFileSync(join(secretRoot, 'git', `gh_token_capability.${id}`), 'utf8')).toBe(
        'github-capability\n',
      );

      // Every container phase mints a FRESH generation, never re-adopting one that
      // already has a relay container. The GC's relay sweep depends on it: a relay
      // is named `sha256(projectId + generation)`, so a starting provision always
      // creates a container that no earlier listing could have named — which is
      // why the sweep can decide from a snapshot instead of a lock shared with the
      // provisioner (`docker-gc.ts`).
      await provisioner.recreateContainer(id, { confirmWarnings: true });
      const generations = startRelay.mock.calls.map(
        ([binding]) => (binding as { containerGeneration: string }).containerGeneration,
      );
      expect(generations).toHaveLength(2);
      expect(new Set(generations).size).toBe(2);
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('keeps pinning the gateway server name when a relay addresses it by container name', async () => {
    // The relay serves the gateway leaf (CN/SAN = 'verity') but is addressed as
    // 'relay'. Without the pin the connector verifies against 'relay', no SAN
    // matches, and every Claude turn dies on the TLS handshake as a 502.
    const id = await seedProject();
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-relay-servername-'));
    try {
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        ensureNetwork: vi.fn(async () => undefined),
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: '/var/lib/verity-dev',
        gitSecretRoot: secretRoot,
        ghTokenCapabilities: {
          issue: vi.fn(),
          resolve: vi.fn(),
          revokeProject: vi.fn(async () => undefined),
        },
        claudeEgressIdentity: {
          gatewayMaterial: vi.fn(),
          sandboxMaterial: vi.fn(async () => ({
            projectId: id,
            caCertPem: 'ca',
            clientCertPem: 'cert',
            clientKeyPem: 'key',
          })),
          revokeProject: vi.fn(async () => undefined),
        },
        claudeEgressGatewayUrl: 'https://verity:9443',
        claudeEgressServerName: 'verity',
        claudeConnectorPort: 9444,
        projectRelay: {
          start: vi.fn(async (binding) => ({
            identity: {
              projectId: binding.projectId,
              containerGeneration: binding.containerGeneration,
            },
            signingCapability: 'sign-capability',
            githubCapability: 'github-capability',
          })),
          stop: vi.fn(async () => undefined),
          brokerUrl: () => 'http://relay:8080',
          claudeGatewayUrl: () => 'https://relay:8443',
        },
        git,
        isDirectory: () => false,
        chownRunnerFile: vi.fn(),
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        containerCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      });

      await provisioner.provision(id);

      const created = dockerCalls.find((call) => call.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.env).toContain('VERITY_CLAUDE_EGRESS_URL=https://relay:8443');
      expect(spec.env).toContain('VERITY_CLAUDE_EGRESS_SERVERNAME=verity');
      expect(spec.env).toContain('VERITY_CLAUDE_EGRESS_AUTHORITY=verity:9443');
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('rolls back an active relay when later sandbox startup fails', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker } = fakeDocker({
      ensureNetwork: vi.fn(async () => undefined),
      startContainer: vi.fn(async () => {
        throw new Error('sandbox start failed');
      }),
    });
    const stopRelay = vi.fn(async () => undefined);
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      projectRelay: {
        start: vi.fn(async (binding) => ({
          identity: {
            projectId: binding.projectId,
            containerGeneration: binding.containerGeneration,
          },
          signingCapability: 'sign-capability',
          githubCapability: 'github-capability',
        })),
        stop: stopRelay,
        brokerUrl: () => 'http://relay:8080',
        claudeGatewayUrl: () => 'https://relay:8443',
      },
      git,
      isDirectory: () => false,
    });

    await expect(provisioner.provision(id)).rejects.toThrow('sandbox start failed');
    expect(stopRelay).toHaveBeenCalledWith(id);
  });

  it('does not stop an existing relay when failure happens before relay cutover', async () => {
    const id = await seedProject('container_starting');
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const { client: docker } = fakeDocker({ ensureNetwork: vi.fn(async () => undefined) });
    const stopRelay = vi.fn(async () => undefined);
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: async () => {
        throw new Error('image resolver unavailable');
      },
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      projectRelay: {
        start: vi.fn(),
        stop: stopRelay,
        brokerUrl: () => 'http://relay:8080',
        claudeGatewayUrl: () => 'https://relay:8443',
      },
      git,
      isDirectory: () => true,
    });

    await expect(provisioner.provision(id)).rejects.toThrow('image resolver unavailable');
    expect(stopRelay).not.toHaveBeenCalled();
  });

  it('always attaches the sandbox only to its project network', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.network).toBe(projectNetworkName(id));
    expect((spec.env ?? []).some((e) => e.startsWith('VERITY_SIGNING_URL='))).toBe(false);
  });

  it('gives the sandbox the MCP gateway URL without a GitHub-token capability', async () => {
    // The brokered secret tools (ADR 0014) have nothing to do with GitHub, and the gateway
    // needs no capability file of its own — the bearer is minted per turn. So the only thing
    // it waits on is the internal listener the relay exposes.
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker, calls: dockerCalls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      git,
      isDirectory: () => false,
    });

    await provisioner.provision(id);

    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const env = (created?.payload as ContainerSpec).env ?? [];
    expect(env).toContain('VERITY_MCP_GATEWAY_URL=http://relay:8080/internal/mcp');
    expect(env.some((entry) => entry.startsWith('VERITY_GH_TOKEN_URL='))).toBe(false);
  });

  it('recreates only the container without touching the project clone', async () => {
    const id = await seedProject('active');
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const { client: docker, calls: dockerCalls } = fakeDocker({
      createdContainerId: 'cid-recreated',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      git,
      isDirectory: () => true,
    });

    const result = await provisioner.recreateContainer(id);

    expect(result.state).toBe('active');
    expect(git).not.toHaveBeenCalled();
    expect(dockerCalls.map((c) => c.method)).toEqual([
      'stopContainer',
      'removeContainer',
      'ensureNetwork',
      'createContainer',
      'startContainer',
    ]);
    const created = dockerCalls.find((c) => c.method === 'createContainer');
    const spec = created?.payload as ContainerSpec;
    expect(spec.binds).toContain('/var/lib/verity-dev/example-org-example-repo:/work');
    expect(spec.binds).not.toContain('claude-config-verity:/home/dev/.claude');
    expect(spec.binds).not.toContain('codex-config-verity:/home/dev/.codex');
  });

  it('rejects container recreate for unknown or absent projects', async () => {
    const absent = await seedProject('absent');
    const { client: docker, calls: dockerCalls } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
    });

    await expect(provisioner.recreateContainer('missing')).rejects.toThrow(
      'project gone mid-recreate',
    );
    await expect(provisioner.recreateContainer(absent)).rejects.toThrow(
      `project ${absent} is absent; provision it instead`,
    );
    expect(dockerCalls).toEqual([]);
  });

  it('reports confirmable devcontainer warnings without mutating the project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-provision-warnings-'));
    try {
      const id = await seedProject('active');
      const clonePath = join(root, 'example-org-example-repo');
      mkdirSync(join(clonePath, '.devcontainer'), { recursive: true });
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "root" }',
      );
      const { client: docker } = fakeDocker();
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
      });

      await expect(provisioner.provisionWarnings('missing')).resolves.toEqual([]);
      await expect(provisioner.provisionWarnings(id)).resolves.toEqual([
        expect.stringContaining('remoteUser=root'),
      ]);
      rmSync(join(clonePath, '.devcontainer'), { recursive: true, force: true });
      await expect(provisioner.provisionWarnings(id)).resolves.toEqual([]);
      expect((await ctx.store.getProject(id))?.state).toBe('active');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates idempotently when the old container is already gone', async () => {
    const id = await seedProject('active');
    const { client: docker, calls: dockerCalls } = fakeDocker({
      stopContainer: vi.fn(async (containerId: string) => {
        dockerCalls.push({ method: 'stopContainer', payload: containerId });
        throw new DockerError({ kind: 'container_not_found', id: containerId });
      }),
      removeContainer: vi.fn(async (containerId: string) => {
        dockerCalls.push({ method: 'removeContainer', payload: containerId });
        throw new DockerError({ kind: 'container_not_found', id: containerId });
      }),
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
    });

    await expect(provisioner.recreateContainer(id)).resolves.toMatchObject({ state: 'active' });
    expect(dockerCalls.map((c) => c.method)).toEqual([
      'stopContainer',
      'removeContainer',
      'ensureNetwork',
      'createContainer',
      'startContainer',
    ]);
  });

  it('force-pulls the resolved image on recreate even when the image is already present (ADR 0004)', async () => {
    const id = await seedProject('active');
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    // createContainer succeeds (image present) — no image_not_found. The pull
    // must still happen because recreate force-pulls.
    const pullImage = vi.fn(async () => {});
    const { client: docker, calls: dockerCalls } = fakeDocker({
      pullImage,
      createdContainerId: 'cid-recreated',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      git,
      isDirectory: () => true,
    });

    const result = await provisioner.recreateContainer(id);

    expect(result.state).toBe('active');
    // The force-pull happened with the resolved image ref, despite create
    // never reporting image_not_found.
    expect(pullImage).toHaveBeenCalledOnce();
    expect(pullImage).toHaveBeenCalledWith('ghcr.io/heey-global/dev-base:2026.06');
    // Single create — the force-pull precedes it, no on-demand retry.
    expect(dockerCalls.filter((c) => c.method === 'createContainer')).toHaveLength(1);
    expect(dockerCalls.map((c) => c.method)).toEqual([
      'stopContainer',
      'removeContainer',
      'ensureNetwork',
      'createContainer',
      'startContainer',
    ]);
  });

  it('does not force-pull a locally built devcontainer image on recreate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-recreate-devc-'));
    try {
      const clonePath = join(root, 'example-org-example-repo');
      const devcontainerDir = join(clonePath, '.devcontainer');
      mkdirSync(devcontainerDir, { recursive: true });
      writeFileSync(join(devcontainerDir, 'devcontainer.json'), '{ "image": "node:24" }');
      const id = await seedProject('active');
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const pullImage = vi.fn(async () => {});
      const { client: docker, calls: dockerCalls } = fakeDocker({
        pullImage,
        imageExists: vi.fn(async () => false),
        createdContainerId: 'cid-devc-recreated',
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: {
          ref: '/opt/verity-features/verity-sandbox-toolkit',
          version: '1.0.0',
          identity: 'sha256:toolkit-v1',
        },
      });

      const result = await provisioner.recreateContainer(id);

      expect(result.state).toBe('active');
      expect(build).toHaveBeenCalledOnce();
      expect(pullImage).not.toHaveBeenCalled();
      expect(dockerCalls.map((c) => c.method)).toEqual([
        'stopContainer',
        'removeContainer',
        'ensureNetwork',
        'createContainer',
        'startContainer',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forceRebuild rebuilds a cached devcontainer image with --no-cache; a plain recreate reuses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-recreate-rebuild-'));
    try {
      const clonePath = join(root, 'example-org-example-repo');
      const devcontainerDir = join(clonePath, '.devcontainer');
      mkdirSync(devcontainerDir, { recursive: true });
      writeFileSync(join(devcontainerDir, 'devcontainer.json'), '{ "image": "node:24" }');
      const id = await seedProject('active');
      // The cache HITS — which is exactly the situation the button exists for:
      // the devcontainer content hash is unchanged, so nothing else in the
      // system will ever decide this image needs building again.
      const imageExists = vi.fn(async () => true);
      const removeContainer = vi.fn(async () => {});
      const { client: docker, calls: dockerCalls } = fakeDocker({
        imageExists,
        removeContainer,
        createdContainerId: 'cid-rebuilt',
      });
      const build = vi.fn<DevcontainerBuildSpawner>(async () => {
        expect(dockerCalls.some((call) => call.method === 'stopContainer')).toBe(false);
        // The old sandbox and every active-only service stay available until
        // the replacement image is ready.
        expect((await ctx.store.getProject(id))?.state).toBe('active');
        return { stdout: '', stderr: '' };
      });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: {
          ref: '/opt/verity-features/verity-sandbox-toolkit',
          version: '1.0.0',
          identity: 'sha256:toolkit-v1',
        },
      });

      // Baseline: the ordinary recreate ("Update & restart") keeps the cache.
      await provisioner.recreateContainer(id);
      expect(build).not.toHaveBeenCalled();
      expect(imageExists).toHaveBeenCalled();
      dockerCalls.length = 0;

      const rebuilt = await provisioner.recreateContainer(id, { forceRebuild: true });

      expect(rebuilt.state).toBe('active');
      expect(build).toHaveBeenCalledOnce();
      expect(build.mock.calls[0]?.[0]).toMatchObject({ noCache: true });
      // The forced prebuild bypasses the cache. The only new cache lookup is the
      // cheap resolution after that build, immediately before replacement.
      expect(imageExists).toHaveBeenCalledTimes(2);

      dockerCalls.length = 0;
      removeContainer.mockRejectedValueOnce(new Error('remove failed'));
      await expect(provisioner.recreateContainer(id, { forceRebuild: true })).rejects.toThrow(
        'remove failed',
      );
      expect(await ctx.store.getProject(id)).toMatchObject({
        state: 'failed',
        provisionError: expect.stringContaining('container replacement failed'),
      });

      await ctx.store.updateProjectState(id, 'active');
      build.mockRejectedValueOnce(new Error('cacheless build failed'));
      await expect(provisioner.recreateContainer(id, { forceRebuild: true })).rejects.toThrow(
        'cacheless build failed',
      );
      expect(await ctx.store.getProject(id)).toMatchObject({
        state: 'active',
        provisionError: null,
        provisionWarning: expect.stringContaining('devcontainer build failed'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The app hides the button for a base-image project, but the flag is a public
  // API field and the app cannot always know which of the two a project is (that
  // depends on the clone carrying a `.devcontainer/`). So the server has to treat
  // a rebuild with nothing to build as an ordinary recreate, not an error.
  it('forceRebuild is inert for a project on the base image', async () => {
    const id = await seedProject('active');
    const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
    const { client: docker } = fakeDocker({ createdContainerId: 'cid-base' });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      devcontainerBuild: build,
      dockerHostForBuild: 'unix:///var/run/docker.sock',
      // No `.devcontainer/` in the clone → nothing was ever built for it.
      isDirectory: () => false,
    });

    const result = await provisioner.recreateContainer(id, { forceRebuild: true });

    expect(result.state).toBe('active');
    expect(build).not.toHaveBeenCalled();
  });

  it('does NOT force-pull on the normal provision path when the image is present (lazy path preserved, ADR 0004)', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /clone/ }, { match: /set-url/ }]);
    // createContainer succeeds (image present) → the lazy path must not pull.
    const pullImage = vi.fn(async () => {});
    const { client: docker } = fakeDocker({
      pullImage,
      createdContainerId: 'cid-provisioned',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });

    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');
    // Lazy path: no proactive pull on the happy path.
    expect(pullImage).not.toHaveBeenCalled();
  });

  it('surfaces a provision failure when the recreate force-pull itself fails (ADR 0004)', async () => {
    const id = await seedProject('active');
    await ctx.store.recordProjectImageRef(id, 'ghcr.io/heey-global/dev-base:previous', null);
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pullImage = vi.fn(async () => {
      throw new DockerError({
        kind: 'image_not_found',
        image: 'ghcr.io/heey-global/dev-base:2026.06',
        message: 'pull access denied',
      });
    });
    const { client: docker } = fakeDocker({
      pullImage,
      createdContainerId: 'cid-recreated',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      git,
      isDirectory: () => true,
    });

    await expect(provisioner.recreateContainer(id)).rejects.toThrow(/docker.*image_not_found/);
    expect(pullImage).toHaveBeenCalledOnce();
    const row = await ctx.store.getProject(id);
    expect(row?.state).toBe('failed');
    expect(row?.provisionError).toMatch(/image_not_found/);
    expect(row?.imageRef).toBe('ghcr.io/heey-global/dev-base:previous');
  });

  it('resolves a name-taken conflict from create AFTER a force-pull on recreate (inspect + start, ADR 0004)', async () => {
    const id = await seedProject('active');
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const pullImage = vi.fn(async () => {});
    const inspectMock = vi.fn(async () => ({ id: 'existing-cid', running: false }));
    const startMock = vi.fn(async () => {});
    const { client: docker } = fakeDocker({
      pullImage,
      // Force-pull succeeds, THEN create hits a name conflict → the existing
      // inspect-and-reuse handler must still kick in through the force-pull
      // branch, identical to the lazy path.
      createContainer: vi.fn(async () => {
        throw new DockerError({ kind: 'conflict', message: 'name already in use' });
      }),
      inspectContainer: inspectMock,
      startContainer: startMock,
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      git,
      isDirectory: () => true,
    });

    const result = await provisioner.recreateContainer(id);

    expect(result.state).toBe('active');
    expect(pullImage).toHaveBeenCalledOnce();
    expect(inspectMock).toHaveBeenCalledWith('dev-example-org-example-repo');
    expect(startMock).toHaveBeenCalledWith('existing-cid');
  });

  it('degrades to the lazy create path on recreate when no pull capability is wired (ADR 0004 soft fallback)', async () => {
    const id = await seedProject('active');
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    // No pullImage in the fake → recreate can't force-pull; it must still
    // succeed by creating the container directly (soft degradation, not a throw).
    const { client: docker, calls: dockerCalls } = fakeDocker({
      createdContainerId: 'cid-recreated',
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/var/lib/verity-dev',
      claudeConfigVolume: 'claude-config-verity',
      codexConfigVolume: 'codex-config-verity',
      git,
      isDirectory: () => true,
    });

    const result = await provisioner.recreateContainer(id);

    expect(result.state).toBe('active');
    // No pull capability wired at all (the soft-fallback precondition).
    expect(docker).not.toHaveProperty('pullImage');
    expect(dockerCalls.filter((c) => c.method === 'createContainer')).toHaveLength(1);
  });

  it('mints a fresh token for the server-side clone/fetch WITHOUT writing a .gh-token file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-project-minted-token-'));
    try {
      const repoDir = join(root, 'example-org-example-repo');
      mkdirSync(join(repoDir, '.git'), { recursive: true });
      const id = await seedProject('absent');
      const { runner: git, calls: gitCalls } = fakeGit([
        { match: /fetch origin/ },
        { match: /reset --hard origin\/main/ },
      ]);
      const { client: docker, calls: dockerCalls } = fakeDocker();
      const mint = vi.fn(async () => 'fresh-project-token');
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'fallback-token',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        projectTokenMint: mint,
        git,
      });

      await provisioner.provision(id);

      // The minted token authenticates the SERVER-SIDE fetch...
      expect(mint).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'example-org', repo: 'example-repo' }),
      );
      const fetchCall = gitCalls.find((c) => c.args.includes('fetch'));
      expect(fetchCall?.args.join(' ')).toContain(
        `http.extraheader=Authorization: Basic ${Buffer.from(
          'x-access-token:fresh-project-token',
          'utf8',
        ).toString('base64')}`,
      );
      // ...but it is NEVER written into the working tree or mounted (broker-only).
      expect(existsSync(join(repoDir, '.gh-token'))).toBe(false);
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect((spec.binds ?? []).some((b) => b.includes('.gh-token'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('issues a per-project capability + mounts it (broker URL env) when the token broker is wired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-ghcap-clone-'));
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-ghcap-secret-'));
    try {
      const id = await seedProject('absent');
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker({
        inspectContainer: vi.fn(async (container: string) => ({
          id: container,
          running: true,
          networks: { 'verity-net': { ipAddress: '172.19.0.4' } },
        })),
      });
      const capabilities = createGhTokenCapabilityRegistry(ctx.db);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'fallback-token',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        gitSecretRoot: secretRoot,
        ghTokenCapabilities: capabilities,
        projectRelay: {
          async start(binding) {
            const githubCapability = await capabilities.issue({
              projectId: binding.projectId,
              owner: 'example-org',
              repo: 'example-repo',
              containerGeneration: binding.containerGeneration,
            });
            return {
              identity: {
                projectId: binding.projectId,
                containerGeneration: binding.containerGeneration,
              },
              signingCapability: 'test-signing-capability',
              githubCapability,
            };
          },
          async stop() {},
          brokerUrl: () => 'http://relay:8080',
          claudeGatewayUrl: () => 'https://relay:8443',
        },
        projectTokenMint: async () => 'server-side-token',
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      // The capability is materialized as a read-only file and mounted (never env).
      const capPath = join(secretRoot, 'git', `gh_token_capability.${id}`);
      expect(spec.binds).toContain(`${capPath}:/run/verity/gh-token-capability:ro`);
      expect(statSync(capPath).mode & 0o777).toBe(0o644);
      // The endpoint URL is non-secret env; no gh-token file anywhere.
      expect(spec.env).toContain('VERITY_GH_TOKEN_URL=http://relay:8080/internal/github/token');
      expect(spec.env).toContain(`VERITY_GH_TOKEN_DOCKER_CONTAINER=${spec.name}`);
      // The memory broker (ADR 0008) rides the same capability + broker URL.
      expect(spec.env).toContain(
        'VERITY_PROJECT_MEMORY_URL=http://relay:8080/internal/project/memory',
      );
      expect(spec.env).toContain('GIT_CONFIG_COUNT=1');
      expect(spec.env).toContain('GIT_CONFIG_KEY_0=credential.https://github.com.helper');
      expect(spec.env).toContain('GIT_CONFIG_VALUE_0=/opt/agent-seed/bin/verity-gh-cred');
      expect((spec.binds ?? []).some((b) => b.includes('.gh-token'))).toBe(false);
      // The materialized capability resolves back to THIS project's binding.
      expect(await capabilities.resolve(readFileSync(capPath, 'utf8').trim())).toEqual({
        projectId: id,
        owner: 'example-org',
        repo: 'example-repo',
        containerGeneration: expect.any(String),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('mounts per-project data as named-volume subpaths (M16) while keeping deploy binds', async () => {
    // The data volume is mounted at <vol> inside the server; clones + secrets live
    // under it, so a sibling resolves them by volume name + subpath.
    const vol = mkdtempSync(join(tmpdir(), 'verity-datavol-'));
    try {
      const id = await seedProject('absent');
      const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
      const { client: docker, calls: dockerCalls } = fakeDocker();
      const capabilities = createGhTokenCapabilityRegistry(ctx.db);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'fallback-token',
        defaultImageRef: 'default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: join(vol, 'workspaces'),
        gitSecretRoot: join(vol, 'secrets'),
        ghTokenCapabilities: capabilities,
        dataVolume: 'verity-data',
        dataVolumeRoot: vol,
        projectTokenMint: async () => 'server-side-token',
        git,
        isDirectory: () => false,
      });

      await provisioner.provision(id);

      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      // /work is a named-volume mount with the clone subpath — no host path.
      expect(spec.volumeMounts).toEqual(
        expect.arrayContaining([
          {
            volume: 'verity-data',
            target: '/work',
            subpath: 'workspaces/example-org-example-repo',
            readOnly: false,
          },
          {
            volume: 'verity-data',
            target: '/run/verity/gh-token-capability',
            subpath: `secrets/git/gh_token_capability.${id}`,
            readOnly: true,
          },
        ]),
      );
      // Deploy-level mounts (outside the volume root) stay host binds.
      expect(spec.binds).toContain('/opt/agent-seed:/opt/agent-seed:ro');
      expect(spec.binds).toContain('/dev/null:/etc/profile.d/gh-token.sh:ro');
      // Nothing under the volume root leaks back into binds.
      expect((spec.binds ?? []).some((b) => b.startsWith(`${vol}/`))).toBe(false);
    } finally {
      rmSync(vol, { recursive: true, force: true });
    }
  });

  it('fails closed when a data volume is set but a mount root escapes it (no silent empty mount)', async () => {
    const id = await seedProject('absent');
    const { runner: git } = fakeGit([{ match: /\bclone\b/ }, { match: /remote set-url/ }]);
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      // hostCloneRoot is NOT under the data volume root → would silently stay a host
      // bind (empty /work in the sibling). Must fail closed instead.
      hostCloneRoot: '/somewhere/else/workspaces',
      gitSecretRoot: '/vol/secrets',
      dataVolume: 'verity-data',
      dataVolumeRoot: '/vol',
      git,
      isDirectory: () => false,
    });

    await expect(provisioner.provision(id)).rejects.toThrow(/outside its root/);
    const failed = await ctx.store.getProject(id);
    expect(failed?.state).toBe('failed');
  });

  it('re-provisions an existing clone from the configured default branch', async () => {
    const id = await seedProject('absent');
    await ctx.store.updateProjectSettings(id, { defaultBranch: 'develop' });
    // The bind-mount path already exists with a .git/ → resume path.
    const isDir = vi.fn((p: string) => p === '/srv/verity-dev/example-org-example-repo');
    const { runner: git, calls: gitCalls } = fakeGit([
      { match: /fetch origin/ },
      { match: /reset --hard origin\/develop/ },
    ]);
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity-dev/',
      git,
      isDirectory: isDir,
    });
    // Patch isRepoDir to return true (the fake git runner doesn't actually
    // touch the FS, so the production stat-sync check would be a no-op).
    (provisioner as unknown as { isRepoDir: () => boolean }).isRepoDir = () => true;

    await provisioner.provision(id);

    expect(gitCalls.some((c) => c.args.includes('clone'))).toBe(false); // NO clone
    expect(gitCalls.some((c) => c.args.includes('fetch'))).toBe(true);
    expect(
      gitCalls.some((c) => c.args.includes('reset') && c.args.includes('origin/develop')),
    ).toBe(true);
  });

  it('serializes every managed-checkout synchronization for the same project', async () => {
    const id = await seedProject('active');
    await ctx.store.updateProjectSettings(id, { defaultBranch: 'main' });
    let releaseFirstFetch!: () => void;
    const firstFetchBlocked = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let firstFetchStarted!: () => void;
    const firstFetchRunning = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let fetches = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const git: GitRunner = async (args) => {
      if (args.includes('fetch')) {
        fetches += 1;
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (fetches === 1) {
          firstFetchStarted();
          await firstFetchBlocked;
        }
        activeFetches -= 1;
        return { stdout: '', stderr: '' };
      }
      if (args.includes('reset')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity-dev/',
      git,
      isDirectory: () => true,
    });
    (provisioner as unknown as { isRepoDir: () => boolean }).isRepoDir = () => true;

    const first = provisioner.syncProjectCheckout(id);
    await firstFetchRunning;
    const second = provisioner.syncProjectCheckout(id);
    await Promise.resolve();

    expect(fetches).toBe(1);
    releaseFirstFetch();
    await Promise.all([first, second]);
    expect(fetches).toBe(2);
    expect(maxActiveFetches).toBe(1);
  });

  it('serializes provisioning behind a managed-checkout synchronization', async () => {
    const id = await seedProject('absent');
    await ctx.store.updateProjectSettings(id, { defaultBranch: 'main' });
    let releaseFirstFetch!: () => void;
    const firstFetchBlocked = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let firstFetchStarted!: () => void;
    const firstFetchRunning = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let fetches = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const git: GitRunner = async (args) => {
      if (args.includes('fetch')) {
        fetches += 1;
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (fetches === 1) {
          firstFetchStarted();
          await firstFetchBlocked;
        }
        activeFetches -= 1;
        return { stdout: '', stderr: '' };
      }
      if (args.includes('reset')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity-dev/',
      git,
      isDirectory: () => true,
    });
    (provisioner as unknown as { isRepoDir: () => boolean }).isRepoDir = () => true;

    const synchronization = provisioner.syncProjectCheckout(id);
    await firstFetchRunning;
    const provisioning = provisioner.provision(id);
    await Promise.resolve();

    expect(fetches).toBe(1);
    releaseFirstFetch();
    await expect(provisioning).resolves.toMatchObject({ state: 'active' });
    await synchronization;
    expect(fetches).toBe(2);
    expect(maxActiveFetches).toBe(1);
  });

  it("transitions to 'failed' with a redacted provision_error message when git clone throws", async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([
      { match: /clone/, reject: true }, // simulate clone failure
    ]);
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });
    await expect(provisioner.provision(id)).rejects.toThrow(/git clone/);
    const row = await ctx.store.getProject(id);
    expect(row?.state).toBe('failed');
    expect(row?.provisionError).toMatch(/git clone/);
    expect(row?.provisionError).not.toContain('tok');
    expect(row?.provisionError).not.toContain('eC1hY2Nlc3MtdG9rZW46dG9r');
  });

  it('lets git follow the remote default branch when none is configured', async () => {
    const id = await seedProject();
    const { runner: git, calls: gitCalls } = fakeGit([{ match: /clone/, reject: true }]);
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });

    await expect(provisioner.provision(id)).rejects.toThrow(/git clone/);
    const cloneCall = gitCalls.find(({ args }) => args.includes('clone'));
    expect(cloneCall?.args).not.toContain('--branch');
  });

  it("transitions to 'failed' with a 'docker' prefix when createContainer raises image_not_found", async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /clone/ }, { match: /set-url/ }]);
    // createContainer throws image_not_found → worker surfaces it.
    const { client: docker } = fakeDocker({
      createContainer: vi.fn(async () => {
        throw new DockerError({ kind: 'image_not_found', image: 'nope', message: 'no such image' });
      }),
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'nope',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });
    await expect(provisioner.provision(id)).rejects.toThrow(/docker image_not_found/);
    const row = await ctx.store.getProject(id);
    expect(row?.state).toBe('failed');
    expect(row?.provisionError).toMatch(/image_not_found/);
  });

  it('pulls the resolved image then retries create when the first create reports image_not_found (ADR 0003 R6 / #299)', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /clone/ }, { match: /set-url/ }]);
    // First create → image_not_found; pull succeeds; second create succeeds.
    let createCalls = 0;
    const pullImage = vi.fn(async (ref: string): Promise<void> => {
      expect(ref).toBe('ghcr.io/heey-global/dev-base:2026.06');
    });
    const { client: docker, calls: dockerCalls } = fakeDocker({
      pullImage,
      createContainer: vi.fn(async (spec: ContainerSpec) => {
        createCalls += 1;
        dockerCalls.push({ method: 'createContainer', payload: spec });
        if (createCalls === 1) {
          throw new DockerError({
            kind: 'image_not_found',
            image: spec.image,
            message: 'No such image',
          });
        }
        return { id: 'cid-after-pull', warnings: [] };
      }),
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });

    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');
    // Pull was called with the resolved image.
    expect(pullImage).toHaveBeenCalledWith('ghcr.io/heey-global/dev-base:2026.06');
    // create was attempted twice (miss → pull → retry), start ran on the retry id.
    expect(createCalls).toBe(2);
    expect(
      dockerCalls.some((c) => c.method === 'startContainer' && c.payload === 'cid-after-pull'),
    ).toBe(true);
  });

  it('surfaces a provision failure when the on-demand pull itself fails', async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /clone/ }, { match: /set-url/ }]);
    const pullImage = vi.fn(async () => {
      throw new DockerError({
        kind: 'image_not_found',
        image: 'ghcr.io/heey-global/dev-base:2026.06',
        message: 'pull access denied',
      });
    });
    const { client: docker } = fakeDocker({
      pullImage,
      createContainer: vi.fn(async (spec: ContainerSpec) => {
        throw new DockerError({
          kind: 'image_not_found',
          image: spec.image,
          message: 'No such image',
        });
      }),
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'ghcr.io/heey-global/dev-base:2026.06',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });

    await expect(provisioner.provision(id)).rejects.toThrow(/docker.*image_not_found/);
    expect(pullImage).toHaveBeenCalledOnce();
    const row = await ctx.store.getProject(id);
    expect(row?.state).toBe('failed');
    expect(row?.provisionError).toMatch(/image_not_found/);
  });

  it("resolves a 409 'name taken' from createContainer by inspecting the existing container and starting it", async () => {
    const id = await seedProject();
    const { runner: git } = fakeGit([{ match: /clone/ }, { match: /set-url/ }]);
    // createContainer throws conflict (e.g. a deprovision-keep left the
    // container OR a sticky Verity restart). Worker inspects + starts.
    const inspectMock = vi.fn(async (cid: string) => {
      expect(cid).toBe('dev-example-org-example-repo');
      return { id: 'existing-cid', running: false };
    });
    const startMock = vi.fn(async (cid: string) => {
      expect(cid).toBe('existing-cid');
    });
    const { client: docker } = fakeDocker({
      createContainer: vi.fn(async () => {
        throw new DockerError({ kind: 'conflict', message: 'name already in use' });
      }),
      inspectContainer: inspectMock,
      startContainer: startMock,
    });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git,
      isDirectory: () => false,
    });
    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');
    expect(inspectMock).toHaveBeenCalledWith('dev-example-org-example-repo');
    expect(startMock).toHaveBeenCalledWith('existing-cid');
  });

  it('reuses an active sandbox only after confirming its relay-era topology', async () => {
    const id = await seedProject('active');
    const inspectMock = vi.fn(async () => ({
      id: 'existing-cid',
      running: true,
      labels: {
        [PROJECT_ID_LABEL]: id,
        [CONTAINER_GENERATION_LABEL]: 'generation-1',
      },
      networks: { [projectNetworkName(id)]: {} },
    }));
    const { client: docker } = fakeDocker({ inspectContainer: inspectMock });
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git: async () => ({ stdout: '', stderr: '' }),
      isDirectory: () => false,
    });
    const result = await provisioner.provision(id);
    expect(result.state).toBe('active');
    expect(inspectMock).toHaveBeenCalledWith('dev-example-org-example-repo');
  });

  it('throws if the project row vanishes mid-lock (deprovision race)', async () => {
    const id = randomUUID(); // NOT seeded — getProject returns undefined
    const { client: docker } = fakeDocker();
    const provisioner = createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/data/dev',
      git: async () => ({ stdout: '', stderr: '' }),
      isDirectory: () => false,
    });
    await expect(provisioner.provision(id)).rejects.toThrow(/deprovision race/);
  });
});

describe('devcontainerContentHash / devcontainerImageTag (ADR 0003 R3.1)', () => {
  it('is stable for identical content + base, changes when either changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-hash-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{ "image": "node:24" }');
      const h1 = devcontainerContentHash(dir, 'base:1');
      const h2 = devcontainerContentHash(dir, 'base:1');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(12);
      // Different base image ref → different hash (base rollout invalidation).
      expect(devcontainerContentHash(dir, 'base:2')).not.toBe(h1);
      // Edited devcontainer content → different hash.
      writeFileSync(join(dir, 'devcontainer.json'), '{ "image": "node:22" }');
      expect(devcontainerContentHash(dir, 'base:1')).not.toBe(h1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to follow a symlink in the untrusted clone (M10)', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-hash-symlink-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{}');
      // A malicious repo aliases a file to a host-side path.
      writeFileSync(join(root, 'host-secret'), 'sensitive');
      symlinkSync(join(root, 'host-secret'), join(dir, 'leak'));
      expect(() => devcontainerContentHash(dir, 'base:1')).toThrow(/refusing to follow a symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hashes nested files (referenced Dockerfile / scripts), not just the top level', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-hash-nested-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{}');
      writeFileSync(join(dir, 'sub', 'Dockerfile'), 'FROM base:1');
      const h1 = devcontainerContentHash(dir, 'base:1');
      writeFileSync(join(dir, 'sub', 'Dockerfile'), 'FROM base:2');
      expect(devcontainerContentHash(dir, 'base:1')).not.toBe(h1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a valid, lowercased docker tag from owner/repo + hash', () => {
    expect(devcontainerImageTag('Heey-Global', 'Deep_OCR', 'abcdef123456')).toBe(
      'verity-devc-heey-global-deep_ocr:abcdef123456',
    );
    // Non-tag-safe chars in the slug are replaced with `-`.
    expect(devcontainerImageTag('a/b', 'c d', 'deadbeef0000')).toBe(
      'verity-devc-a-b-c-d:deadbeef0000',
    );
  });

  // The app mirrors this literal (packages/mobile/src/ui/devcontainerImage.ts) to
  // decide whether a project has a build of its own to redo, and cannot import it
  // across the package boundary. Changing the scheme without changing the mirror
  // would silently hide the "Rebuild image" action for every project, so pin it.
  it('keeps the tag prefix the app and the GC both match on', () => {
    expect(DEVCONTAINER_IMAGE_PREFIX).toBe('verity-devc-');
    expect(devcontainerImageTag('acme', 'web', 'abcdef123456')).toMatch(
      new RegExp(`^${DEVCONTAINER_IMAGE_PREFIX}`, 'u'),
    );
  });

  it('mixes the bundled Feature identity in — an identity change invalidates the tag (R3.1/#299)', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-feat-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{ "image": "node:24" }');

      const noFeature = devcontainerContentHash(dir, 'base:1');
      const withV1 = devcontainerContentHash(dir, 'base:1', 'sha256:toolkit-v1');
      const withV2 = devcontainerContentHash(dir, 'base:1', 'sha256:toolkit-v2');

      // A feature identity present → different tag than none.
      expect(withV1).not.toBe(noFeature);
      // Two different feature identities → different tags (content changes force rebuild).
      expect(withV1).not.toBe(withV2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is byte-identical to the pre-Feature hash when no feature version is provided (dormant back-compat)', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-feat-absent-'));
    try {
      const dir = join(root, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{ "image": "node:24" }');

      // Absent third arg, and an explicit `undefined`, both equal the two-arg form.
      const twoArg = devcontainerContentHash(dir, 'base:1');
      expect(devcontainerContentHash(dir, 'base:1', undefined)).toBe(twoArg);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('devcontainerBuildArgs (R3.1/#299)', () => {
  it('omits --additional-features entirely when no feature ref is present', () => {
    expect(devcontainerBuildArgs({ workspaceFolder: '/work', imageName: 'tag:1' })).toEqual([
      'build',
      '--workspace-folder',
      '/work',
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
    ).toEqual(['build', '--workspace-folder', '/work', '--image-name', 'tag:1', '--no-cache']);
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
      'ghcr.io/devcontainers/features/node:1': { version: '24' },
      '/opt/verity-features/verity-sandbox-toolkit': { installRunnerSupervisor: true },
    });
  });
});

describe('devcontainerLifecyclePath', () => {
  it('includes remote user local bins for lifecycle commands', () => {
    expect(devcontainerLifecyclePath('vscode')).toMatch(/^\/home\/vscode\/\.local\/bin:/);
    expect(devcontainerLifecyclePath('node')).toMatch(/^\/home\/node\/\.local\/bin:/);
    expect(devcontainerLifecyclePath('root')).toMatch(/^\/root\/\.local\/bin:/);
  });

  it('falls back to the base path for unsupported user forms', () => {
    expect(devcontainerLifecyclePath(undefined)).toBe(
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    expect(devcontainerLifecyclePath('1000:1000')).toBe(
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
  });
});

describe('devcontainerLifecycleCommand', () => {
  it('exports the lifecycle PATH and clears Verity hook overrides before the project command', () => {
    expect(devcontainerLifecycleCommand('vscode', 'pre-commit install')).toBe(
      'PATH=/home/vscode/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; git config --global --unset-all core.hooksPath 2>/dev/null || true; git config --local --unset-all core.hooksPath 2>/dev/null || true; pre-commit install',
    );
  });
});

describe('ProvisionerImpl resolve-or-build devcontainer image (ADR 0003 R3.1)', () => {
  const baseInput = {
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-example-org-example-repo',
    state: 'container_starting' as const,
  };
  const toolkitFeature = {
    ref: '/opt/verity-features/verity-sandbox-toolkit',
    version: '1.0.0',
    identity: 'sha256:toolkit-v1',
  };

  /** Seed a project already in `container_starting` so `provision` jumps
   *  straight into the container phase (skipping the clone) — the resolve-or-
   *  build step lives there. */
  async function seedProject() {
    const id = randomUUID();
    await ctx.store.upsertProject({ id, ...baseInput });
    return id;
  }

  /** A temp clone root with `<root>/example-org-example-repo/` optionally holding a
   *  `.devcontainer/`. Returns the root + clone path for assertions/cleanup. */
  function makeCloneRoot(withDevcontainer: boolean): { root: string; clonePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'verity-devc-clone-'));
    const clonePath = join(root, 'example-org-example-repo');
    mkdirSync(clonePath, { recursive: true });
    if (withDevcontainer) {
      const dir = join(clonePath, '.devcontainer');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'devcontainer.json'), '{ "image": "node:24-bookworm" }');
    }
    return { root, clonePath };
  }

  it('(a) no .devcontainer/ → runs the base image, no build spawned', async () => {
    const { root } = makeCloneRoot(false);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        claudeConfigVolume: 'claude-config-verity',
        codexConfigVolume: 'codex-config-verity',
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      const result = await provisioner.provision(id);
      expect(result.state).toBe('active');
      expect(build).not.toHaveBeenCalled();
      expect(imageExists).not.toHaveBeenCalled();
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      expect((created?.payload as ContainerSpec).image).toBe(
        'ghcr.io/heey-global/dev-base:default',
      );
      expect((created?.payload as ContainerSpec).entrypoint).toBeUndefined();
      expect((created?.payload as ContainerSpec).command).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(b) .devcontainer/ present + image absent → builds derived tag, runs it', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: 'built', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        claudeConfigVolume: 'claude-config-verity',
        codexConfigVolume: 'codex-config-verity',
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        // ghcr auth: the provisioner mints a token and hands it to the build so it
        // can resolve the private toolkit Feature as the App.
        registryTokenMint: () => Promise.resolve('ghs-registry-token'),
      });

      const result = await provisioner.provision(id);
      expect(result.state).toBe('active');

      const expectedHash = devcontainerContentHash(
        join(clonePath, '.devcontainer'),
        'ghcr.io/heey-global/dev-base:default',
        `ghcr.io/devcontainers/features/node:1:${JSON.stringify({ version: '24' })}\n${toolkitFeature.identity}:${JSON.stringify({ installRunnerSupervisor: true })}`,
      );
      const expectedTag = devcontainerImageTag('example-org', 'example-repo', expectedHash);
      expect(imageExists).toHaveBeenCalledWith(expectedTag);
      expect(build).toHaveBeenCalledWith({
        workspaceFolder: clonePath,
        imageName: expectedTag,
        dockerHost: 'unix:///var/run/docker.sock',
        additionalFeatures: toolkitFeature.ref,
        registryToken: 'ghs-registry-token',
      });
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.image).toBe(expectedTag);
      // No gh-token file is mounted (broker-only); no capability either without the
      // broker wired in this test.
      expect((spec.binds ?? []).some((b) => b.includes('.gh-token'))).toBe(false);
      expect((spec.binds ?? []).some((b) => b.includes('/run/verity/gh-token'))).toBe(false);
      expect(spec.binds).not.toContain('claude-config-verity:/run/verity/claude');
      expect(spec.binds).not.toContain('codex-config-verity:/run/verity/codex');
      expect(spec.binds).toContain('/opt/agent-seed:/opt/agent-seed:ro');
      expect(spec.env).toEqual(
        expect.arrayContaining([
          'CLAUDE_CONFIG_DIR=/run/verity/claude',
          'CODEX_HOME=/run/verity/codex',
          'XDG_CONFIG_HOME=/run/verity/xdg',
          'PI_CONFIG_DIR=/run/verity/pi',
        ]),
      );
      expect((spec.env ?? []).some((e) => e.startsWith('VERITY_GH_TOKEN_FILE='))).toBe(false);
      expect(spec.entrypoint).toEqual(['/bin/sh', '-lc']);
      expect(spec.command).toEqual([
        'if [ -x /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh ]; then VERITY_AGENT_RUN_FOREGROUND=1 exec /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh; fi; exec verity-agent-run',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(c) .devcontainer/ present + image already exists → cache hit, NO build', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => true);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      await provisioner.provision(id);
      expect(build).not.toHaveBeenCalled();

      const expectedHash = devcontainerContentHash(
        join(clonePath, '.devcontainer'),
        'ghcr.io/heey-global/dev-base:default',
        `ghcr.io/devcontainers/features/node:1:${JSON.stringify({ version: '24' })}\n${toolkitFeature.identity}:${JSON.stringify({ installRunnerSupervisor: true })}`,
      );
      const expectedTag = devcontainerImageTag('example-org', 'example-repo', expectedHash);
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.image).toBe(expectedTag);
      expect(spec.entrypoint).toEqual(['/bin/sh', '-lc']);
      expect(spec.command).toEqual([
        'if [ -x /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh ]; then VERITY_AGENT_RUN_FOREGROUND=1 exec /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh; fi; exec verity-agent-run',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(d) editing the .devcontainer/ content → different tag → rebuild', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      // First provision builds tag T1.
      const buildCalls: string[] = [];
      const build = vi.fn<DevcontainerBuildSpawner>(async ({ imageName }) => {
        buildCalls.push(imageName);
        return { stdout: '', stderr: '' };
      });
      // Cache always misses so every distinct devcontainer forces a build.
      const imageExists = vi.fn(async () => false);
      const { client: docker } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      // Same project (owner/repo is unique-keyed) re-provisioned twice: first
      // build, then edit the devcontainer + reset the row so the container phase
      // re-runs — the derived tag must differ, forcing a second build.
      const id = await seedProject();
      await provisioner.provision(id);

      // Edit the devcontainer → the derived tag must change.
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:22-bookworm" }',
      );
      await ctx.store.updateProjectState(id, 'container_starting');
      await provisioner.provision(id);

      expect(buildCalls).toHaveLength(2);
      expect(buildCalls[0]).not.toBe(buildCalls[1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(e) build non-zero exit → state=failed with the build stderr surfaced', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => {
        const err = new Error('Command failed: devcontainer build');
        (err as Error & { stderr?: string }).stderr =
          'ERROR: failed to solve: process "/bin/sh -c apt-get install nonexistent" exited 100';
        throw err;
      });
      const imageExists = vi.fn(async () => false);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: fakeDocker({ imageExists }).client,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toMatch(/devcontainer build failed/);
      expect(row?.provisionError).toMatch(/exited 100/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(f) build stderr echoing a token is redacted out of the failed provision_error', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const secret = 'build-token-fixture-value';
      const build = vi.fn<DevcontainerBuildSpawner>(async () => {
        const err = new Error('Command failed: devcontainer build');
        // A verbose build can echo an env token into stderr; it must not survive
        // into the operator-visible provision_error.
        (err as Error & { stderr?: string }).stderr = `fatal: leaked ${secret} while cloning`;
        throw err;
      });
      const imageExists = vi.fn(async () => false);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: fakeDocker({ imageExists }).client,
        token: secret,
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).not.toContain(secret);
      expect(row?.provisionError).toContain('[redacted]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the base image when .devcontainer/ exists but the build seam is unwired', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        // devcontainerBuild + dockerHostForBuild intentionally omitted.
      });

      const result = await provisioner.provision(id);
      expect(result.state).toBe('active');
      expect(imageExists).not.toHaveBeenCalled();
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      expect((created?.payload as ContainerSpec).image).toBe(
        'ghcr.io/heey-global/dev-base:default',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when .devcontainer/ exists but the toolkit Feature ref is unavailable', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toMatch(/verity-sandbox-toolkit devcontainer Feature ref/);
      expect(build).not.toHaveBeenCalled();
      expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors supported devcontainer remoteUser and postCreateCommand settings', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "vscode", "postCreateCommand": "pandoc --version >/dev/null" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const commandCalls: Array<Parameters<ContainerCommandRunner>[0]> = [];
      const command = vi.fn<ContainerCommandRunner>(async (args) => {
        commandCalls.push(args);
        return { stdout: '', stderr: '' };
      });
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      const result = await provisioner.provision(id);

      expect(result.state).toBe('active');
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.user).toBe('vscode');
      expect(spec.command?.[0]).toContain('while [ ! -f /tmp/verity-post-create-complete ]');
      expect(command).toHaveBeenCalledTimes(2);
      // No runtime Verity secret/capability files are mounted in this fixture, so
      // there is no remoteUser readiness probe.
      expect(commandCalls[1]).toEqual({
        containerName: 'dev-example-org-example-repo',
        command: 'touch /tmp/verity-post-create-complete',
        dockerHost: 'unix:///var/run/docker.sock',
        user: 'vscode',
        workdir: '/work',
      });
      expect(commandCalls[0]).toEqual({
        containerName: 'dev-example-org-example-repo',
        command: 'pandoc --version >/dev/null',
        dockerHost: 'unix:///var/run/docker.sock',
        user: 'vscode',
        workdir: '/work',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds the gh-token capability to the devcontainer readiness probe when the broker is wired', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-ghcap-probe-'));
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "vscode" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const commandCalls: Array<Parameters<ContainerCommandRunner>[0]> = [];
      const command = vi.fn<ContainerCommandRunner>(async (args) => {
        commandCalls.push(args);
        return { stdout: '', stderr: '' };
      });
      const { client: docker } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        gitSecretRoot: secretRoot,
        ghTokenCapabilities: createGhTokenCapabilityRegistry(ctx.db),
        projectTokenMint: async () => 'server-side-token',
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      const result = await provisioner.provision(id);

      expect(result.state).toBe('active');
      // A capability WAS issued + mounted, so the readiness probe verifies it.
      // This fixture has no signing public key bind, so it must not require one.
      expect(commandCalls[0]).toEqual({
        containerName: 'dev-example-org-example-repo',
        command: 'test -r /run/verity/gh-token-capability',
        dockerHost: 'unix:///var/run/docker.sock',
        user: 'vscode',
        workdir: '/work',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('tolerates devcontainer UI/workspace fields and translates safe workspace volume mounts', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        `{
          "image": "node:24-bookworm",
          "remoteUser": "node",
          "workspaceFolder": "/workspaces/cl-saikandi-website",
          "forwardPorts": [3000],
          "appPort": [3000],
          "portsAttributes": {
            "3000": { "label": "Next.js dev server", "onAutoForward": "notify" }
          },
          "mounts": [
            "source=cl-saikandi-node-modules,target=\${containerWorkspaceFolder}/node_modules,type=volume"
          ],
          "postCreateCommand": "sudo chown node:node node_modules && npm ci"
        }`,
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' }));
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      const result = await provisioner.provision(id);

      expect(result.state).toBe('active');
      expect(result.provisionError).toBeNull();
      expect(build).toHaveBeenCalledTimes(1);
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.user).toBe('node');
      expect(spec.binds).toContain('cl-saikandi-node-modules:/work/node_modules');
      expect(spec.binds).toContain(`${clonePath}:/work`);
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'sudo chown node:node node_modules && npm ci',
          user: 'node',
          workdir: '/work',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates devcontainer compose build metadata while Verity owns runtime start', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        `{
          "dockerComposeFile": "docker-compose.yml",
          "service": "app",
          "workspaceFolder": "/workspace",
          "remoteUser": "node",
          "postCreateCommand": "npm install",
          "postStartCommand": "echo ready"
        }`,
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' }));
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      const result = await provisioner.provision(id);

      expect(result.state).toBe('active');
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceFolder: clonePath,
        }),
      );
      const spec = dockerCalls.find((c) => c.method === 'createContainer')
        ?.payload as ContainerSpec;
      expect(spec.user).toBe('node');
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npm install',
          workdir: '/work',
        }),
      );
      expect(command).not.toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'echo ready',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires confirmation for root remoteUser and persists a warning after confirmed provision', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "root", "postCreateCommand": "true" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async () => ({ stdout: '', stderr: '' }));
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      await expect(provisioner.provision(id)).rejects.toMatchObject({
        name: 'ProvisioningWarning',
        warnings: [expect.stringContaining('remoteUser=root')],
      });
      expect(build).not.toHaveBeenCalled();
      expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();

      const result = await provisioner.recreateContainer(id, { confirmWarnings: true });

      expect(result.state).toBe('active');
      expect(result.provisionWarning).toContain('remoteUser=root');
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      const spec = created?.payload as ContainerSpec;
      expect(spec.user).toBe('root');
      expect(spec.command?.[0]).toContain('while [ ! -f /tmp/verity-post-create-complete ]');
      expect(command).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails and removes the container when remoteUser cannot read Verity secrets', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    const secretRoot = mkdtempSync(join(tmpdir(), 'verity-remote-secret-fail-'));
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "app", "postCreateCommand": "true" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async ({ command: cmd }) => {
        if (cmd.startsWith('test -r /run/verity/')) throw new Error('permission denied');
        return { stdout: '', stderr: '' };
      });
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        gitSecretRoot: secretRoot,
        ghTokenCapabilities: createGhTokenCapabilityRegistry(ctx.db),
        projectTokenMint: async () => 'server-side-token',
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(
        /remoteUser secret access check failed/,
      );
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toMatch(/remoteUser secret access check failed/);
      expect(command).toHaveBeenCalledOnce();
      expect(dockerCalls.map((call) => call.method)).toEqual(
        expect.arrayContaining(['startContainer', 'stopContainer', 'removeContainer']),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('fails the provision when a supported postCreateCommand fails', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "postCreateCommand": "exit 42" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async () => {
        const error = new Error('post-create boom');
        (error as Error & { stdout: string }).stdout = 'post-create stdout';
        (error as Error & { stderr: string }).stderr = `${'x'.repeat(900)}real post-create stderr`;
        throw error;
      });
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/postCreateCommand failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toContain('post-create stdout');
      expect(row?.provisionError).toContain('real post-create stderr');
      expect(row?.provisionError).not.toContain('post-create boom');
      expect(dockerCalls.map((call) => call.method)).toEqual(
        expect.arrayContaining(['startContainer', 'stopContainer', 'removeContainer']),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces the failure tail + a no-new-privileges hint when postCreate uses sudo', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "postCreateCommand": ".devcontainer/post-create.sh" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const command = vi.fn<ContainerCommandRunner>(async () => {
        const error = new Error('Command failed: .devcontainer/post-create.sh');
        // A long successful install log (stdout) precedes the one fatal line
        // (stderr) — the raw output leads with noise; the tail carries the cause.
        (error as Error & { stdout: string }).stdout = [
          'EARLY_NOISE_MARKER',
          ...Array.from({ length: 30 }, (_, i) => `Successfully installed package-${i}`),
        ].join('\n');
        (error as Error & { stderr: string }).stderr = [
          'Installing just...',
          'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.',
          'curl: (23) Failed writing body',
        ].join('\n');
        throw error;
      });
      const { client: docker } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
        containerCommand: command,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/postCreateCommand failed/);
      const row = await ctx.store.getProject(id);
      const err = row?.provisionError ?? '';
      // Actionable hint is surfaced...
      expect(err).toContain('VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION');
      expect(err).toContain('~/.local/bin');
      // ...along with the real failing line...
      expect(err).toContain('sudo: The "no new privileges" flag is set');
      // ...and the early install-log noise is trimmed out (tail only).
      expect(err).not.toContain('EARLY_NOISE_MARKER');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed instead of translating unsafe devcontainer mounts', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        `{
          "image": "node:24-bookworm",
          "mounts": [
            "source=/var/run/docker.sock,target=\${containerWorkspaceFolder}/docker.sock,type=bind"
          ]
        }`,
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toMatch(/unsupported devcontainer runtime settings: mounts/);
      expect(build).not.toHaveBeenCalled();
      expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['postCreateCommand (array)', '"postCreateCommand": ["npm", "install"]'],
    ['postCreateCommand (object)', '"postCreateCommand": { "onCreate": "npm install" }'],
    ['postCreateCommand (boolean)', '"postCreateCommand": true'],
    ['postCreateCommand (null)', '"postCreateCommand": null'],
    ['remoteUser (number)', '"remoteUser": 1000'],
  ])(
    'fails closed instead of ignoring non-string devcontainer lifecycle setting %s',
    async (label, setting) => {
      const { root, clonePath } = makeCloneRoot(true);
      try {
        writeFileSync(
          join(clonePath, '.devcontainer', 'devcontainer.json'),
          `{
          // JSONC comments are common in devcontainer.json and must not hide invalid values.
          "image": "node:24-bookworm",
          ${setting}
        }`,
        );
        const id = await seedProject();
        const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
        const imageExists = vi.fn(async () => false);
        const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
        const provisioner = createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker,
          token: 'tok',
          defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
          ghTokenFilePath: '/etc/gh-token',
          hostCloneRoot: root,
          devcontainerBuild: build,
          dockerHostForBuild: 'unix:///var/run/docker.sock',
          devcontainerFeature: toolkitFeature,
        });

        await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
        const row = await ctx.store.getProject(id);
        expect(row?.provisionError).toContain(label);
        expect(build).not.toHaveBeenCalled();
        expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('fails closed instead of ignoring unsupported devcontainer runtime settings', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        '{ "image": "node:24-bookworm", "remoteUser": "node", "runArgs": ["--init"], "runServices": ["db"], "privileged": true, "postCreateCommand": "npm install" }',
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      await expect(provisioner.provision(id)).rejects.toThrow(/devcontainer build failed/);
      const row = await ctx.store.getProject(id);
      expect(row?.state).toBe('failed');
      expect(row?.provisionError).toMatch(/unsupported devcontainer runtime settings/);
      expect(row?.provisionError).not.toMatch(/remoteUser/);
      expect(row?.provisionError).toMatch(/runArgs/);
      expect(row?.provisionError).toMatch(/runServices/);
      expect(row?.provisionError).toMatch(/privileged/);
      expect(row?.provisionError).not.toMatch(/postCreateCommand/);
      expect(build).not.toHaveBeenCalled();
      expect(dockerCalls.find((c) => c.method === 'createContainer')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat commented runtime keys or string values as unsupported settings', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      writeFileSync(
        join(clonePath, '.devcontainer', 'devcontainer.json'),
        `{
          // "remoteUser": "node",
          "image": "node:24-bookworm",
          "note": "literal \\"runArgs\\": should not be treated as a key",
          "customizations": {
            "verity": {
              "remoteUser": "nested values are not top-level runtime settings"
            }
          }
        }`,
      );
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker: fakeDocker({ imageExists }).client,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: toolkitFeature,
      });

      const result = await provisioner.provision(id);

      expect(result.state).toBe('active');
      expect(build).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(g) with the seam wired + a bundled Feature → passes the feature identity to the hash + ref to the spawner', async () => {
    const { root, clonePath } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const feature = {
        ref: '/opt/verity-features/verity-sandbox-toolkit',
        version: '1.0.0',
        identity: 'sha256:toolkit-v1',
      };
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        devcontainerBuild: build,
        dockerHostForBuild: 'unix:///var/run/docker.sock',
        devcontainerFeature: feature,
      });

      await provisioner.provision(id);

      // The tag must be derived WITH the feature content identity mixed in.
      const expectedHash = devcontainerContentHash(
        join(clonePath, '.devcontainer'),
        'ghcr.io/heey-global/dev-base:default',
        `ghcr.io/devcontainers/features/node:1:${JSON.stringify({ version: '24' })}\n${feature.identity}:${JSON.stringify({ installRunnerSupervisor: true })}`,
      );
      const expectedTag = devcontainerImageTag('example-org', 'example-repo', expectedHash);
      expect(imageExists).toHaveBeenCalledWith(expectedTag);
      expect(build).toHaveBeenCalledWith({
        workspaceFolder: clonePath,
        imageName: expectedTag,
        dockerHost: 'unix:///var/run/docker.sock',
        additionalFeatures: feature.ref,
      });
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      expect((created?.payload as ContainerSpec).image).toBe(expectedTag);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(h) a Feature identity change produces a different derived tag → rebuild', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const buildCalls: string[] = [];
      const build = vi.fn<DevcontainerBuildSpawner>(async ({ imageName }) => {
        buildCalls.push(imageName);
        return { stdout: '', stderr: '' };
      });
      const imageExists = vi.fn(async () => false);
      const id = await seedProject();

      const makeProvisioner = (identity: string) =>
        createProvisioner({
          store: ctx.store,
          db: ctx.db,
          docker: fakeDocker({ imageExists }).client,
          token: 'tok',
          defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
          ghTokenFilePath: '/etc/gh-token',
          hostCloneRoot: root,
          devcontainerBuild: build,
          dockerHostForBuild: 'unix:///var/run/docker.sock',
          devcontainerFeature: {
            ref: '/opt/verity-features/verity-sandbox-toolkit',
            version: '1.0.0',
            identity,
          },
        });

      await makeProvisioner('sha256:toolkit-before').provision(id);
      await ctx.store.updateProjectState(id, 'container_starting');
      await makeProvisioner('sha256:toolkit-after').provision(id);

      expect(buildCalls).toHaveLength(2);
      // Only the Feature identity changed; the derived tag must still differ.
      expect(buildCalls[0]).not.toBe(buildCalls[1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('(i) DORMANCY: with the build seam UNWIRED, a .devcontainer/ project runs the base image and never builds — even when a Feature IS set', async () => {
    const { root } = makeCloneRoot(true);
    try {
      const id = await seedProject();
      const build = vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' }));
      const imageExists = vi.fn(async () => false);
      const { client: docker, calls: dockerCalls } = fakeDocker({ imageExists });
      const provisioner = createProvisioner({
        store: ctx.store,
        db: ctx.db,
        docker,
        token: 'tok',
        defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
        ghTokenFilePath: '/etc/gh-token',
        hostCloneRoot: root,
        // Build seam intentionally UNWIRED (as embedded.ts leaves it) …
        // devcontainerBuild + dockerHostForBuild omitted …
        // … but the Feature data IS present (as embedded.ts DOES set it).
        devcontainerFeature: {
          ref: '/opt/verity-features/verity-sandbox-toolkit',
          version: '1.0.0',
          identity: 'sha256:toolkit-v1',
        },
      });

      const result = await provisioner.provision(id);
      expect(result.state).toBe('active');
      expect(build).not.toHaveBeenCalled();
      expect(imageExists).not.toHaveBeenCalled();
      const created = dockerCalls.find((c) => c.method === 'createContainer');
      expect((created?.payload as ContainerSpec).image).toBe(
        'ghcr.io/heey-global/dev-base:default',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DeprovisionerImpl (#174)', () => {
  const baseInput = {
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-example-org-example-repo',
    state: 'active' as const,
  };

  async function seedProject(
    stateOverride: 'absent' | 'active' | 'cloning' | 'container_starting' | 'failed' = 'active',
  ) {
    const id = randomUUID();
    await ctx.store.upsertProject({ id, ...baseInput, state: stateOverride });
    return id;
  }

  it('revokes public previews before mutating the project container', async () => {
    const id = await seedProject();
    const order: string[] = [];
    const { client: docker } = fakeDocker({
      stopContainer: vi.fn(async () => {
        order.push('docker-stop');
      }),
      removeContainer: vi.fn(async () => {
        order.push('docker-remove');
      }),
    });
    const withTeardown = vi.fn(
      async (_project: ProjectRecord, mutation: () => Promise<ProjectRecord>) => {
        order.push('preview-stop');
        return mutation();
      },
    );
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      withTeardown,
    );
    await deprovisioner.deprovision(id, { purge: false });
    expect(withTeardown).toHaveBeenCalledOnce();
    expect(order).toEqual(['preview-stop', 'docker-stop', 'docker-remove']);
  });

  it('default (no purge) leaves the bind-mount clone intact + state → absent', async () => {
    const id = await seedProject();
    const isDirCalls: string[] = [];
    const isDir = (p: string): boolean => {
      isDirCalls.push(p);
      return p === '/data/dev/example-org-example-repo'; // pretends real fs
    };
    const rmCalls: string[] = [];
    const removeDir = (p: string): void => {
      rmCalls.push(p);
    };
    const stopMock = vi.fn();
    const removeMock = vi.fn();
    const { client: docker } = fakeDocker({ stopContainer: stopMock, removeContainer: removeMock });
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      isDir,
      removeDir,
    );

    const result = await deprovisioner.deprovision(id, { purge: false });
    expect(result.state).toBe('absent');
    expect(stopMock).toHaveBeenCalledWith('dev-example-org-example-repo');
    expect(removeMock).toHaveBeenCalledWith('dev-example-org-example-repo');
    // no purge → isDir not even probed (the if-branch short-circuits).
    expect(isDirCalls).toHaveLength(0);
    expect(rmCalls).toEqual([]);
  });

  it('runs docker teardown OUTSIDE the FOR UPDATE lock (hang-safety regression)', async () => {
    const id = await seedProject();
    const events: string[] = [];
    const stopMock = vi.fn(async () => {
      events.push('stop');
    });
    const removeMock = vi.fn(async () => {
      events.push('remove');
    });
    const { client: docker } = fakeDocker({ stopContainer: stopMock, removeContainer: removeMock });
    const origTransaction = ctx.db.transaction.bind(ctx.db);
    const txSpy = vi.spyOn(ctx.db, 'transaction').mockImplementation(() => {
      events.push('lock');
      return origTransaction();
    });
    try {
      const deprovisioner = new DeprovisionerImpl(ctx.store, ctx.db, docker, '/data/dev');
      const result = await deprovisioner.deprovision(id, { purge: false });
      expect(result.state).toBe('absent');
      // The teardown must run BEFORE the row-lock transaction opens — otherwise a
      // stuck docker stop/remove pins the projects-row lock `idle in transaction`,
      // exhausting the DB pool and hanging reads like /onboarding/status.
      expect(events).toContain('lock');
      expect(events.indexOf('stop')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('stop')).toBeLessThan(events.indexOf('lock'));
      expect(events.indexOf('remove')).toBeLessThan(events.indexOf('lock'));
    } finally {
      txSpy.mockRestore();
    }
  });

  it('updates absent state through the locked transaction, not the outer store connection', async () => {
    const id = await seedProject();
    const { client: docker } = fakeDocker();
    const updateSpy = vi.spyOn(ctx.store, 'updateProjectState');
    const deprovisioner = new DeprovisionerImpl(ctx.store, ctx.db, docker, '/data/dev');

    const result = await deprovisioner.deprovision(id, { purge: false });

    expect(result.state).toBe('absent');
    expect(updateSpy).not.toHaveBeenCalled();
    expect((await ctx.store.getProject(id))?.state).toBe('absent');
  });

  it('revokes the project Claude-egress client cert on deprovision', async () => {
    const id = await seedProject();
    const { client: docker } = fakeDocker();
    const { service, revoked } = fakeEgressIdentity();
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    await deprovisioner.deprovision(id, { purge: false });

    expect(revoked).toEqual([id]);
  });

  it('purge=true removes the bind-mount clone path', async () => {
    const id = await seedProject();
    const isDirCalls: string[] = [];
    const isDir = (p: string): boolean => {
      isDirCalls.push(p);
      return true;
    };
    const rmCalls: string[] = [];
    const removeDir = (p: string): void => {
      rmCalls.push(p);
    };
    const stopMock = vi.fn();
    const removeMock = vi.fn();
    const { client: docker } = fakeDocker({ stopContainer: stopMock, removeContainer: removeMock });
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      isDir,
      removeDir,
      undefined,
      '/srv/verity/runners',
    );

    await deprovisioner.deprovision(id, { purge: true });
    expect(rmCalls).toEqual(['/data/dev/example-org-example-repo', `/srv/verity/runners/${id}`]);
    expect(isDirCalls).toEqual(['/data/dev/example-org-example-repo', `/srv/verity/runners/${id}`]);
  });

  it('purge=true honors a clone directory pinned before GitHub linking', async () => {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      ...baseInput,
      cloneDir: '__local__-my-project',
      state: 'active',
    });
    const rmCalls: string[] = [];
    const { client: docker } = fakeDocker();
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      () => true,
      (path) => rmCalls.push(path),
    );

    await deprovisioner.deprovision(id, { purge: true });

    expect(rmCalls).toEqual(['/data/dev/__local__-my-project']);
  });

  it('purge=true with the default filesystem probe leaves a missing clone alone', async () => {
    const id = await seedProject();
    const root = mkdtempSync(join(tmpdir(), 'verity-deprovision-missing-clone-'));
    try {
      const rmCalls: string[] = [];
      const removeDir = (p: string): void => {
        rmCalls.push(p);
      };
      const { client: docker } = fakeDocker();
      const deprovisioner = new DeprovisionerImpl(
        ctx.store,
        ctx.db,
        docker,
        root,
        undefined,
        removeDir,
      );

      const result = await deprovisioner.deprovision(id, { purge: true });

      expect(result.state).toBe('absent');
      expect(rmCalls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('swallows container_not_found from stop/remove (idempotent deprovision after container was already GCed)', async () => {
    const id = await seedProject('container_starting');
    const isDir = (): boolean => false;
    const removeDir = (): void => undefined;
    const stopMock = vi.fn(async () => {
      throw new DockerError({ kind: 'container_not_found', id: 'dev-…' });
    });
    const removeMock = vi.fn(async () => {
      throw new DockerError({ kind: 'container_not_found', id: 'dev-…' });
    });
    const { client: docker } = fakeDocker({ stopContainer: stopMock, removeContainer: removeMock });
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      isDir,
      removeDir,
    );

    const result = await deprovisioner.deprovision(id, { purge: false });
    expect(result.state).toBe('absent');
  });

  it('swallows non-404 Docker teardown errors and still marks the project absent', async () => {
    const id = await seedProject('active');
    const stopMock = vi.fn(async () => {
      throw new Error('daemon unavailable during stop');
    });
    const removeMock = vi.fn(async () => {
      throw new Error('daemon unavailable during remove');
    });
    const { client: docker } = fakeDocker({ stopContainer: stopMock, removeContainer: removeMock });
    const deprovisioner = new DeprovisionerImpl(ctx.store, ctx.db, docker, '/data/dev');

    const result = await deprovisioner.deprovision(id, { purge: false });

    expect(result.state).toBe('absent');
    expect(stopMock).toHaveBeenCalledOnce();
    expect(removeMock).toHaveBeenCalledOnce();
  });

  it('rejects with ProvisioningError when project row vanishes mid-deprovision', async () => {
    const id = randomUUID(); // NOT seeded
    const { client: docker } = fakeDocker();
    const deprovisioner = new DeprovisionerImpl(ctx.store, ctx.db, docker, '/data/dev');
    await expect(deprovisioner.deprovision(id, { purge: false })).rejects.toThrow(
      ProvisioningError,
    );
  });

  it('revokes the project token-broker capability on deprovision', async () => {
    const id = await seedProject('active');
    const project = (await ctx.store.getProject(id))!;
    const { client: docker } = fakeDocker();
    const capabilities = createGhTokenCapabilityRegistry(ctx.db);
    const cap = await capabilities.issue({
      projectId: id,
      owner: project.owner,
      repo: project.repo,
    });
    expect(await capabilities.resolve(cap)).toBeDefined();

    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      capabilities,
    );
    await deprovisioner.deprovision(id, { purge: false });

    // A copy of the capability that leaked out of the torn-down sandbox no longer
    // redeems at the broker.
    expect(await capabilities.resolve(cap)).toBeUndefined();
  });

  // Resource cleanup is best-effort. DELETE /projects/:id hides the row only
  // after deprovision resolves, so a cleanup step that threw used to make the
  // project permanently undeletable — the retry re-ran the same failing step.
  // Credential revocation is the deliberate exception; see the fail-closed test
  // at the end of this block.
  it('a wedged relay teardown does not block the transition to absent, and still revokes its capabilities', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const failures: Array<{ step: string; message: string }> = [];
    const revokedGithub: string[] = [];
    const revokedSigning: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedGithub.push(projectId);
        }),
      },
      undefined,
      undefined,
      {
        stop: vi.fn(async () => {
          throw new Error('project relay teardown failed');
        }),
      },
      undefined,
      (_project, step, cause) =>
        failures.push({ step, message: cause instanceof Error ? cause.message : String(cause) }),
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedSigning.push(projectId);
        }),
      },
    );

    const result = await deprovisioner.deprovision(id, { purge: false });

    expect(result.state).toBe('absent');
    expect(failures).toEqual([{ step: 'relay-stop', message: 'project relay teardown failed' }]);
    // `relay.stop` revokes both capabilities itself, but it threw — so the
    // fail-closed pass has to repeat them. Otherwise swallowing the relay
    // failure would hide a project whose capabilities still redeem.
    expect(revokedGithub).toEqual([id]);
    expect(revokedSigning).toEqual([id]);
  });

  it('a clone directory that cannot be removed still purges the runner root and marks absent', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const removed: string[] = [];
    const failures: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      () => true,
      (path) => {
        if (path === '/data/dev/example-org-example-repo') {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        removed.push(path);
      },
      undefined,
      '/srv/verity/runners',
      undefined,
      undefined,
      undefined,
      (_project, step) => failures.push(step),
    );

    const result = await deprovisioner.deprovision(id, { purge: true });

    expect(result.state).toBe('absent');
    // The failing clone purge must not skip the runner root behind it.
    expect(removed).toEqual([`/srv/verity/runners/${id}`]);
    expect(failures).toEqual(['clone-purge']);
  });

  // A probe that cannot answer is not the same as "already gone": a directory
  // the server may not stat is a directory it is about to leave behind, so it
  // has to be reported rather than silently pass for cleaned up.
  it('a clone path that cannot even be probed is reported, not treated as already gone', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const removed: string[] = [];
    const failures: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      (path) => {
        if (path === '/data/dev/example-org-example-repo') {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return true;
      },
      (path) => removed.push(path),
      undefined,
      '/srv/verity/runners',
      undefined,
      undefined,
      undefined,
      (_project, step) => failures.push(step),
    );

    const result = await deprovisioner.deprovision(id, { purge: true });

    expect(result.state).toBe('absent');
    expect(removed).toEqual([`/srv/verity/runners/${id}`]);
    expect(failures).toEqual(['clone-purge']);
  });

  // The deliberate counterpart to the best-effort cleanup above: a project whose
  // capabilities could not be revoked must NOT be deprovisioned, because
  // `DELETE /projects/:id` would then hide it while a capability that leaked out
  // of the sandbox still redeems. Deletion staying blocked is the correct
  // outcome here — the revoke is a DELETE against the same database the state
  // transition needs, so a failure that outlives a retry is an outage under
  // which nothing could have been deleted anyway.
  it('an unreachable egress registry blocks the deprovision instead of failing open', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const failures: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sandboxMaterial: vi.fn(),
        revokeProject: vi.fn(async () => {
          throw new Error('egress registry unreachable');
        }),
      } as unknown as ClaudeEgressIdentityService,
      undefined,
      undefined,
      (_project, step) => failures.push(step),
    );

    const caught = await deprovisioner.deprovision(id, { purge: false }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
      'egress registry unreachable',
    ]);

    // Not reported as a best-effort failure, and the row never reaches `absent`,
    // so the route rejects before it can hide the project.
    expect(failures).toEqual([]);
    expect((await ctx.store.getProject(id))?.state).toBe('active');
  });

  // The registries are independent, so one that is wedged must not shield the
  // others: awaiting them in sequence would leave a leaked GitHub capability
  // redeeming purely because the signing registry happened to fail first.
  it('a failing signing registry still revokes the GitHub and egress credentials', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const revokedGithub: string[] = [];
    const revokedEgress: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedGithub.push(projectId);
        }),
      },
      undefined,
      {
        sandboxMaterial: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedEgress.push(projectId);
        }),
      } as unknown as ClaudeEgressIdentityService,
      undefined,
      undefined,
      undefined,
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(async (): Promise<void> => {
          throw new Error('signing capability store unavailable');
        }),
      },
    );

    const caught = await deprovisioner.deprovision(id, { purge: false }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
      'signing capability store unavailable',
    ]);

    // The other two authorities are gone even though the deletion is blocked.
    expect(revokedGithub).toEqual([id]);
    expect(revokedEgress).toEqual([id]);
    expect((await ctx.store.getProject(id))?.state).toBe('active');
  });

  // Same requirement, harsher failure: a registry that throws before returning
  // the promise its signature advertises escapes while the revocation list is
  // still being assembled, so the calls after it would never be made at all.
  it('a synchronously throwing registry still revokes the credentials behind it', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const revokedEgress: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sandboxMaterial: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedEgress.push(projectId);
        }),
      } as unknown as ClaudeEgressIdentityService,
      undefined,
      undefined,
      undefined,
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn((): Promise<void> => {
          throw new Error('signing registry threw synchronously');
        }),
      },
    );

    const caught = await deprovisioner.deprovision(id, { purge: false }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
      'signing registry threw synchronously',
    ]);

    expect(revokedEgress).toEqual([id]);
    expect((await ctx.store.getProject(id))?.state).toBe('active');
  });

  // A cleanup step that never settles blocks the deletion exactly as durably as
  // one that throws — `relay.stop` queues behind an in-flight start, so a wedged
  // provision would otherwise hold every later delete attempt open forever.
  it('a relay teardown that never settles is bounded and still marks the project absent', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const failures: Array<{ step: string; message: string }> = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { stop: vi.fn(() => new Promise<void>(() => undefined)) },
      undefined,
      (_project, step, cause) =>
        failures.push({ step, message: cause instanceof Error ? cause.message : String(cause) }),
      undefined,
      25,
    );

    const result = await deprovisioner.deprovision(id, { purge: false });

    expect(result.state).toBe('absent');
    expect(failures).toEqual([
      { step: 'relay-stop', message: "teardown step 'relay-stop' timed out after 25ms" },
    ]);
  });

  // The same bound on the fail-closed half resolves the other way: a hung
  // revocation must refuse the deletion, not hang the request behind it.
  it('a credential revocation that never settles is bounded and blocks the deprovision', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const revokedEgress: string[] = [];
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      {
        issue: vi.fn(),
        resolve: vi.fn(),
        revokeProject: vi.fn(() => new Promise<void>(() => undefined)),
      },
      undefined,
      {
        sandboxMaterial: vi.fn(),
        revokeProject: vi.fn(async (projectId: string): Promise<void> => {
          revokedEgress.push(projectId);
        }),
      } as unknown as ClaudeEgressIdentityService,
      undefined,
      undefined,
      undefined,
      undefined,
      25,
    );

    const caught = await deprovisioner.deprovision(id, { purge: false }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual([
      'github capability revocation timed out after 25ms',
    ]);

    // The wedged registry did not hold up the one behind it.
    expect(revokedEgress).toEqual([id]);
    expect((await ctx.store.getProject(id))?.state).toBe('active');
  });

  // A logger that throws must not resurrect the abort the best-effort branch
  // exists to prevent.
  it('a throwing failure reporter does not block the transition to absent', async () => {
    const id = await seedProject('active');
    const { client: docker } = fakeDocker();
    const deprovisioner = new DeprovisionerImpl(
      ctx.store,
      ctx.db,
      docker,
      '/data/dev',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        stop: vi.fn(async () => {
          throw new Error('project relay teardown failed');
        }),
      },
      undefined,
      () => {
        throw new Error('logger exploded');
      },
    );

    const result = await deprovisioner.deprovision(id, { purge: false });

    expect(result.state).toBe('absent');
  });
});

describe('reconcileRelays + provision hard-stop (Stage 5 legacy migration)', () => {
  function relayControl(
    isHealthy?: (binding: { projectId: string; containerGeneration: string }) => Promise<boolean>,
    resume?: ProjectRelayControl['resume'],
  ) {
    return {
      start: vi.fn(async (binding: { projectId: string; containerGeneration: string }) => ({
        identity: {
          projectId: binding.projectId,
          containerGeneration: binding.containerGeneration,
        },
        signingCapability: 'sign',
        githubCapability: 'gh',
      })),
      stop: vi.fn(async () => undefined),
      brokerUrl: () => 'http://relay:8080',
      claudeGatewayUrl: () => 'https://relay:8443',
      // Omitted entirely when the caller passes nothing, so the default doubles
      // keep the pre-repair behaviour of never probing relay health.
      ...(isHealthy === undefined ? {} : { isHealthy: vi.fn(isHealthy) }),
      ...(resume === undefined ? {} : { resume: vi.fn(resume) }),
    };
  }

  function makeProvisioner(
    docker: DockerClient,
    opts: {
      isHealthy?: (binding: { projectId: string; containerGeneration: string }) => Promise<boolean>;
      resume?: ProjectRelayControl['resume'];
      withContainerReplace?: ProvisionerOptions['withContainerReplace'];
      recreateEnvDriftedSandboxes?: boolean;
    } = {},
  ) {
    return createProvisioner({
      store: ctx.store,
      db: ctx.db,
      docker,
      git: fakeGit([]).runner,
      token: 'tok',
      defaultImageRef: 'default',
      ghTokenFilePath: '/etc/gh-token',
      hostCloneRoot: '/srv/verity/workspaces',
      isDirectory: () => false,
      projectRelay: relayControl(opts.isHealthy, opts.resume),
      ...(opts.withContainerReplace === undefined
        ? {}
        : { withContainerReplace: opts.withContainerReplace }),
      // Omitted unless a test asks, so every other test here exercises the
      // shipped default rather than an explicitly pinned one.
      ...(opts.recreateEnvDriftedSandboxes === undefined
        ? {}
        : { recreateEnvDriftedSandboxes: opts.recreateEnvDriftedSandboxes }),
    });
  }

  /** A docker double whose inspect dispatches by container name; `'absent'`
   *  throws so `classifyProjectSandbox` folds it to the `absent` class. */
  function dockerInspecting(byName: Record<string, ContainerInspect | 'absent'>): {
    client: DockerClient;
    calls: Array<{ method: string; payload: unknown }>;
  } {
    return fakeDocker({
      inspectContainer: vi.fn(async (name: string) => {
        const entry = byName[name];
        if (entry === undefined || entry === 'absent') {
          throw new Error(`no such container ${name}`);
        }
        return entry;
      }),
    });
  }

  async function seedActive(id: string, containerName: string, kind?: 'control_plane') {
    return ctx.store.upsertProject({
      id,
      owner: 'example-org',
      repo: 'example-repo',
      containerName,
      state: 'active',
      ...(kind !== undefined ? { kind } : {}),
    });
  }

  const legacyInspect = (id: string): ContainerInspect => ({
    id: `cid-${id}`,
    running: true,
    labels: { [PROJECT_ID_LABEL]: id },
    networks: { verity: {} },
  });
  const migratedInspect = (id: string): ContainerInspect => ({
    id: `cid-${id}`,
    running: true,
    labels: { [PROJECT_ID_LABEL]: id, [CONTAINER_GENERATION_LABEL]: 'gen-1' },
    networks: { [projectNetworkName(id)]: {} },
  });
  const foreignInspect = (): ContainerInspect => ({
    id: 'cid-foreign',
    running: true,
    labels: {},
    networks: { verity: {} },
  });

  type PrivatePhase = { runContainerPhase: (...args: unknown[]) => Promise<unknown> };

  it('migrates an idle legacy sandbox by recreating it', async () => {
    const p = await seedActive('legacy', 'dev-legacy');
    const { client } = dockerInspecting({ 'dev-legacy': legacyInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated: string[] = [];
    await provisioner.reconcileRelays([p], { onMigrated: (id) => migrated.push(id) });
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    expect(migrated).toEqual([p.id]);
  });

  it('recreates an env-drifted sandbox and says so, rather than calling it legacy', async () => {
    // The observability half of the drift fix. A sandbox that predates part of an env
    // block classifies `legacy` exactly like a pre-relay one and takes the same
    // recreate, so without a reason on the callback the first deploy of a new cohort
    // recreates the whole fleet under a log line that names neither cause.
    const p = await seedActive('drifted', 'dev-drifted');
    const { client } = dockerInspecting({
      'dev-drifted': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated: Array<{ id: string; envDrift: boolean }> = [];
    await provisioner.reconcileRelays([p], {
      onMigrated: (id, info) => migrated.push({ id, envDrift: info.envDrift }),
    });
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    expect(migrated).toEqual([{ id: p.id, envDrift: true }]);
  });

  it('does not blame env drift for a sandbox that is legacy for another reason', async () => {
    const p = await seedActive('plain-legacy', 'dev-plain-legacy');
    const { client } = dockerInspecting({
      'dev-plain-legacy': { ...legacyInspect(p.id), env: ['PATH=/usr/bin'] },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated: Array<{ id: string; envDrift: boolean }> = [];
    await provisioner.reconcileRelays([p], {
      onMigrated: (id, info) => migrated.push({ id, envDrift: info.envDrift }),
    });
    expect(migrated).toEqual([{ id: p.id, envDrift: false }]);
  });

  it('stops recreating a sandbox that keeps coming back drifted, and reports it', async () => {
    // The one recreate with no proof of termination. A `legacy` sandbox is legacy
    // because of its network and generation and the recreate sets both; the env a
    // sandbox comes back with is decided by the deployment's configuration instead,
    // so a wrongly declared cohort would rebuild the fleet on every tick forever —
    // killing every turn that happened to be idle. Here Docker keeps reporting the
    // same drifted container, which is exactly what that looks like.
    const p = await seedActive('drift-loop', 'dev-drift-loop');
    const { client } = dockerInspecting({
      'dev-drift-loop': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const unresolved: Array<{ id: string; attempts: number }> = [];
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT + 3; tick++) {
      await provisioner.reconcileRelays([p], {
        onEnvDriftUnresolved: (id, info) => unresolved.push({ id, attempts: info.attempts }),
      });
    }
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
    // Once, not once per tick: past the budget the drift is a standing condition to
    // be fixed in the provisioner, and an error per tick would bury the one that says so.
    expect(unresolved).toEqual([{ id: p.id, attempts: ENV_DRIFT_RECREATE_LIMIT }]);
  });

  it('spends no drift budget on a sandbox that is legacy for a structural reason', async () => {
    // The budget is keyed on drift being the SOLE reason precisely so that exhausting
    // it can never strand a container on the shared network. This one carries
    // Claude-era env AND no generation stamp, so it is recreated for the structural
    // fault every tick, budget or no budget.
    const p = await seedActive('drift-and-legacy', 'dev-drift-and-legacy');
    const { client } = dockerInspecting({
      'dev-drift-and-legacy': {
        ...legacyInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const unresolved: string[] = [];
    const ticks = ENV_DRIFT_RECREATE_LIMIT + 3;
    for (let tick = 0; tick < ticks; tick++) {
      await provisioner.reconcileRelays([p], {
        onEnvDriftUnresolved: (id) => unresolved.push(id),
      });
    }
    expect(recreate).toHaveBeenCalledTimes(ticks);
    expect(unresolved).toEqual([]);
  });

  it('leaves an env-drifted sandbox alone when the kill switch is off', async () => {
    // The escape hatch for the failure this whole feature risks: a cohort declared
    // wrongly turns every tick into a fleet-wide rebuild. Three recreates per project
    // bound that, but the bound is per process — a crash-looping control plane refunds
    // it. `recreateEnvDriftedSandboxes: false` restores the behaviour that shipped
    // before drift was a reason to touch anything, without a rollback.
    const p = await seedActive('drift-switched-off', 'dev-drift-switched-off');
    const { client } = dockerInspecting({
      'dev-drift-switched-off': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client, { recreateEnvDriftedSandboxes: false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated: string[] = [];
    await provisioner.reconcileRelays([p], { onMigrated: (id) => migrated.push(id) });
    expect(recreate).not.toHaveBeenCalled();
    expect(migrated).toEqual([]);
  });

  it('still migrates a structurally legacy sandbox with the kill switch off', async () => {
    // The switch takes drift out of scope, not the classification: turning it off
    // must not quietly disable relay migration itself and strand containers on the
    // shared network. This one carries drifted env AND no generation stamp.
    const p = await seedActive('legacy-switched-off', 'dev-legacy-switched-off');
    const { client } = dockerInspecting({
      'dev-legacy-switched-off': {
        ...legacyInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client, { recreateEnvDriftedSandboxes: false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated: Array<{ id: string; envDrift: boolean }> = [];
    await provisioner.reconcileRelays([p], {
      onMigrated: (id, info) => migrated.push({ id, envDrift: info.envDrift }),
    });
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    // Not blamed on drift either — with drift out of scope there is no drift reason.
    expect(migrated).toEqual([{ id: p.id, envDrift: false }]);
  });

  it('recreates only a few drifted sandboxes per tick, and says how many it left', async () => {
    // Repetition and blast radius are different failures with different bounds. The
    // per-project budget does nothing here: drift arrives fleet-wide by construction
    // — a deployment starts writing a cohort its running sandboxes predate — so the
    // first tick after that deploy finds every idle sandbox drifted and, unthrottled,
    // rebuilds all of them at once. That is the right repair delivered as an outage.
    const drifted = ENV_DRIFT_RECREATES_PER_TICK + 3;
    const projects: ProjectRecord[] = [];
    const containers: Record<string, ContainerInspect> = {};
    for (let index = 0; index < drifted; index++) {
      const project = await ctx.store.upsertProject({
        id: `drift-fleet-${String(index)}`,
        owner: 'example-org',
        repo: `fleet-${String(index)}`,
        containerName: `dev-drift-fleet-${String(index)}`,
        state: 'active',
      });
      projects.push(project);
      containers[project.containerName] = {
        ...migratedInspect(project.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      };
    }
    const { client } = dockerInspecting(containers);
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockImplementation(async (id: string) => projects.find((p) => p.id === id)!);
    const throttled: Array<{ deferred: number; attempted: number; projectIds: readonly string[] }> =
      [];
    await provisioner.reconcileRelays(projects, {
      onEnvDriftThrottled: (info) => throttled.push(info),
    });
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATES_PER_TICK);
    // Reported, not silent: a pass that stopped short otherwise looks exactly like a
    // finished one, and the fleet still being half-drifted reads as a missed repair.
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({
      deferred: drifted - ENV_DRIFT_RECREATES_PER_TICK,
      attempted: ENV_DRIFT_RECREATES_PER_TICK,
    });
    // Named, so the log answers "which projects are still 502ing" rather than only
    // "some are". Every id is one of this pass's projects and none was rebuilt.
    expect(throttled[0]?.projectIds).toHaveLength(drifted - ENV_DRIFT_RECREATES_PER_TICK);
    const rebuilt = new Set(recreate.mock.calls.map(([id]) => id));
    for (const projectId of throttled[0]?.projectIds ?? []) {
      expect(projects.map((p) => p.id)).toContain(projectId);
      expect(rebuilt.has(projectId)).toBe(false);
    }
    // Nothing about being turned away is remembered, so the next tick reconsiders
    // them from scratch and the fleet converges a few projects at a time.
    await provisioner.reconcileRelays(projects, {});
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATES_PER_TICK * 2);
  });

  it('spends a per-tick slot on a drift recreate that threw', async () => {
    // The per-project budget and the per-tick cap are charged by opposite rules, and
    // a failed recreate is where they come apart. The budget is NOT charged — a
    // recreate that threw says nothing about whether the drift would have been fixed.
    // The cap IS, because it bounds how much container churn one tick may cause, and
    // a tick where every recreate fails is exactly the fleet-wide fault it exists
    // for: refunding there would let the whole fleet through at full width on the
    // one pass that should be narrowest.
    const projects: ProjectRecord[] = [];
    const containers: Record<string, ContainerInspect> = {};
    for (let index = 0; index < ENV_DRIFT_RECREATES_PER_TICK + 2; index++) {
      const project = await ctx.store.upsertProject({
        id: `drift-throw-${String(index)}`,
        owner: 'example-org',
        repo: `throw-${String(index)}`,
        containerName: `dev-drift-throw-${String(index)}`,
        state: 'active',
      });
      projects.push(project);
      containers[project.containerName] = {
        ...migratedInspect(project.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      };
    }
    const { client } = dockerInspecting(containers);
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('image pull failed'));
    await expect(provisioner.reconcileRelays(projects, {})).rejects.toThrow(/Relay migration/);
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATES_PER_TICK);
  });

  it('does not throttle a structurally legacy sandbox behind the drift cap', async () => {
    // The cap is for the fleet-wide case. A pre-relay container is a one-off
    // structural fault with no broker, signing or egress at all; making it queue
    // behind drifted ones would delay the more serious repair for the less serious.
    const projects: ProjectRecord[] = [];
    const containers: Record<string, ContainerInspect> = {};
    for (let index = 0; index < ENV_DRIFT_RECREATES_PER_TICK + 2; index++) {
      const project = await ctx.store.upsertProject({
        id: `mixed-fleet-${String(index)}`,
        owner: 'example-org',
        repo: `mixed-${String(index)}`,
        containerName: `dev-mixed-fleet-${String(index)}`,
        state: 'active',
      });
      projects.push(project);
      containers[project.containerName] = {
        ...migratedInspect(project.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      };
    }
    // One plain pre-relay container, sorted last so the drifted ones spend the cap first.
    const legacy = await ctx.store.upsertProject({
      id: 'mixed-fleet-legacy',
      owner: 'example-org',
      repo: 'mixed-legacy',
      containerName: 'dev-mixed-fleet-legacy',
      state: 'active',
    });
    projects.push(legacy);
    containers[legacy.containerName] = legacyInspect(legacy.id);
    const { client } = dockerInspecting(containers);
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreated: string[] = [];
    vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async (id: string) => {
      recreated.push(id);
      return projects.find((p) => p.id === id)!;
    });
    await provisioner.reconcileRelays(projects, {});
    expect(recreated).toContain(legacy.id);
    expect(recreated).toHaveLength(ENV_DRIFT_RECREATES_PER_TICK + 1);
  });

  it('charges the drift budget nothing for a tick the sandbox was busy', async () => {
    // Deferring is not attempting. A project that happens to be mid-turn on every
    // tick would otherwise exhaust its budget without a single recreate, and then be
    // refused the repair the moment it finally went idle.
    const p = await seedActive('drift-busy', 'dev-drift-busy');
    const { client } = dockerInspecting({
      'dev-drift-busy': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    let busy = true;
    provisioner.attachProjectBusyProbe(async () => busy);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT + 2; tick++) {
      await provisioner.reconcileRelays([p], {});
    }
    expect(recreate).not.toHaveBeenCalled();
    busy = false;
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT + 2; tick++) {
      await provisioner.reconcileRelays([p], {});
    }
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
  });

  it('does not refund the drift budget for a tick the project sat out', async () => {
    // The budget and the disconnected-sandbox report are pruned by rules that LOOK
    // alike and run opposite ways: forgetting a report retracts a claim that
    // something is broken, forgetting a budget restores unbounded recreates. A
    // project skipped for a tick — here, one whose provision is in flight — must come
    // back with the same budget it left with, or the loop resumes in bursts of three.
    const p = await seedActive('drift-skipped', 'dev-drift-skipped');
    const { client } = dockerInspecting({
      'dev-drift-skipped': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT; tick++) {
      await provisioner.reconcileRelays([p]);
    }
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
    // A pass this project is not part of at all — the shape a skip takes from the
    // pruning loop's point of view.
    await provisioner.reconcileRelays([]);
    await provisioner.reconcileRelays([p]);
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
  });

  it('does not charge the drift budget for a recreate that threw', async () => {
    // The limit is 3 rather than 1 because a recreate can fail for reasons of its
    // own. Charging those failures would invert that: three unrelated daemon hiccups
    // would disqualify the project from a repair that then never gets attempted —
    // permanently, since only a `migrated` classification clears the count and a
    // sandbox that was never rebuilt cannot produce one.
    const p = await seedActive('drift-throws', 'dev-drift-throws');
    const { client } = dockerInspecting({
      'dev-drift-throws': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    let failing = true;
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      if (failing) throw new Error('docker daemon is not running');
      return p;
    });
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT + 2; tick++) {
      await expect(provisioner.reconcileRelays([p])).rejects.toBeInstanceOf(AggregateError);
    }
    failing = false;
    const spentOnFailures = recreate.mock.calls.length;
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT; tick++) {
      await provisioner.reconcileRelays([p]);
    }
    expect(recreate).toHaveBeenCalledTimes(spentOnFailures + ENV_DRIFT_RECREATE_LIMIT);
  });

  it('gives a repaired project its full drift budget back', async () => {
    // Cleared on `migrated` rather than on any healthy-looking tick: the budget is
    // cumulative on purpose, so only the observation that the drift is actually gone
    // may reset it. Otherwise a project that drifts again later would be born already
    // out of attempts.
    const p = await seedActive('drift-then-fixed', 'dev-drift-then-fixed');
    const drifted = {
      ...migratedInspect(p.id),
      env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
    };
    const whole = {
      ...migratedInspect(p.id),
      env: [
        'PATH=/usr/bin',
        'VERITY_CLAUDE_EGRESS_URL=https://relay:8443',
        'VERITY_CLAUDE_EGRESS_AUTHORITY=relay:8443',
        'VERITY_CODEX_EGRESS_URL=https://relay:8444',
        'VERITY_CODEX_EGRESS_AUTHORITY=relay:8444',
      ],
    };
    const inspects: Record<string, ContainerInspect> = { 'dev-drift-then-fixed': drifted };
    const { client } = dockerInspecting(inspects);
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    inspects['dev-drift-then-fixed'] = whole;
    await provisioner.reconcileRelays([p]);
    inspects['dev-drift-then-fixed'] = drifted;
    for (let tick = 0; tick < ENV_DRIFT_RECREATE_LIMIT; tick++) {
      await provisioner.reconcileRelays([p]);
    }
    // One before the repair plus a full budget after it — not a budget that ran out
    // one recreate early because the first one was never forgiven.
    expect(recreate).toHaveBeenCalledTimes(1 + ENV_DRIFT_RECREATE_LIMIT);
  });

  it('defers a busy legacy sandbox rather than recreating it', async () => {
    const p = await seedActive('busy-legacy', 'dev-busy-legacy');
    const { client } = dockerInspecting({ 'dev-busy-legacy': legacyInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const deferred: string[] = [];
    await provisioner.reconcileRelays([p], { onDeferred: (id) => deferred.push(id) });
    expect(recreate).not.toHaveBeenCalled();
    expect(deferred).toEqual([p.id]);
  });

  it('defaults to busy (defers) when no busy probe is attached', async () => {
    const p = await seedActive('no-probe', 'dev-no-probe');
    const { client } = dockerInspecting({ 'dev-no-probe': legacyInspect(p.id) });
    const provisioner = makeProvisioner(client);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const deferred: string[] = [];
    await provisioner.reconcileRelays([p], { onDeferred: (id) => deferred.push(id) });
    expect(recreate).not.toHaveBeenCalled();
    expect(deferred).toEqual([p.id]);
  });

  it('leaves an already-migrated sandbox untouched', async () => {
    const p = await seedActive('done', 'dev-done');
    const { client } = dockerInspecting({ 'dev-done': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('repairs a migrated sandbox whose relay is gone', async () => {
    // The failure this exists for: a server restart tears down the relay
    // containers while the sandboxes keep running. Without the health probe the
    // sandbox classifies `migrated` and stays broker-less forever.
    const p = await seedActive('orphan', 'dev-orphan');
    const { client } = dockerInspecting({ 'dev-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const repaired: string[] = [];
    const migrated: string[] = [];
    await provisioner.reconcileRelays([p], {
      onRepaired: (id) => repaired.push(id),
      onMigrated: (id) => migrated.push(id),
    });
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    // Reported as a repair, not a migration — the two have different causes and a
    // lost relay is worth a louder log line than a planned migration.
    expect(repaired).toEqual([p.id]);
    expect(migrated).toEqual([]);
  });

  it('resumes a relay after Server restart without recreating its sandbox', async () => {
    const p = await seedActive('resumed', 'dev-resumed');
    const { client } = dockerInspecting({ 'dev-resumed': migratedInspect(p.id) });
    let active = false;
    const resume = vi.fn(async () => {
      active = true;
      return true;
    });
    const provisioner = makeProvisioner(client, {
      isHealthy: async () => active,
      resume,
    });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: p.id, containerGeneration: 'gen-1' }),
    );
    expect(recreate).not.toHaveBeenCalled();
  });

  it('updates a stale sandbox automatically once its project is idle', async () => {
    const p = await seedActive('image-update', 'dev-image-update');
    const { client } = dockerInspecting({ 'dev-image-update': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const migrated = vi.fn();

    await provisioner.reconcileRelays([p], {
      updateAvailable: new Set([p.id]),
      onMigrated: migrated,
    });

    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    expect(migrated).toHaveBeenCalledWith(p.id, {
      envDrift: false,
      imageUpdate: true,
    });
  });

  it('waits indefinitely for a busy project before updating its sandbox image', async () => {
    const p = await seedActive('busy-image-update', 'dev-busy-image-update');
    const { client } = dockerInspecting({ 'dev-busy-image-update': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const deferred = vi.fn();

    for (let tick = 0; tick < ORPHAN_DEFER_TICK_LIMIT + 2; tick++) {
      await provisioner.reconcileRelays([p], {
        updateAvailable: new Set([p.id]),
        onDeferred: deferred,
      });
    }

    expect(deferred).toHaveBeenCalledTimes(ORPHAN_DEFER_TICK_LIMIT + 2);
    expect(recreate).not.toHaveBeenCalled();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('probes relay health for the generation the sandbox is actually stamped with', async () => {
    const p = await seedActive('orphan-gen', 'dev-orphan-gen');
    const { client } = dockerInspecting({ 'dev-orphan-gen': migratedInspect(p.id) });
    const isHealthy = vi.fn(async () => false);
    const provisioner = makeProvisioner(client, { isHealthy });
    provisioner.attachProjectBusyProbe(async () => false);
    vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    // `gen-1` is the stamp on migratedInspect: asking about any other generation
    // would answer for a relay this sandbox was never wired to.
    expect(isHealthy).toHaveBeenCalledWith({ projectId: p.id, containerGeneration: 'gen-1' });
  });

  it('defers a busy sandbox whose relay is gone instead of recreating it', async () => {
    const p = await seedActive('busy-orphan', 'dev-busy-orphan');
    const { client } = dockerInspecting({ 'dev-busy-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const deferred: string[] = [];
    await provisioner.reconcileRelays([p], { onDeferred: (id) => deferred.push(id) });
    expect(recreate).not.toHaveBeenCalled();
    expect(deferred).toEqual([p.id]);
  });

  it('reports the disconnection for exactly as long as the repair is deferred', async () => {
    // The point of reporting separately from repairing: a busy orphan is NOT
    // repaired this tick, and it is precisely then that a session inside it fails
    // every brokered call with nothing on screen to say why.
    const p = await seedActive('cutoff-report', 'dev-cutoff-report');
    const { client } = dockerInspecting({ 'dev-cutoff-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([p.id]);
  });

  it('reports nothing for a sandbox whose relay is live', async () => {
    const p = await seedActive('healthy-report', 'dev-healthy-report');
    const { client } = dockerInspecting({ 'dev-healthy-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => true });
    provisioner.attachProjectBusyProbe(async () => false);
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([]);
  });

  it('stops reporting once the sandbox has been repaired', async () => {
    const p = await seedActive('repaired-report', 'dev-repaired-report');
    const { client } = dockerInspecting({ 'dev-repaired-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    const busy = vi.fn(async () => true);
    provisioner.attachProjectBusyProbe(busy);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([p.id]);
    // The turn ends; the same tick that repairs the sandbox must retract the
    // report rather than leave it up until a later pass reclassifies.
    busy.mockResolvedValue(false);
    await provisioner.reconcileRelays([p]);
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([]);
  });

  it('reports a stalled self-repair only after the recreate has failed twice', async () => {
    // The distinction the overview icon is built on. One failed recreate is a
    // registry blip the next tick usually clears; the flag has to mean "retrying
    // is not working", or it fires on transients and stops being read.
    const p = await seedActive('stall-report', 'dev-stall-report');
    const { client } = dockerInspecting({ 'dev-stall-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('pull failed'));

    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);

    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);
    expect(recreate).toHaveBeenCalledTimes(2);
  });

  it('clears the stall once a recreate finally succeeds', async () => {
    const p = await seedActive('stall-clear', 'dev-stall-clear');
    const { client } = dockerInspecting({ 'dev-stall-clear': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('pull failed'));
    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);

    recreate.mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('does not count a deferred repair as a failed one', async () => {
    // Deferring is the repair working as designed (SBX-1: never recreate under a
    // live turn). Counting it would report every long-running turn as a fault.
    const p = await seedActive('stall-defer', 'dev-stall-defer');
    const { client } = dockerInspecting({ 'dev-stall-defer': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('reports a sandbox the reconciler looked at and left alone', async () => {
    // The gap the failure counter alone cannot see. `decideMigrationAction` reads
    // relay generation and network topology, never image staleness — so a sandbox
    // with a live relay on its own network is `migrated` and never recreated, no
    // matter how far its image has drifted. On a deployment tracking a floating
    // tag the target can move underneath a running incarnation, and then nothing
    // repairs anything. Calling that "converging" would promise a rebuild that is
    // not scheduled and never will be.
    const p = await seedActive('settled-report', 'dev-settled-report');
    const { client } = dockerInspecting({ 'dev-settled-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => true });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);

    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);
  });

  it('retracts both verdicts while a repair is deferred around a live turn', async () => {
    // A project that reached the stall limit and then goes busy is converging
    // again, not stuck: the deferral is SBX-1 doing its job and it is bounded. It
    // must not keep telling the operator to intervene — the manual update they
    // would reach for is refused by the same guard.
    const p = await seedActive('stall-then-busy', 'dev-stall-then-busy');
    const { client } = dockerInspecting({ 'dev-stall-then-busy': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    const busy = vi.fn(async () => false);
    provisioner.attachProjectBusyProbe(busy);
    vi.spyOn(provisioner, 'recreateContainer').mockRejectedValue(new Error('pull failed'));
    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);

    busy.mockResolvedValue(true);
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('does not charge a throwing callback to the repair streak', async () => {
    // The streak is meant to answer "does recreating this sandbox work". A caller
    // whose `onRepaired` logger throws has said nothing about that — and counting
    // it would report a sandbox as stuck after two rebuilds that both succeeded.
    const p = await seedActive('callback-throws', 'dev-callback-throws');
    const { client } = dockerInspecting({ 'dev-callback-throws': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);
    vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const onRepaired = () => {
      throw new Error('log sink is down');
    };

    await expect(provisioner.reconcileRelays([p], { onRepaired })).rejects.toThrow();
    await expect(provisioner.reconcileRelays([p], { onRepaired })).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('breaks the recreate-failure streak when an intervening probe is unknown', async () => {
    const p = await seedActive('nonconsecutive-failures', 'dev-nonconsecutive-failures');
    const { client } = dockerInspecting({
      'dev-nonconsecutive-failures': migratedInspect(p.id),
    });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    const busy = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('probe unavailable'))
      .mockResolvedValueOnce(false);
    provisioner.attachProjectBusyProbe(busy);
    vi.spyOn(provisioner, 'recreateContainer').mockRejectedValue(new Error('pull failed'));

    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    // Probe errors deliberately fold to an unconfirmed deferral rather than
    // escaping; that unknown tick still breaks the consecutive-failure streak.
    await expect(provisioner.reconcileRelays([p])).resolves.toBeUndefined();
    await expect(provisioner.reconcileRelays([p])).rejects.toThrow();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('retries a real recreate failure after it persists the project as failed', async () => {
    // `runContainerPhaseAttempt` persists `failed` when the force-pull fails. The
    // next pass must retain and retry that known repair attempt even though normal
    // failed projects are outside relay reconciliation; otherwise the consecutive
    // failure threshold can never be reached by the production path.
    const p = await seedActive('real-recreate-failure', 'dev-real-recreate-failure');
    const pullImage = vi.fn(async () => {
      throw new DockerError({
        kind: 'image_not_found',
        image: 'default',
        message: 'pull access denied',
      });
    });
    let containerPresent = true;
    const { client } = fakeDocker({
      inspectContainer: vi.fn(async () => {
        if (!containerPresent) throw new Error('container not found');
        return migratedInspect(p.id);
      }),
      removeContainer: vi.fn(async () => {
        containerPresent = false;
      }),
      pullImage,
    });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);

    await expect(provisioner.reconcileRelays([p])).rejects.toThrow(/Relay migration failed/);
    const failed = await ctx.store.getProject(p.id);
    expect(failed?.state).toBe('failed');
    expect(containerPresent).toBe(false);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);

    await expect(provisioner.reconcileRelays([failed!])).rejects.toThrow(/Relay migration failed/);
    expect(pullImage).toHaveBeenCalledTimes(2);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);
  });

  it.each(['confirmed deferral', 'unknown probe'] as const)(
    'keeps a failed project eligible after an intervening %s',
    async (interruption) => {
      const p = await seedActive(`retry-after-${interruption}`, `dev-retry-after-${interruption}`);
      const pullImage = vi.fn(async () => {
        throw new DockerError({
          kind: 'image_not_found',
          image: 'default',
          message: 'pull access denied',
        });
      });
      const { client } = fakeDocker({
        inspectContainer: vi.fn(async () => migratedInspect(p.id)),
        pullImage,
      });
      const provisioner = makeProvisioner(client, { isHealthy: async () => false });
      let probeCall = 0;
      provisioner.attachProjectBusyProbe(async () => {
        probeCall += 1;
        if (probeCall !== 2) return false;
        if (interruption === 'unknown probe') throw new Error('probe unavailable');
        return true;
      });

      await expect(provisioner.reconcileRelays([p])).rejects.toThrow(/Relay migration failed/);
      const failed = await ctx.store.getProject(p.id);
      expect(failed?.state).toBe('failed');

      // Both paths defer without attempting a recreate. They break the consecutive
      // failure streak, but must not forget that this failed project still needs an
      // automatic retry even though it is no longer `active`.
      await expect(provisioner.reconcileRelays([failed!])).resolves.toBeUndefined();
      await expect(provisioner.reconcileRelays([failed!])).rejects.toThrow(
        /Relay migration failed/,
      );
      expect(pullImage).toHaveBeenCalledTimes(2);
      expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
    },
  );

  it('retracts the report while a recreate for that project is in flight', async () => {
    // The operator taps the stuck icon; that recreate is the repair. The next
    // reconcile pass skips the project because a provision owns its container,
    // and a skip that carried the old verdict forward would leave "stuck" up for
    // the whole rebuild — pointing at an action that is already running.
    const p = await seedActive('settled-then-recreating', 'dev-settled-then-recreating');
    const { client } = dockerInspecting({
      'dev-settled-then-recreating': migratedInspect(p.id),
    });
    let release!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provisioner = makeProvisioner(client, {
      isHealthy: async () => true,
      // Hangs the recreate after it registers as in-flight, without needing the
      // container phase to be faked out.
      withContainerReplace: async (_project, replace) => {
        await replaceGate;
        return replace();
      },
    });
    provisioner.attachProjectBusyProbe(async () => false);

    await provisioner.reconcileRelays([p]);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([p.id]);

    const recreate = provisioner.recreateContainer(p.id, { confirmWarnings: true });
    await Promise.resolve();
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);

    release();
    await recreate.catch(() => undefined);
  });

  it('drops the report for a project it no longer reconciles', async () => {
    const p = await seedActive('gone-report', 'dev-gone-report');
    const { client } = dockerInspecting({ 'dev-gone-report': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([p.id]);
    // Deprovisioned / no longer active: nothing left to report about, and a
    // retained id would outlive the project it names.
    await provisioner.reconcileRelays([{ ...p, state: 'absent' }]);
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([]);
  });

  it('repairs a permanently busy orphan once its deferrals run out', async () => {
    // The livelock, end to end: the agent inside a broker-less sandbox retries a
    // signed commit, each retry keeps the project busy, and a busy-only guard
    // postpones the repair forever — observed live as one project deferring on
    // every tick for a whole server generation while four idle ones healed.
    const p = await seedActive('livelock-orphan', 'dev-livelock-orphan');
    const { client } = dockerInspecting({ 'dev-livelock-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true); // never goes idle
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    const repaired: Array<{ id: string; interruptedTurn: boolean }> = [];
    const deferred: string[] = [];
    const tick = async (): Promise<void> => {
      await provisioner.reconcileRelays([p], {
        onDeferred: (id) => deferred.push(id),
        onRepaired: (id, info) => repaired.push({ id, interruptedTurn: info.interruptedTurn }),
      });
    };

    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT; i += 1) await tick();
    // The grace window is real: a turn that finishes inside it is never killed.
    expect(recreate).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(ORPHAN_DEFER_TICK_LIMIT);

    await tick();
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
    // Reported as an interruption so the log says a turn was taken, not just that
    // a relay was replaced.
    expect(repaired).toEqual([{ id: p.id, interruptedTurn: true }]);
  });

  it('restarts the deferral window after a tick that did not defer', async () => {
    // Consecutive, not cumulative: a project that goes idle and gets repaired must
    // not carry a spent budget into the next time its relay dies, or the second
    // outage would kill a turn on the very first tick.
    const p = await seedActive('streak-orphan', 'dev-streak-orphan');
    const { client } = dockerInspecting({ 'dev-streak-orphan': migratedInspect(p.id) });
    let busy = true;
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => busy);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);

    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT - 1; i += 1) {
      await provisioner.reconcileRelays([p]);
    }
    expect(recreate).not.toHaveBeenCalled();

    busy = false; // idle tick → repaired, streak cleared
    await provisioner.reconcileRelays([p]);
    expect(recreate).toHaveBeenCalledTimes(1);

    busy = true;
    await provisioner.reconcileRelays([p]);
    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it('breaks the streak on a tick the project was skipped entirely', async () => {
    // A tick that never reached a decision is not a deferral. Counting it would
    // let an unrelated pause — a provision in flight, or the project sitting
    // inactive — spend the grace window, so the NEXT outage could interrupt a
    // turn before the operator ever saw a deferral logged.
    const p = await seedActive('skipped-orphan', 'dev-skipped-orphan');
    const { client } = dockerInspecting({ 'dev-skipped-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);

    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT - 1; i += 1) {
      await provisioner.reconcileRelays([p]);
    }
    // One tick where this project is not a candidate at all.
    await provisioner.reconcileRelays([{ ...p, state: 'cloning' }]);
    // The window starts over rather than expiring on the next tick.
    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT; i += 1) {
      await provisioner.reconcileRelays([p]);
    }
    expect(recreate).not.toHaveBeenCalled();
    await provisioner.reconcileRelays([p]);
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
  });

  it('never spends the window when the busy probe cannot answer', async () => {
    // `isProjectBusy` reports busy for an unattached probe and for one that throws.
    // Neither proves a turn exists, so neither may buy a recreate: a wedged probe
    // would otherwise start destroying sandboxes with live agents in them after
    // five ticks. Both cases defer indefinitely, as they did before the window.
    const unprobed = await seedActive('unprobed-orphan', 'dev-unprobed-orphan');
    const { client } = dockerInspecting({ 'dev-unprobed-orphan': migratedInspect(unprobed.id) });
    const noProbe = makeProvisioner(client, { isHealthy: async () => false });
    const recreateNoProbe = vi.spyOn(noProbe, 'recreateContainer').mockResolvedValue(unprobed);
    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT * 3; i += 1) {
      await noProbe.reconcileRelays([unprobed]);
    }
    expect(recreateNoProbe).not.toHaveBeenCalled();

    const throwing = makeProvisioner(client, { isHealthy: async () => false });
    throwing.attachProjectBusyProbe(async () => {
      throw new Error('conductor unreachable');
    });
    const recreateThrowing = vi.spyOn(throwing, 'recreateContainer').mockResolvedValue(unprobed);
    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT * 3; i += 1) {
      await throwing.reconcileRelays([unprobed]);
    }
    expect(recreateThrowing).not.toHaveBeenCalled();
  });

  it('drops the deferral of a project that leaves the reconcile set', async () => {
    // A project that stops being reconciled — deleted, or filtered out — must not
    // keep an entry alive for the rest of the process. If it comes back it is a
    // fresh incident, not the continuation of one nothing is counting any more.
    const p = await seedActive('gone-orphan', 'dev-gone-orphan');
    const { client } = dockerInspecting({ 'dev-gone-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);

    for (let i = 0; i < ORPHAN_DEFER_TICK_LIMIT; i += 1) {
      await provisioner.reconcileRelays([p]);
    }
    await provisioner.reconcileRelays([]);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('leaves a migrated sandbox alone when its relay is healthy', async () => {
    const p = await seedActive('healthy', 'dev-healthy');
    const { client } = dockerInspecting({ 'dev-healthy': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => true });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('leaves a migrated sandbox alone when the health probe throws', async () => {
    // Fail-safe direction: a wedged Docker daemon makes health UNKNOWN, and
    // unknown must never escalate into stopping a working sandbox.
    const p = await seedActive('probe-boom', 'dev-probe-boom');
    const { client } = dockerInspecting({ 'dev-probe-boom': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, {
      isHealthy: async () => {
        throw new Error('docker unreachable');
      },
    });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('does not probe relay health for a sandbox carrying no generation stamp', async () => {
    // A legacy sandbox is recreated on its own merits; asking about the relay of a
    // generation it does not have would be a meaningless lookup.
    const p = await seedActive('legacy-noprobe', 'dev-legacy-noprobe');
    const { client } = dockerInspecting({ 'dev-legacy-noprobe': legacyInspect(p.id) });
    const isHealthy = vi.fn(async () => false);
    const provisioner = makeProvisioner(client, { isHealthy });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(isHealthy).not.toHaveBeenCalled();
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
  });

  it('never recreates a foreign container', async () => {
    const p = await seedActive('foreign', 'dev-foreign');
    const { client } = dockerInspecting({ 'dev-foreign': foreignInspect() });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await provisioner.reconcileRelays([p]);
    expect(recreate).not.toHaveBeenCalled();
    expect([...provisioner.unrepairedSandboxes()]).toEqual([]);
  });

  it('skips non-active and control-plane projects without inspecting', async () => {
    const control = await seedActive('control', 'dev-control', 'control_plane');
    const cloning = await ctx.store.upsertProject({
      id: 'cloning-proj',
      owner: 'example-org',
      repo: 'example-repo',
      containerName: 'dev-cloning',
      state: 'cloning',
    });
    const { client, calls } = dockerInspecting({
      'dev-control': legacyInspect(control.id),
      'dev-cloning': legacyInspect(cloning.id),
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(control);
    await provisioner.reconcileRelays([control, cloning]);
    expect(recreate).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'inspectContainer')).toBe(false);
  });

  it('aggregates recreate failures and keeps converging the rest', async () => {
    const a = await seedActive('fail-a', 'dev-fail-a');
    const b = await seedActive('fail-b', 'dev-fail-b');
    const { client } = dockerInspecting({
      'dev-fail-a': legacyInspect(a.id),
      'dev-fail-b': legacyInspect(b.id),
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('recreate boom'));
    await expect(provisioner.reconcileRelays([a, b])).rejects.toBeInstanceOf(AggregateError);
    expect(recreate).toHaveBeenCalledTimes(2);
  });

  it('provision() migrates an idle legacy sandbox in place instead of reusing it', async () => {
    const p = await seedActive('hs-legacy', 'dev-hs-legacy');
    const { client } = dockerInspecting({ 'dev-hs-legacy': legacyInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    await provisioner.provision(p.id);
    expect(runPhase).toHaveBeenCalled();
  });

  it('provision() reuses an already-migrated active sandbox unchanged', async () => {
    const p = await seedActive('hs-done', 'dev-hs-done');
    const { client } = dockerInspecting({ 'dev-hs-done': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    await provisioner.provision(p.id);
    expect(runPhase).not.toHaveBeenCalled();
  });

  it('provision() retracts the report when it migrates an orphaned sandbox', async () => {
    // The provision path can classify AND repair without the reconciler ever
    // running. Leaving the report behind here would mark every session in a
    // freshly rebuilt sandbox unusable until the next tick reclassified it.
    const p = await seedActive('hs-orphan', 'dev-hs-orphan');
    const { client } = dockerInspecting({ 'dev-hs-orphan': migratedInspect(p.id) });
    const provisioner = makeProvisioner(client, { isHealthy: async () => false });
    provisioner.attachProjectBusyProbe(async () => false);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    await provisioner.provision(p.id);
    expect(runPhase).toHaveBeenCalled();
    expect([...provisioner.disconnectedSandboxProjects()]).toEqual([]);
  });

  it('provision() spends the shared drift budget and then reuses the sandbox', async () => {
    // A third loop driver, and the only one with a human on the other end: retrying a
    // provision against a misdeclared cohort would rebuild the sandbox once per press
    // if this path ignored the budget the tick and the turn gate both respect. When
    // the budget runs out it must REUSE, not fail — a provision that refuses over a
    // dead Codex leg takes the project down to fix half of it.
    const p = await seedActive('hs-drift', 'dev-hs-drift');
    const { client } = dockerInspecting({
      'dev-hs-drift': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    for (let attempt = 0; attempt < ENV_DRIFT_RECREATE_LIMIT + 3; attempt++) {
      await expect(provisioner.provision(p.id)).resolves.toBeDefined();
    }
    expect(runPhase).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
  });

  it('provision() leaves a drifted sandbox alone when the kill switch is off', async () => {
    // The switch's third and last carrier. Pinned separately from the reconcile and
    // turn paths because each reads it through its own call into the classifier: a
    // switch that only two of the three drivers honour still rebuilds the fleet, one
    // user-triggered provision at a time.
    const p = await seedActive('hs-drift-off', 'dev-hs-drift-off');
    const { client } = dockerInspecting({
      'dev-hs-drift-off': {
        ...migratedInspect(p.id),
        env: ['PATH=/usr/bin', 'VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client, { recreateEnvDriftedSandboxes: false });
    provisioner.attachProjectBusyProbe(async () => false);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    await expect(provisioner.provision(p.id)).resolves.toBeDefined();
    expect(runPhase).not.toHaveBeenCalled();
  });

  it('provision() reuses a busy legacy sandbox unchanged (deferred to reconcile)', async () => {
    const p = await seedActive('hs-busy', 'dev-hs-busy');
    const { client } = dockerInspecting({ 'dev-hs-busy': legacyInspect(p.id) });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => true);
    const runPhase = vi
      .spyOn(provisioner as unknown as PrivatePhase, 'runContainerPhase')
      .mockResolvedValue(p);
    await provisioner.provision(p.id);
    expect(runPhase).not.toHaveBeenCalled();
  });

  it('repairs a legacy sandbox when only the requesting session is busy', async () => {
    const p = await seedActive('turn-repair', 'dev-turn-repair');
    let repaired = false;
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () =>
      repaired ? migratedInspect(p.id) : legacyInspect(p.id),
    );
    const provisioner = makeProvisioner(client);
    const busyProbe = vi.fn(async () => false);
    provisioner.attachProjectBusyProbe(busyProbe);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      repaired = true;
      return p;
    });

    await expect(provisioner.repairSandboxForTurn(p.id, 'requesting-session')).resolves.toBe(true);
    expect(busyProbe).toHaveBeenCalledWith(p.id, new Set(['requesting-session']));
    expect(recreate).toHaveBeenCalledOnce();
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
  });

  it('coalesces concurrent turn-time repairs for the same sandbox', async () => {
    const p = await seedActive('turn-repair-race', 'dev-turn-repair-race');
    let repaired = false;
    let finishRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => {
      finishRepair = resolve;
    });
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () =>
      repaired ? migratedInspect(p.id) : legacyInspect(p.id),
    );
    const provisioner = makeProvisioner(client);
    const busyProbe = vi.fn(async () => false);
    provisioner.attachProjectBusyProbe(busyProbe);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      await repairGate;
      repaired = true;
      return p;
    });

    const first = provisioner.repairSandboxForTurn(p.id, 'requesting-session');
    const second = provisioner.repairSandboxForTurn(p.id, 'second-session');
    await vi.waitFor(() => expect(recreate).toHaveBeenCalledOnce());
    finishRepair();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(busyProbe).toHaveBeenCalledWith(p.id, new Set(['requesting-session', 'second-session']));
    expect(recreate).toHaveBeenCalledOnce();
  });

  it('keeps repairing when a new turn queues after the busy probe starts', async () => {
    const p = await seedActive('turn-repair-late-join', 'dev-turn-repair-late-join');
    let repaired = false;
    let inspectBusy!: () => void;
    const busyGate = new Promise<void>((resolve) => {
      inspectBusy = resolve;
    });
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () =>
      repaired ? migratedInspect(p.id) : legacyInspect(p.id),
    );
    const provisioner = makeProvisioner(client);
    const busyProbe = vi.fn(async (_projectId: string, participants?: ReadonlySet<string>) => {
      await busyGate;
      return participants?.has('late-session') !== true;
    });
    provisioner.attachProjectBusyProbe(busyProbe);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      repaired = true;
      return p;
    });

    const repair = provisioner.repairSandboxForTurn(p.id, 'requesting-session');
    await vi.waitFor(() => expect(busyProbe).toHaveBeenCalledOnce());
    const admission = provisioner.waitForTurnSandboxRepair(p.id, 'late-session');
    inspectBusy();

    await expect(repair).resolves.toBe(true);
    await expect(admission).resolves.toBeUndefined();
    expect(recreate).toHaveBeenCalledOnce();
    expect(busyProbe.mock.calls[0]?.[1]).toEqual(new Set(['requesting-session', 'late-session']));
  });

  it('excludes preparation waiters that were busy before repair ownership', async () => {
    const p = await seedActive('turn-repair-prequeued', 'dev-turn-repair-prequeued');
    let repaired = false;
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () =>
      repaired ? migratedInspect(p.id) : legacyInspect(p.id),
    );
    const provisioner = makeProvisioner(client);
    const busyProbe = vi.fn(
      async (_projectId: string, participants?: ReadonlySet<string>) =>
        participants?.has('already-queued-session') !== true,
    );
    provisioner.attachProjectBusyProbe(busyProbe);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      repaired = true;
      return p;
    });

    await expect(
      provisioner.repairSandboxForTurn(
        p.id,
        'requesting-session',
        new Set(['requesting-session', 'already-queued-session']),
      ),
    ).resolves.toBe(true);
    expect(recreate).toHaveBeenCalledOnce();
    expect(busyProbe).toHaveBeenCalledWith(
      p.id,
      new Set(['requesting-session', 'already-queued-session']),
    );
  });

  it('holds new project turns behind an in-flight sandbox repair', async () => {
    const p = await seedActive('turn-repair-admission', 'dev-turn-repair-admission');
    let repaired = false;
    let finishRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => {
      finishRepair = resolve;
    });
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () =>
      repaired ? migratedInspect(p.id) : legacyInspect(p.id),
    );
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      await repairGate;
      repaired = true;
      return p;
    });

    const repair = provisioner.repairSandboxForTurn(p.id, 'requesting-session');
    await vi.waitFor(() => expect(recreate).toHaveBeenCalledOnce());
    expect(provisioner.turnSandboxRepairInFlight(p.id)).toBe(true);
    expect(provisioner.tryBeginProjectSandboxActivity(p.id)).toBe(false);
    let admitted = false;
    const admission = provisioner.waitForTurnSandboxRepair(p.id, 'queued-session').then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    finishRepair();
    await expect(repair).resolves.toBe(true);
    await admission;
    expect(admitted).toBe(true);
    expect(provisioner.turnSandboxRepairInFlight(p.id)).toBe(false);
  });

  it('does not repair while a background sandbox operation is active', async () => {
    const p = await seedActive('turn-background-active', 'dev-turn-background-active');
    const { client } = dockerInspecting({
      'dev-turn-background-active': legacyInspect(p.id),
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer');
    expect(provisioner.tryBeginProjectSandboxActivity(p.id)).toBe(true);

    await expect(provisioner.repairSandboxForTurn(p.id, 'requesting-session')).resolves.toBe(false);
    expect(recreate).not.toHaveBeenCalled();

    provisioner.endProjectSandboxActivity(p.id);
    expect(provisioner.tryBeginProjectSandboxActivity(p.id)).toBe(true);
    provisioner.endProjectSandboxActivity(p.id);
  });

  it('releases queued project turns when the sandbox repair fails', async () => {
    const p = await seedActive('turn-repair-fails', 'dev-turn-repair-fails');
    let failRepair!: () => void;
    const repairGate = new Promise<void>((_resolve, reject) => {
      failRepair = () => reject(new Error('recreate failed'));
    });
    const { client } = dockerInspecting({
      'dev-turn-repair-fails': legacyInspect(p.id),
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      await repairGate;
      return p;
    });

    const repair = provisioner.repairSandboxForTurn(p.id, 'requesting-session');
    await vi.waitFor(() => expect(recreate).toHaveBeenCalledOnce());
    const admission = provisioner.waitForTurnSandboxRepair(p.id, 'queued-session');
    failRepair();

    await expect(repair).rejects.toThrow(/recreate failed/);
    await expect(admission).resolves.toBeUndefined();
  });

  it('does not touch an already-migrated sandbox during turn preparation', async () => {
    const migrated = await seedActive('turn-ready', 'dev-turn-ready');
    const { client } = dockerInspecting({
      'dev-turn-ready': migratedInspect(migrated.id),
    });
    const provisioner = makeProvisioner(client);
    const recreate = vi.spyOn(provisioner, 'recreateContainer');

    await expect(provisioner.repairSandboxForTurn(migrated.id, 'requesting-session')).resolves.toBe(
      true,
    );
    expect(recreate).not.toHaveBeenCalled();
  });

  it('repairs an env-drifted sandbox during turn preparation', async () => {
    // Defence in depth, NOT the production repair path — worth being exact about,
    // because the two read alike. The reconcile tick is what actually fixes a
    // drifted sandbox: the turn gate reaches this method only after its own relay
    // check failed, and that check reads the generation label and relay health,
    // never env, so a sandbox whose only fault is a half env block passes the gate
    // and never arrives here. What this pins is that IF something does route such a
    // container here — a health flap, a future caller — the drift is treated as a
    // reason to rebuild rather than as a healthy sandbox, and on the same budget the
    // reconciler spends. This test calls the method directly and therefore says
    // nothing about which callers reach it.
    const p = await seedActive('turn-drift', 'dev-turn-drift');
    let repaired = false;
    const { client } = dockerInspecting({});
    client.inspectContainer = vi.fn(async () => ({
      ...migratedInspect(p.id),
      env: repaired
        ? [
            'VERITY_CLAUDE_EGRESS_URL=https://relay:8443',
            'VERITY_CLAUDE_EGRESS_AUTHORITY=relay:8443',
            'VERITY_CODEX_EGRESS_URL=https://relay:8444',
            'VERITY_CODEX_EGRESS_AUTHORITY=relay:8444',
          ]
        : ['VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
    }));
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockImplementation(async () => {
      repaired = true;
      return p;
    });

    await expect(provisioner.repairSandboxForTurn(p.id, 'requesting-session')).resolves.toBe(true);
    expect(recreate).toHaveBeenCalledWith(p.id, { confirmWarnings: true });
  });

  it('stops rebuilding a sandbox for turns once the drift budget is spent', async () => {
    // The client is a loop driver too. A session that retries a blocked turn — or an
    // agent that retries by itself — would otherwise destroy and rebuild this project's
    // sandbox on every attempt, which is the reconciler's runaway seen from the other
    // side. So both spend the SAME budget; a budget only one of them respects is none.
    const p = await seedActive('turn-drift-stuck', 'dev-turn-drift-stuck');
    const { client } = dockerInspecting({
      'dev-turn-drift-stuck': {
        ...migratedInspect(p.id),
        env: ['VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);

    for (let turn = 0; turn < ENV_DRIFT_RECREATE_LIMIT + 3; turn++) {
      // Every turn is admitted, before and after the budget runs out. Drift is a
      // one-legged fault: this sandbox reaches its broker and runs Claude, and the
      // Codex turn in it fails on the connector's own 502. Blocking the turn instead
      // would trade a partial outage for a total and permanent one — a project that
      // is never recreated again never classifies `migrated`, so the budget that
      // stopped the churn would also never be given back.
      await expect(provisioner.repairSandboxForTurn(p.id, `session-${String(turn)}`)).resolves.toBe(
        true,
      );
    }
    expect(recreate).toHaveBeenCalledTimes(ENV_DRIFT_RECREATE_LIMIT);
  });

  it('admits a turn into an env-drifted sandbox when the kill switch is off', async () => {
    // The switch's most important property, and the path somebody reaches for during
    // an incident: with drift not a fault, a structurally sound sandbox is `migrated`,
    // so the turn is admitted without the container being touched at all. The Codex
    // leg in it still 502s — that is the trade the switch makes.
    const p = await seedActive('turn-drift-switched-off', 'dev-turn-drift-switched-off');
    const { client } = dockerInspecting({
      'dev-turn-drift-switched-off': {
        ...migratedInspect(p.id),
        env: ['VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client, { recreateEnvDriftedSandboxes: false });
    provisioner.attachProjectBusyProbe(async () => false);
    const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(p);
    await expect(provisioner.repairSandboxForTurn(p.id, 'session-1')).resolves.toBe(true);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('admits a turn into a drifted sandbox it cannot rebuild right now', async () => {
    // Being unable to rebuild is not a worse fault than declining to. Another
    // session's turn holds the container, so this one is not recreated — and a
    // sandbox missing one egress leg is as usable to this turn as it was to that
    // one. The structurally legacy case below still answers `false`, which is the
    // distinction: there the sandbox genuinely cannot serve a turn.
    const p = await seedActive('turn-drift-busy', 'dev-turn-drift-busy');
    const { client } = dockerInspecting({
      'dev-turn-drift-busy': {
        ...migratedInspect(p.id),
        env: ['VERITY_CLAUDE_EGRESS_URL=https://relay:8443'],
      },
    });
    const provisioner = makeProvisioner(client);
    provisioner.attachProjectBusyProbe(async () => true);
    const recreate = vi.spyOn(provisioner, 'recreateContainer');

    await expect(provisioner.repairSandboxForTurn(p.id, 'requesting-session')).resolves.toBe(true);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('does not touch a foreign sandbox during turn preparation', async () => {
    const foreign = await seedActive('turn-foreign', 'dev-turn-foreign');
    const { client } = dockerInspecting({ 'dev-turn-foreign': foreignInspect() });
    const provisioner = makeProvisioner(client);
    const recreate = vi.spyOn(provisioner, 'recreateContainer');

    await expect(provisioner.repairSandboxForTurn(foreign.id, 'requesting-session')).resolves.toBe(
      false,
    );
    expect(recreate).not.toHaveBeenCalled();
  });

  it('does not repair while another session is active in the project sandbox', async () => {
    const p = await seedActive('turn-other-busy', 'dev-turn-other-busy');
    const { client } = dockerInspecting({
      'dev-turn-other-busy': legacyInspect(p.id),
    });
    const provisioner = makeProvisioner(client);
    const busyProbe = vi.fn(async () => true);
    provisioner.attachProjectBusyProbe(busyProbe);
    const recreate = vi.spyOn(provisioner, 'recreateContainer');

    await expect(provisioner.repairSandboxForTurn(p.id, 'requesting-session')).resolves.toBe(false);
    expect(busyProbe).toHaveBeenCalledWith(p.id, new Set(['requesting-session']));
    expect(recreate).not.toHaveBeenCalled();
  });
});

describe('this repository’s own .devcontainer', () => {
  it('is one this provisioner will accept', () => {
    // Verity builds `.devcontainer/` for every session in this repo, and this
    // function is the gate that file passes or fails at provision time. Nothing
    // else reads it earlier: the sandbox workflow docker-builds the Dockerfile
    // and never parses the JSON, so a stray comma or a key from
    // UNSUPPORTED_DEVCONTAINER_RUNTIME_KEYS would take out every session for the
    // repo, discovered only by whoever provisions next.
    //
    // Run through the production function rather than a re-implementation of it:
    // the file is JSONC (it carries comments explaining why those keys are
    // absent), so a test doing `JSON.parse` would fail on a valid file, and one
    // matching key names by regex would not see `remoteUser` given a non-string.
    const dir = join(import.meta.dirname, '..', '..', '..', '.devcontainer');
    expect(existsSync(join(dir, 'devcontainer.json'))).toBe(true);
    expect(unsupportedDevcontainerRuntimeKeys(dir)).toEqual([]);
  });
});
