import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveKeyFromPassword,
  EventStore,
  migrateToLatest,
  TranscriptStore,
  type ProjectRecord,
} from '@verity/store';
import { createEmbeddedDb, createTestDb, truncateAll } from '@verity/store/testing';
import {
  FileTailRunnerClient,
  InMemoryEventBus,
  LoopbackRunnerClient,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  type Backend,
} from '@verity/session';
import type { StreamingRedactorProfile } from '@verity/secret-contracts';

import {
  branchRenameAppliesToSession,
  type EmbeddedServer,
  type EmbeddedServerConfig,
  candidateRunnerProjectIds,
  acpSupervisorWiringRefusal,
  parseByteSize,
  parseCpuCores,
  parseDefaultOnFlag,
  parseNonNegativeInt,
  parseOpenCodeEnabled,
  parsePort,
  parsePushEnabled,
  parseTasksProjectNumber,
  parseTranscriptSweep,
  createProjectAwareGitHubTokenSource,
  refreshProjectGitHubToken,
  createProjectWorktreeFactory,
  buildRunnerConductorWiring,
  runnerAuthorizationProjectId,
  runnerSandboxPath,
  RUNNER_CONTAINER_PROJECT_ROOT,
  readBundledDevcontainerFeature,
  publishedDevcontainerFeatureRef,
  resolveToolkitFeatureRef,
  toolkitFeatureRefIsConfigured,
  normalizeFeatureTag,
  devcontainerBuildOptionsForDockerBaseUrl,
  devcontainerProvisionerOptionsForDockerBaseUrl,
  resolveInstallationListToken,
  resolveRepoWorktreeFetchAuthHeader,
  materializeControlPlaneAgentEnv,
  createProjectTurnPreparationSerializer,
  startClaudeCredentialSync,
  withControlPlaneAgentCredentials,
} from './embedded.js';
import { buildTestEmbeddedServer } from './testing.js';
import {
  startAgentGatewayControlServer,
  type AgentGatewayConfiguration,
} from './agent-gateway-control.js';

describe('project turn preparation admission', () => {
  const backend: Backend = {
    run: vi.fn(async () => ({ sessionId: 's', exitCode: 0, stderr: '', aborted: false })),
  };

  it('serializes foreground preparation and exposes every queued session', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const serialize = createProjectTurnPreparationSerializer({
      waitForRepair: async () => undefined,
      repairInFlight: () => false,
      wrapBackground: (_projectId, selected) => selected,
    });
    let firstWaiters: ReadonlySet<string> | undefined;
    let secondStarted = false;
    const first = serialize('p', 'first', true, async (waiters) => {
      firstWaiters = waiters;
      await firstGate;
      return backend;
    });
    const second = serialize('p', 'second', true, async () => {
      secondStarted = true;
      return backend;
    });
    await vi.waitFor(() => expect(firstWaiters).toBeDefined());
    expect(firstWaiters).toEqual(new Set(['first', 'second']));
    expect(secondStarted).toBe(false);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([backend, backend]);
    expect(secondStarted).toBe(true);
  });

  it('releases the queue when repair admission rejects', async () => {
    let admissions = 0;
    const serialize = createProjectTurnPreparationSerializer({
      waitForRepair: async () => {
        admissions += 1;
        if (admissions === 1) throw new Error('admission failed');
      },
      repairInFlight: () => false,
      wrapBackground: (_projectId, selected) => selected,
    });

    await expect(serialize('p', 'first', true, async () => backend)).rejects.toThrow(
      /admission failed/,
    );
    await expect(serialize('p', 'second', true, async () => backend)).resolves.toBe(backend);
  });

  it('fails background resolution fast while foreground preparation is active', async () => {
    let releaseForeground!: () => void;
    const foregroundGate = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const wrapBackground = vi.fn((_projectId: string, selected: Backend) => selected);
    const serialize = createProjectTurnPreparationSerializer({
      waitForRepair: async () => undefined,
      repairInFlight: () => false,
      wrapBackground,
    });
    const foreground = serialize('p', 'foreground', true, async () => {
      await foregroundGate;
      return backend;
    });

    await expect(serialize('p', 'background', false, async () => backend)).rejects.toThrow(
      /preparation is already in progress/,
    );
    releaseForeground();
    await foreground;
    await expect(serialize('p', 'background', false, async () => backend)).resolves.toBe(backend);
    expect(wrapBackground).toHaveBeenCalledWith('p', backend);
  });
});
import { type GitRunner } from './worktree.js';

const SECRET_JOB_REDACTOR: StreamingRedactorProfile = {
  id: 'redactor-1',
  version: 1,
  implementationDigest: 'd'.repeat(64),
  algorithm: 'byte-longest-first-v1',
  minimumSecretBytes: 4,
  maximumSecretBytes: 4096,
  maximumActiveSecrets: 64,
  maximumInputChunkBytes: 65_536,
  maximumScanComparisons: 8_388_608,
  maximumOutputBytes: 1_048_576,
  replacement: '[REDACTED]',
};

function secretJobsConfig(): NonNullable<EmbeddedServerConfig['secretJobs']> {
  return {
    resolveSecrets: () => Promise.resolve(new Map()),
    authorizeWorkload: () => Promise.resolve(true),
    authorizeCurrentClaims: () => Promise.resolve(true),
    authorizeProviderAdministration: () => Promise.resolve(true),
    redactorProfile: SECRET_JOB_REDACTOR,
    executorImageRepository: 'ghcr.io/heey-global/verity/secret-job-worker',
    createAuthorization: () => ({
      request: () => Promise.resolve({ approvalId: 'approval-1' }),
      decide: () => Promise.resolve({ decision: 'denied' }),
    }),
    authorizeInvocation: () => Promise.resolve(true),
  };
}

function sampleAppProject(): ProjectRecord {
  return {
    id: 'p-sample-app',
    owner: 'Heey-Global',
    repo: 'Deep-OCR',
    containerName: 'dev-example-org--sample-app',
    state: 'active',
    imageRef: null,
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    stateChangedAt: new Date(0),
  };
}

describe('branchRenameAppliesToSession', () => {
  it('withholds the auto branch rename from control-plane sessions', async () => {
    // Their worktree is a plain host directory, so `git rev-parse` there throws and
    // the failure used to reach the operator as an aborted turn.
    await expect(
      branchRenameAppliesToSession({ projectId: 'verity-control' }, async () => ({
        ...sampleAppProject(),
        id: 'verity-control',
        kind: 'control_plane',
      })),
    ).resolves.toBe(false);
  });

  it('still renames for ordinary project and project-less sessions', async () => {
    await expect(
      branchRenameAppliesToSession({ projectId: 'p-sample-app' }, async () => sampleAppProject()),
    ).resolves.toBe(true);
    await expect(
      branchRenameAppliesToSession({ projectId: null }, () => {
        throw new Error('must not look up a project for a project-less session');
      }),
    ).resolves.toBe(true);
  });

  it('renames when the project row is gone (unknown is not control plane)', async () => {
    await expect(
      branchRenameAppliesToSession({ projectId: 'vanished' }, async () => undefined),
    ).resolves.toBe(true);
  });
});

describe('resolveInstallationListToken', () => {
  it('prefers the DB-backed GitHub App token over the static fleet token', async () => {
    await expect(
      resolveInstallationListToken(
        async () => 'db-installation-token',
        () => 'static-fleet-token',
      ),
    ).resolves.toBe('db-installation-token');
  });

  it('falls back to the static fleet token only when no DB-backed App token exists', async () => {
    await expect(
      resolveInstallationListToken(
        async () => undefined,
        () => 'static-fleet-token',
      ),
    ).resolves.toBe('static-fleet-token');
  });
});

describe('resolveRepoWorktreeFetchAuthHeader', () => {
  const b64 = (token: string): string =>
    Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');

  it('prefers a DB-backed GitHub App token for the repo refresh fetch', async () => {
    const seen: Array<{ owner: string; repo: string }> = [];

    await expect(
      resolveRepoWorktreeFetchAuthHeader(
        async () => ({ owner: 'Heey-Global', repo: 'Verity' }),
        async (repo) => {
          seen.push(repo);
          return 'db-repo-token';
        },
        () => 'static-fleet-token',
      ),
    ).resolves.toBe(`Authorization: Basic ${b64('db-repo-token')}`);

    expect(seen).toEqual([{ owner: 'Heey-Global', repo: 'Verity' }]);
  });

  it('falls back to the fleet token when the DB-backed mint is unavailable', async () => {
    await expect(
      resolveRepoWorktreeFetchAuthHeader(
        async () => ({ owner: 'Heey-Global', repo: 'Verity' }),
        async () => undefined,
        () => 'static-fleet-token',
      ),
    ).resolves.toBe(`Authorization: Basic ${b64('static-fleet-token')}`);
  });

  it('omits the auth header when no repo identity or fallback token exists', async () => {
    await expect(
      resolveRepoWorktreeFetchAuthHeader(
        async () => null,
        async () => 'unused',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('parsePort', () => {
  it('defaults when unset and parses a valid port', () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort(undefined, 9000)).toBe(9000);
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('0')).toBe(0);
  });

  it('rejects non-integer / out-of-range values loudly (no silent random-port bind)', () => {
    expect(() => parsePort('foo')).toThrow(/invalid PORT/);
    expect(() => parsePort('80.5')).toThrow(/invalid PORT/);
    expect(() => parsePort('70000')).toThrow(/invalid PORT/);
    expect(() => parsePort('-1')).toThrow(/invalid PORT/);
  });
});

describe('parsePushEnabled', () => {
  it('defaults to enabled without a server credential or flag', () => {
    expect(parsePushEnabled(undefined)).toBe(true);
    expect(parsePushEnabled('')).toBe(true);
    expect(parsePushEnabled('  ')).toBe(true);
  });

  it.each(['0', 'false', 'off', ' FALSE ', ' Off '])('treats %j as disabled', (value) => {
    expect(parsePushEnabled(value)).toBe(false);
  });

  it.each(['1', 'true', 'on'])('treats %j as enabled', (value) => {
    expect(parsePushEnabled(value)).toBe(true);
  });

  it('rejects unknown values instead of silently enabling push', () => {
    expect(() => parsePushEnabled('of')).toThrow(/VERITY_PUSH_ENABLED/);
  });
});

describe('parseDefaultOnFlag', () => {
  // The shape `parsePushEnabled` was generalised out of, now shared by every
  // default-on kill switch. It names the variable in its own error so a second
  // caller's typo does not report itself as a push misconfiguration.
  it('names the flag it was asked about, not the one it grew out of', () => {
    expect(() => parseDefaultOnFlag('maybe', 'VERITY_RECREATE_ENV_DRIFTED_SANDBOXES')).toThrow(
      /VERITY_RECREATE_ENV_DRIFTED_SANDBOXES/,
    );
  });

  it('leaves an unset flag on', () => {
    expect(parseDefaultOnFlag(undefined, 'VERITY_ANY')).toBe(true);
  });

  // Pinned on the shared function rather than only through the `parsePushEnabled`
  // wrapper: a second caller is a second contract, and "which spellings turn an
  // emergency switch off" is the one thing an operator gets exactly one try at.
  it.each(['1', 'true', 'on', '', '  '])('reads %j as on', (value) => {
    expect(parseDefaultOnFlag(value, 'VERITY_ANY')).toBe(true);
  });

  it.each(['0', 'false', 'off', ' FALSE ', 'Off'])('reads %j as off', (value) => {
    expect(parseDefaultOnFlag(value, 'VERITY_ANY')).toBe(false);
  });
});

describe('candidateRunnerProjectIds', () => {
  // Which runtimes a session's transcripts may sit in, and therefore which ones the
  // delete-time purge has to search. Getting this wrong leaves a conversation on disk
  // after the operator deleted the session — silently, since a purge that finds nothing
  // looks exactly like one with nothing to find.

  it('searches the session’s own project runtime', () => {
    expect(
      candidateRunnerProjectIds({
        projectId: 'proj-1',
        isControlPlaneProject: false,
        controlPlaneRunner: false,
      }),
    ).toEqual(['proj-1']);
  });

  it('searches BOTH runtimes for a control-plane project', () => {
    // Only `claude-acp` turns of such a project run on the shared `verity-control`
    // runtime; a codex turn of the same session stays under its own project id. Both
    // files therefore exist, and searching one runtime would leak the other.
    expect(
      candidateRunnerProjectIds({
        projectId: 'persisted-control',
        isControlPlaneProject: true,
        controlPlaneRunner: true,
      }),
    ).toEqual(['persisted-control', 'verity-control']);
  });

  it('searches only the control-plane runtime for a project-less session', () => {
    expect(
      candidateRunnerProjectIds({
        projectId: null,
        isControlPlaneProject: false,
        controlPlaneRunner: true,
      }),
    ).toEqual(['verity-control']);
  });

  it('finds nothing to search for a project-less session without that runner', () => {
    // Such a session gets the loopback runner, which writes no runner-runtime files at
    // all — so an empty answer here is the correct one, not a missed case.
    expect(
      candidateRunnerProjectIds({
        projectId: null,
        isControlPlaneProject: false,
        controlPlaneRunner: false,
      }),
    ).toEqual([]);
  });

  it('ignores the control-plane runtime for an ordinary project', () => {
    expect(
      candidateRunnerProjectIds({
        projectId: 'proj-1',
        isControlPlaneProject: false,
        controlPlaneRunner: true,
      }),
    ).toEqual(['proj-1']);
  });
});

describe('parseTranscriptSweep', () => {
  it('sweeps unless a deployment says otherwise', () => {
    expect(parseTranscriptSweep(undefined)).toBe('on');
    expect(parseTranscriptSweep('')).toBe('on');
    expect(parseTranscriptSweep('  ')).toBe('on');
    expect(parseTranscriptSweep(' ON ')).toBe('on');
  });

  it.each([
    ['dry', 'dry'],
    [' Dry ', 'dry'],
    ['off', 'off'],
    ['OFF', 'off'],
  ])('reads %j as %j', (value, expected) => {
    expect(parseTranscriptSweep(value)).toBe(expected);
  });

  it.each([
    ['0', 'off'],
    ['false', 'off'],
    ['FALSE', 'off'],
    ['1', 'on'],
    ['true', 'on'],
  ])('takes the boolean spelling %j as %j', (value, expected) => {
    // Same env file as VERITY_PUSH_ENABLED, which teaches 1/true/on and 0/false/off.
    // Someone shutting the sweep off in a hurry writes what that one taught them, and a
    // boot that crash-loops on `false` is the same accident the throw below prevents.
    expect(parseTranscriptSweep(value)).toBe(expected);
  });

  it('rejects a typo rather than sweeping anyway', () => {
    // This variable is only ever set to STOP the sweep from deleting something. Falling
    // back to `on` would defeat the single purpose it has.
    expect(() => parseTranscriptSweep('of')).toThrow(/VERITY_TRANSCRIPT_SWEEP/);
    expect(() => parseTranscriptSweep('no')).toThrow(/VERITY_TRANSCRIPT_SWEEP/);
  });
});

describe('parseOpenCodeEnabled', () => {
  it('is off unless a deployment opts in', () => {
    expect(parseOpenCodeEnabled({ enabled: undefined, legacyBaseUrl: undefined })).toBe(false);
    expect(parseOpenCodeEnabled({ enabled: '0', legacyBaseUrl: undefined })).toBe(false);
    expect(parseOpenCodeEnabled({ enabled: '1', legacyBaseUrl: undefined })).toBe(true);
    expect(parseOpenCodeEnabled({ enabled: 'true', legacyBaseUrl: undefined })).toBe(true);
  });

  it('takes the usual spellings and refuses the ones it cannot read', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'On'])
      expect(parseOpenCodeEnabled({ enabled: on, legacyBaseUrl: undefined })).toBe(true);
    for (const off of ['0', 'false', 'No', 'OFF', ''])
      expect(parseOpenCodeEnabled({ enabled: off, legacyBaseUrl: undefined })).toBe(false);
    // A typo reading as "off" is the same silent failure the legacy-variable refusal
    // above exists to prevent, one variable over: the deployment sets the flag, boots
    // clean, and discovers at the first OpenCode turn that the route was never on.
    expect(() => parseOpenCodeEnabled({ enabled: 'ture', legacyBaseUrl: undefined })).toThrow(
      /VERITY_OPENCODE_ENABLED/,
    );
  });

  it('refuses to boot on the retired OPENCODE_BASE_URL alone', () => {
    // The pre-ACP deployment shape. Booting would leave every stored provider/model id
    // routing to Claude, so the upgrade has to be noticed at boot, not per turn.
    expect(() =>
      parseOpenCodeEnabled({ enabled: undefined, legacyBaseUrl: 'http://opencode:4096' }),
    ).toThrow(/VERITY_OPENCODE_ENABLED/);
  });

  it('ignores a blank OPENCODE_BASE_URL', () => {
    // An env file that keeps the key with an empty value is not a deployment pointing at
    // a server; failing that boot would be a migration hazard of its own.
    expect(parseOpenCodeEnabled({ enabled: undefined, legacyBaseUrl: '  ' })).toBe(false);
  });

  it('warns instead of refusing once the new flag is set', () => {
    const warnings: string[] = [];
    expect(
      parseOpenCodeEnabled({ enabled: '1', legacyBaseUrl: 'http://opencode:4096' }, (message) =>
        warnings.push(message),
      ),
    ).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/OPENCODE_BASE_URL is ignored/);
  });

  it('does not read a declared-empty flag as that acknowledgement', () => {
    // `VERITY_OPENCODE_ENABLED=${SOMETHING_UNSET}` is what env plumbing produces when
    // the value it meant to pass is missing, so an empty flag is silence rather than a
    // decision — and silence beside the retired variable is the case the refusal
    // exists for. It says which spelling means "off", so an operator who did mean it
    // is one character away rather than guessing.
    expect(() =>
      parseOpenCodeEnabled({ enabled: '', legacyBaseUrl: 'http://opencode:4096' }),
    ).toThrow(/VERITY_OPENCODE_ENABLED=0 also clears this/);
  });

  it('accepts an explicit off as the same acknowledgement', () => {
    // The refusal asks for one of two answers, and "drop OpenCode" is one of them.
    // A deployment that has said so in the new variable has read the message; still
    // refusing its boot over the dead one would be holding it hostage to an env
    // edit that changes nothing about how it runs.
    const warnings: string[] = [];
    expect(
      parseOpenCodeEnabled({ enabled: '0', legacyBaseUrl: 'http://opencode:4096' }, (message) =>
        warnings.push(message),
      ),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/OPENCODE_BASE_URL is ignored/);
    // The remedy has a cost the operator has to hear about once, here: with no
    // OpenCode backend configured the conductor routes a provider-qualified model to
    // Claude, which does not know it, so sessions already on such a model stop
    // running until someone picks a different one.
    expect(warnings[0]).toMatch(/fail their next turn/);
  });

  it('says what dropping OpenCode costs in the refusal too', () => {
    // Same fact on the other path: the refusal recommends "unset it alone to drop
    // OpenCode" as one of its two remedies, and an operator choosing it from this
    // message should not learn about the stranded sessions from a red turn.
    expect(() =>
      parseOpenCodeEnabled({ enabled: undefined, legacyBaseUrl: 'http://opencode:4096' }),
    ).toThrow(/their next turn fails until another model is picked/);
  });
});

describe('acpSupervisorWiringRefusal', () => {
  // `opencode-acp` joins the list with ADR 0012 Amendment 4, and with it a new
  // prerequisite: a deployment that enabled OpenCode on the retired HTTP transport
  // needed no runner supervisor at all, and now needs the same complete wiring the
  // other two do. Refusing the turn is the intended answer — the loopback would
  // start an ACP adapter inside the credential-bearing Server.
  it.each(['claude-acp', 'codex-acp', 'opencode-acp'])(
    'fails %s closed without complete wiring',
    (backend) => {
      expect(
        acpSupervisorWiringRefusal({
          runnerSupervisorBackend: backend,
          runnerSupervisor: false,
          dataVolumeRootAvailable: true,
          dockerAvailable: true,
          cloneRootAvailable: true,
        }),
      ).toMatch(/requires complete runner supervisor wiring/);
    },
  );

  it('allows supervised ACP backends', () => {
    const wiring = {
      runnerSupervisor: true,
      dataVolumeRootAvailable: true,
      dockerAvailable: true,
      cloneRootAvailable: true,
    };
    expect(acpSupervisorWiringRefusal({ runnerSupervisorBackend: 'codex-acp', ...wiring })).toBe(
      undefined,
    );
  });
});

describe('sandbox hardening env parsers (C1)', () => {
  it('parseNonNegativeInt: unset → undefined, valid → number, invalid throws', () => {
    expect(parseNonNegativeInt(undefined)).toBeUndefined();
    expect(parseNonNegativeInt('')).toBeUndefined();
    expect(parseNonNegativeInt('512')).toBe(512);
    expect(parseNonNegativeInt('0')).toBe(0);
    expect(() => parseNonNegativeInt('-1')).toThrow(/non-negative integer/);
    expect(() => parseNonNegativeInt('1.5')).toThrow(/non-negative integer/);
  });

  it('parseByteSize: byte count and k/m/g/t suffixes → bytes', () => {
    expect(parseByteSize(undefined)).toBeUndefined();
    expect(parseByteSize('1048576')).toBe(1024 ** 2);
    expect(parseByteSize('512m')).toBe(512 * 1024 ** 2);
    expect(parseByteSize('4g')).toBe(4 * 1024 ** 3);
    expect(parseByteSize('2gb')).toBe(2 * 1024 ** 3);
    expect(() => parseByteSize('lots')).toThrow(/invalid byte size/);
    expect(() => parseByteSize('999999999999999999999t')).toThrow(/supported range/);
    expect(() => parseByteSize('0')).toThrow(/supported range/);
  });

  it('parseCpuCores: cores → nano-CPUs, invalid throws', () => {
    expect(parseCpuCores(undefined)).toBeUndefined();
    expect(parseCpuCores('1')).toBe(1_000_000_000);
    expect(parseCpuCores('1.5')).toBe(1_500_000_000);
    expect(() => parseCpuCores('0')).toThrow(/positive number of cores/);
    expect(() => parseCpuCores('nope')).toThrow(/positive number of cores/);
  });
});

describe('parseTasksProjectNumber (ADR 0007)', () => {
  it('is undefined when unset/empty (feature stays off) and parses a positive board number', () => {
    expect(parseTasksProjectNumber(undefined)).toBeUndefined();
    expect(parseTasksProjectNumber('')).toBeUndefined();
    expect(parseTasksProjectNumber('  ')).toBeUndefined();
    expect(parseTasksProjectNumber('7')).toBe(7);
  });

  it('rejects non-positive / non-integer values loudly (no silently-disabled feature)', () => {
    expect(() => parseTasksProjectNumber('0')).toThrow(/VERITY_TASKS_PROJECT_NUMBER/);
    expect(() => parseTasksProjectNumber('-1')).toThrow(/VERITY_TASKS_PROJECT_NUMBER/);
    expect(() => parseTasksProjectNumber('1.5')).toThrow(/VERITY_TASKS_PROJECT_NUMBER/);
    expect(() => parseTasksProjectNumber('foo')).toThrow(/VERITY_TASKS_PROJECT_NUMBER/);
  });
});

describe('createProjectAwareGitHubTokenSource', () => {
  it('prefers the project-local token for project session worktrees', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-project-pr-token-'));
    try {
      const projectRoot = join(root, 'example-org-sample-app');
      const worktree = join(projectRoot, '.verity-sessions', 'agent-abc');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(projectRoot, '.gh-token'), 'project-token\n');

      const token = createProjectAwareGitHubTokenSource(worktree, 'global-token');

      expect(token()).toBe('project-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back when the project-local token file is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-project-empty-pr-token-'));
    try {
      const projectRoot = join(root, 'example-org-sample-app');
      const worktree = join(projectRoot, '.verity-sessions', 'agent-abc');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(projectRoot, '.gh-token'), '\n');

      const token = createProjectAwareGitHubTokenSource(worktree, 'global-token');

      expect(token()).toBe('global-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the global token outside project worktrees', () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-global-pr-token-'));
    try {
      const repo = join(root, 'verity');
      mkdirSync(repo, { recursive: true });

      const token = createProjectAwareGitHubTokenSource(repo, () => 'global-token\n');

      expect(token()).toBe('global-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('refreshProjectGitHubToken', () => {
  it('re-mints the project token WITHOUT writing any .gh-token file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-token-refresh-'));
    try {
      const repoDir = join(root, 'Heey-Global-Deep-OCR');
      mkdirSync(repoDir, { recursive: true });
      const project = sampleAppProject();
      const mint = vi.fn(async () => 'fresh-project-token');

      await refreshProjectGitHubToken(project, mint);

      // The mint is exercised (warms the cache / surfaces App-not-configured)...
      expect(mint).toHaveBeenCalledWith(project);
      // ...but nothing is written into the clone dir (the sandbox uses the broker).
      expect(existsSync(join(repoDir, '.gh-token'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op on disk even when minting yields no token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-token-refresh-empty-'));
    try {
      const repoDir = join(root, 'Heey-Global-Deep-OCR');
      mkdirSync(repoDir, { recursive: true });
      const project = sampleAppProject();

      await refreshProjectGitHubToken(project, async () => undefined);
      await refreshProjectGitHubToken(project, async () => '');
      expect(existsSync(join(repoDir, '.gh-token'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createProjectWorktreeFactory', () => {
  // A writable clone dir (the factory `mkdir`s `<clone>/.verity-sessions`).
  let clone: string;
  beforeEach(() => {
    clone = mkdtempSync(join(tmpdir(), 'verity-project-wt-'));
  });
  afterEach(() => {
    rmSync(clone, { recursive: true, force: true });
  });

  const b64 = (token: string): string =>
    Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');

  it('produces a provisioner whose refreshBase fetch carries the minted project token', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const factory = createProjectWorktreeFactory(async () => 'secret-project-token');
    const provisioner = factory(sampleAppProject(), clone, { refreshBase: true, git });

    await provisioner.add('agent/wired');

    const fetch = calls.find((c) => c.includes('fetch'));
    expect(fetch).toBeDefined();
    // The fetch authenticates with the project-scoped token via `-c
    // http.extraheader` (built from `gitAuthHeader`), not the container's narrow
    // global git credential.
    expect(fetch).toEqual([
      '-C',
      clone,
      '-c',
      `http.extraheader=Authorization: Basic ${b64('secret-project-token')}`,
      'fetch',
      'origin',
      'HEAD',
    ]);
    // Worktrees are rooted under the project clone's `.verity-sessions`.
    const add = calls.find((c) => c.includes('worktree') && c.includes('add'));
    expect(add?.[4]).toContain(join(clone, '.verity-sessions'));
  });

  it('mints the token FRESH per add (rotated short-TTL token), scoped to the project', async () => {
    const seen: Array<Pick<ProjectRecord, 'owner' | 'repo'>> = [];
    let n = 0;
    const factory = createProjectWorktreeFactory(async (project) => {
      seen.push({ owner: project.owner, repo: project.repo });
      return `tok-${n++}`;
    });
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const provisioner = factory(sampleAppProject(), clone, { refreshBase: true, git });

    await provisioner.add('agent/one');
    await provisioner.add('agent/two');

    expect(seen).toEqual([
      { owner: 'Heey-Global', repo: 'Deep-OCR' },
      { owner: 'Heey-Global', repo: 'Deep-OCR' },
    ]);
    const fetches = calls.filter((c) => c.includes('fetch'));
    expect(fetches[0]?.join(' ')).toContain(
      `http.extraheader=Authorization: Basic ${b64('tok-0')}`,
    );
    expect(fetches[1]?.join(' ')).toContain(
      `http.extraheader=Authorization: Basic ${b64('tok-1')}`,
    );
  });

  it('runs the fetch tokenless when the mint yields no token', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const factory = createProjectWorktreeFactory(async () => undefined);
    const provisioner = factory(sampleAppProject(), clone, { refreshBase: true, git });

    await provisioner.add('agent/notoken');

    const fetch = calls.find((c) => c.includes('fetch'));
    expect(fetch).toEqual(['-C', clone, 'fetch', 'origin', 'HEAD']);
    expect(fetch).not.toContain('-c');
  });

  it('fetches tokenless when minting is unavailable (no .gh-token file fallback)', async () => {
    // A stale clone-dir .gh-token must NOT be read anymore — it would sit in /work.
    writeFileSync(join(clone, '.gh-token'), 'persisted-project-token\n', { mode: 0o600 });
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const factory = createProjectWorktreeFactory(async () => undefined);
    const provisioner = factory(sampleAppProject(), clone, { refreshBase: true, git });

    await provisioner.add('agent/filetoken');

    const fetch = calls.find((c) => c.includes('fetch'));
    // No http.extraheader (tokenless) — the persisted file is ignored.
    expect(fetch?.some((a) => a.includes('http.extraheader'))).toBe(false);
    expect(fetch?.some((a) => a.includes('persisted-project-token'))).toBe(false);
  });
});

describe('readBundledDevcontainerFeature (R3.1/#299)', () => {
  const ORIG = process.env.VERITY_FEATURE_DIR;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VERITY_FEATURE_DIR;
    else process.env.VERITY_FEATURE_DIR = ORIG;
  });

  it('parses the bundled Feature version + returns ref, version, and content identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-feature-ok-'));
    try {
      writeFileSync(
        join(dir, 'devcontainer-feature.json'),
        JSON.stringify({ id: 'verity-sandbox-toolkit', version: '1.2.3' }),
      );
      process.env.VERITY_FEATURE_DIR = dir;
      expect(readBundledDevcontainerFeature()).toEqual({
        ref: dir,
        version: '1.2.3',
        identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes the bundled Feature identity when Feature content changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-feature-identity-'));
    try {
      process.env.VERITY_FEATURE_DIR = dir;
      writeFileSync(
        join(dir, 'devcontainer-feature.json'),
        JSON.stringify({ id: 'verity-sandbox-toolkit', version: '1.2.3' }),
      );
      const before = readBundledDevcontainerFeature()?.identity;
      writeFileSync(join(dir, 'install.sh'), '#!/usr/bin/env bash\n');
      const after = readBundledDevcontainerFeature()?.identity;

      expect(before).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(after).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(after).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined (no throw) when the Feature manifest is absent — the dev/test/non-Server case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-feature-absent-'));
    try {
      // Directory exists but holds no devcontainer-feature.json.
      process.env.VERITY_FEATURE_DIR = dir;
      expect(readBundledDevcontainerFeature()).toBeUndefined();
      // And when the dir itself doesn't exist.
      process.env.VERITY_FEATURE_DIR = join(dir, 'nope');
      expect(readBundledDevcontainerFeature()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined (no throw) on malformed JSON or a missing version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-feature-bad-'));
    try {
      process.env.VERITY_FEATURE_DIR = dir;
      writeFileSync(join(dir, 'devcontainer-feature.json'), '{ not json');
      expect(readBundledDevcontainerFeature()).toBeUndefined();
      writeFileSync(
        join(dir, 'devcontainer-feature.json'),
        JSON.stringify({ id: 'verity-sandbox-toolkit' }),
      );
      expect(readBundledDevcontainerFeature()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('publishedDevcontainerFeatureRef (R3.1/#299)', () => {
  const ORIG = process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    else process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = ORIG;
  });

  it('defaults project devcontainer builds to the published GHCR toolkit Feature (bare semver tag)', () => {
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;

    expect(publishedDevcontainerFeatureRef()).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
    });
  });

  it('strips a leading `v` from the tag — the `v`-prefixed tag is not a resolvable Feature manifest', () => {
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF =
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit:v1.11.6';

    expect(publishedDevcontainerFeatureRef()).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.11.6',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.11.6',
    });
  });

  it('uses an explicit Feature ref as the build input and cache identity', () => {
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF =
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123';

    expect(publishedDevcontainerFeatureRef()).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123',
    });
  });

  it('rejects :latest toolkit refs because update status needs pinned targets', () => {
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF =
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit:latest';

    expect(() => publishedDevcontainerFeatureRef()).toThrow(
      /VERITY_SANDBOX_TOOLKIT_FEATURE_REF must be pinned/,
    );
  });

  it('can be disabled explicitly for tests or alternate deployments', () => {
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = '   ';

    expect(publishedDevcontainerFeatureRef()).toBeUndefined();
  });
});

describe('normalizeFeatureTag', () => {
  it('strips a leading `v` from a semver tag', () => {
    expect(normalizeFeatureTag('ghcr.io/x/toolkit:v1.14.0')).toBe('ghcr.io/x/toolkit:1.14.0');
  });
  it('leaves a bare semver tag untouched', () => {
    expect(normalizeFeatureTag('ghcr.io/x/toolkit:1.14.0')).toBe('ghcr.io/x/toolkit:1.14.0');
  });
  it('leaves digest pins and tagless refs untouched', () => {
    expect(normalizeFeatureTag('ghcr.io/x/toolkit@sha256:abc')).toBe(
      'ghcr.io/x/toolkit@sha256:abc',
    );
    expect(normalizeFeatureTag('ghcr.io/x/toolkit')).toBe('ghcr.io/x/toolkit');
  });
  it('does not treat a non-version tag beginning with v as a v-prefix', () => {
    expect(normalizeFeatureTag('ghcr.io/x/toolkit:vintage')).toBe('ghcr.io/x/toolkit:vintage');
  });
});

describe('resolveToolkitFeatureRef (devcontainer build key)', () => {
  const ORIG = process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
  const ORIG_FEATURE_DIR = process.env.VERITY_FEATURE_DIR;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    else process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = ORIG;
    if (ORIG_FEATURE_DIR === undefined) delete process.env.VERITY_FEATURE_DIR;
    else process.env.VERITY_FEATURE_DIR = ORIG_FEATURE_DIR;
  });

  it('pins the GHCR Feature to the BAKED bundle version under its bare semver tag (not the local path)', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.0',
      identity: 'sha256:abc',
    };
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;

    expect(resolveToolkitFeatureRef(bundled)).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.0',
      version: '1.14.0',
      identity: 'sha256:abc',
    });
  });

  it('normalizes a v-prefixed bundle version to the bare tag', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: 'v1.14.0',
      identity: 'sha256:abc',
    };
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;

    expect(resolveToolkitFeatureRef(bundled)?.ref).toBe(
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.0',
    );
  });

  it('keeps the repo from an explicit VERITY_SANDBOX_TOOLKIT_FEATURE_REF override', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.0',
      identity: 'sha256:abc',
    };
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = 'ghcr.io/acme/toolkit:v1.0.0';

    expect(resolveToolkitFeatureRef(bundled)?.ref).toBe('ghcr.io/acme/toolkit:1.14.0');
  });

  it('keeps the bundle in charge when the digest was resolved by this Server, not configured', () => {
    // The production wiring: no env var, so `main.ts` walked `:latest` back to a
    // digest and handed it over. That digest is NOT an operator pin, and letting
    // it win would inject a toolkit this Server cannot attest against.
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.11',
      identity: 'sha256:bundle',
    };
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    const resolvedDigest = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123';

    expect(
      resolveToolkitFeatureRef(bundled, {
        ref: resolvedDigest,
        version: 'published',
        identity: resolvedDigest,
      }),
    ).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.11',
      version: '1.14.11',
      identity: 'sha256:bundle',
    });
  });

  it('honors an explicit digest ref even when a newer bundle is present', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.11',
      identity: 'sha256:bundle',
    };
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF =
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123';

    expect(resolveToolkitFeatureRef(bundled)).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123',
    });
  });

  it('falls back to the published ref when the bundle has the managed source placeholder version', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '0.0.0-managed',
      identity: 'sha256:bundle',
    };
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;

    expect(resolveToolkitFeatureRef(bundled)).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
    });
  });

  it('falls back to the published ref when no bundle is present (dev/test hosts)', () => {
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    process.env.VERITY_FEATURE_DIR = join(tmpdir(), 'missing-verity-feature-dir');

    expect(resolveToolkitFeatureRef()).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
      version: 'published',
      identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
    });
  });

  it('takes provenance from the caller when one is passed, not from the env', () => {
    // An embedder that configures a digest through `buildEmbeddedServer` and
    // never sets the env var must still outrank the bundle — and one that only
    // hands over a ref it resolved itself must not.
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.11',
      identity: 'sha256:bundle',
    };
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    const digest = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:abc123';
    const published = { ref: digest, version: 'published', identity: digest };

    expect(resolveToolkitFeatureRef(bundled, published, true)?.ref).toBe(digest);
    expect(resolveToolkitFeatureRef(bundled, published, false)?.ref).toBe(
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.11',
    );
  });

  it('reads operator configuration from the env var alone', () => {
    expect(toolkitFeatureRefIsConfigured(undefined)).toBe(false);
    expect(toolkitFeatureRefIsConfigured('   ')).toBe(false);
    expect(toolkitFeatureRefIsConfigured('ghcr.io/acme/toolkit:1.0.0')).toBe(true);
  });

  it('honors an explicit disable (blank env) even when a bundle is present', () => {
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.0',
      identity: 'sha256:abc',
    };
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = '   ';

    expect(resolveToolkitFeatureRef(bundled)).toBeUndefined();
  });

  it('keeps the Feature on a stock deployment, where the env var is set but blank', () => {
    // `deploy/docker-compose.yml` always exports the variable, empty by default,
    // so blank is what a normal install looks like — not an opt-out. `main.ts`
    // turns that blank into a resolved digest and reports it as UNconfigured;
    // reproduce both halves here, because the disable path above is one trimmed
    // string away and would silently strip the toolkit from every deployment.
    const bundled = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.14.0',
      identity: 'sha256:abc',
    };
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = '';
    const resolved = publishedDevcontainerFeatureRef(
      'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:resolved',
    );

    expect(
      resolveToolkitFeatureRef(
        bundled,
        resolved,
        toolkitFeatureRefIsConfigured(process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF),
      ),
    ).toEqual({
      ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.0',
      version: '1.14.0',
      identity: 'sha256:abc',
    });
  });

  it('wires embedded server provisioning through the bundled Feature reader', () => {
    const source = readFileSync('packages/server/src/embedded.ts', 'utf8');

    expect(source).not.toContain('resolveToolkitFeatureRef(\n            undefined,');
    expect(source).not.toContain('resolveToolkitFeatureRef(\n          undefined,');
    expect(source).toContain(
      'resolveToolkitFeatureRef(\n            readBundledDevcontainerFeature(),',
    );
    expect(source).toContain(
      'resolveToolkitFeatureRef(\n          readBundledDevcontainerFeature(),',
    );
  });
});

describe('devcontainerBuildOptionsForDockerBaseUrl (R3.1/#299)', () => {
  const ORIG = process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    else process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = ORIG;
  });

  it('wires the real devcontainer build spawner to the same Docker daemon', () => {
    expect(
      devcontainerBuildOptionsForDockerBaseUrl('unix:///var/run/docker.sock:/v1.41')
        .dockerHostForBuild,
    ).toBe('unix:///var/run/docker.sock');
    expect(
      devcontainerBuildOptionsForDockerBaseUrl('http://docker-socket-proxy:2375/v1.41')
        .dockerHostForBuild,
    ).toBe('tcp://docker-socket-proxy:2375');
    expect(
      typeof devcontainerBuildOptionsForDockerBaseUrl('unix:///var/run/docker.sock')
        .devcontainerBuild,
    ).toBe('function');
  });

  it('passes the published toolkit feature by default and allows explicit opt-out', () => {
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
    expect(devcontainerProvisionerOptionsForDockerBaseUrl('unix:///var/run/docker.sock')).toEqual({
      devcontainerBuild: expect.any(Function),
      dockerHostForBuild: 'unix:///var/run/docker.sock',
      devcontainerFeature: {
        ref: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
        version: 'published',
        identity: 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.14.1',
      },
    });
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF = '   ';
    expect(devcontainerProvisionerOptionsForDockerBaseUrl('unix:///var/run/docker.sock')).toEqual({
      devcontainerBuild: expect.any(Function),
      dockerHostForBuild: 'unix:///var/run/docker.sock',
    });
    delete process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF;
  });

  it('still accepts an explicit toolkit feature ref for tests and alternate layouts', () => {
    const feature = {
      ref: '/opt/verity-features/verity-sandbox-toolkit',
      version: '1.2.3',
      identity: 'sha256:toolkit-v1',
    };
    expect(
      devcontainerProvisionerOptionsForDockerBaseUrl('unix:///var/run/docker.sock', feature),
    ).toEqual({
      devcontainerBuild: expect.any(Function),
      dockerHostForBuild: 'unix:///var/run/docker.sock',
      devcontainerFeature: feature,
    });
  });
});

describe('control-plane agent credentials', () => {
  it('isolates provider homes and clears legacy credential files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    try {
      mkdirSync(join(root, 'claude'), { recursive: true });
      mkdirSync(join(root, 'codex'), { recursive: true });
      writeFileSync(join(root, 'claude', '.credentials.json'), 'legacy-refresh-secret');
      writeFileSync(join(root, 'codex', 'auth.json'), 'legacy-codex-secret');
      const env = await materializeControlPlaneAgentEnv(root);

      expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude'));
      expect(readFileSync(join(root, 'claude', '.credentials.json'), 'utf8')).toBe('');
      expect(env.CODEX_HOME).toBe(join(root, 'codex'));
      expect(readFileSync(join(root, 'codex', 'auth.json'), 'utf8')).toBe('');

      await materializeControlPlaneAgentEnv(root);
      expect(readFileSync(join(root, 'claude', '.credentials.json'), 'utf8')).toBe('');
      expect(readFileSync(join(root, 'codex', 'auth.json'), 'utf8')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses signing with an explanation while real verification still works', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    try {
      const env = await materializeControlPlaneAgentEnv(root, {});
      const signer = env.GIT_CONFIG_VALUE_0;
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('gpg.ssh.program');
      expect(signer).toBe(join(root, 'git', 'control-plane-git-sign'));

      // Signing is refused, and the message names the actual cause rather than a
      // missing key — that wording is what stops the next session from hunting for
      // another key or committing through the API.
      const refused = spawnSync(signer!, ['-Y', 'sign', '-n', 'git', '-f', 'key.pub', 'payload'], {
        encoding: 'utf8',
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('cannot sign commits');
      expect(refused.stderr).toContain('project session');

      // Everything else must reach the real ssh-keygen: git drives signing AND
      // verification through this one program, so refusing wholesale would break
      // reading signed history. Verify a genuine signature THROUGH the wrapper.
      const key = join(root, 'id_ed25519');
      const payload = join(root, 'payload');
      writeFileSync(payload, 'commit buffer\n');
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
      execFileSync('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', key, payload]);
      const verified = spawnSync(
        signer!,
        ['-Y', 'check-novalidate', '-n', 'git', '-f', `${key}.pub`, '-s', `${payload}.sig`],
        { encoding: 'utf8', input: readFileSync(payload, 'utf8') },
      );
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('Good "git" signature');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the signer executable through concurrent materialization', async () => {
    // Every control-plane session writes this same path. A truncate-then-write
    // would let a session starting mid-write execute an empty script, so the
    // refusal — and verification with it — would fail at random.
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    try {
      const envs = await Promise.all(
        Array.from({ length: 8 }, () => materializeControlPlaneAgentEnv(root, {})),
      );
      const signer = envs[0]?.GIT_CONFIG_VALUE_0 ?? '';
      expect(new Set(envs.map((env) => env.GIT_CONFIG_VALUE_0))).toEqual(new Set([signer]));

      const refused = spawnSync(signer, ['-Y', 'sign', '-n', 'git', '-f', 'k.pub', 'p'], {
        encoding: 'utf8',
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('cannot sign commits');
      // No staging file survives to be picked up as a stray executable.
      expect(readdirSync(join(root, 'git'))).toEqual(['control-plane-git-sign']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends against the per-call environment, not just the process one', async () => {
    // `withControlPlaneAgentCredentials` layers the caller's `env` between
    // `process.env` and what it loads. Counting only the process env would let a
    // backend-supplied git config list be silently truncated by the count we set.
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      const inner = {
        run: async (opts: { env?: NodeJS.ProcessEnv }) => {
          seen = opts.env;
          return { sessionId: 's', events: (async function* () {})() };
        },
      };
      const backend = withControlPlaneAgentCredentials(
        inner as unknown as Parameters<typeof withControlPlaneAgentCredentials>[0],
        (inherited) => materializeControlPlaneAgentEnv(root, inherited),
      );

      await backend.run({
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'p' },
      } as unknown as Parameters<typeof backend.run>[0]);

      expect(seen?.GIT_CONFIG_COUNT).toBe('2');
      expect(seen?.GIT_CONFIG_KEY_1).toBe('gpg.ssh.program');
      // The caller's entry survives at its own index.
      expect(seen?.GIT_CONFIG_KEY_0).toBe('http.proxy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends its git config entry instead of overwriting inherited ones', async () => {
    // `GIT_CONFIG_COUNT` addresses one shared list. Claiming index 0 would drop
    // whatever a deployment already passes in — a credential helper, a proxy —
    // and appending also lets this entry win, since git takes the last one.
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    try {
      const env = await materializeControlPlaneAgentEnv(root, {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
        GIT_CONFIG_KEY_1: 'http.proxy',
        GIT_CONFIG_VALUE_1: 'http://proxy:3128',
      });

      expect(env.GIT_CONFIG_COUNT).toBe('3');
      expect(env.GIT_CONFIG_KEY_2).toBe('gpg.ssh.program');
      expect(env.GIT_CONFIG_VALUE_2).toBe(join(root, 'git', 'control-plane-git-sign'));
      // The inherited pair is untouched — it is not this function's to restate.
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves the centrally stored Claude access token to agent processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    const stored = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'central-access-token',
        refreshToken: 'central-refresh-token',
        expiresAt: 4_102_444_800_000,
      },
    });
    const sync = startClaudeCredentialSync(
      {
        getVeritySettings: vi.fn(async () => ({ claudeCodeOauthCredentialsJson: stored })),
        updateVeritySettings: vi.fn(async () => undefined),
      },
      root,
    );
    try {
      await expect(sync.getAccessToken()).resolves.toBe('central-access-token');
    } finally {
      await sync.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes DB refreshes without projecting refresh credentials to runtimes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-control-plane-agent-env-'));
    mkdirSync(join(root, 'claude'), { recursive: true });
    writeFileSync(join(root, 'claude', '.credentials.json'), 'legacy-refresh-secret');
    let stored = JSON.stringify({
      claudeAiOauth: { accessToken: 'db-old', refreshToken: 'consumed', expiresAt: 200 },
    });
    const refreshed = JSON.stringify({
      claudeAiOauth: { accessToken: 'db-new', refreshToken: 'db-rotated', expiresAt: 200 },
    });
    const sync = startClaudeCredentialSync(
      {
        getVeritySettings: vi.fn(async () => ({ claudeCodeOauthCredentialsJson: stored })),
        updateVeritySettings: vi.fn(async (patch) => {
          stored = patch.claudeCodeOauthCredentialsJson ?? stored;
          return undefined;
        }),
      },
      root,
    );
    try {
      const changed = vi.fn();
      sync.onCredentialsChanged(changed);
      await sync.persistCredentials({ claudeCodeOauthCredentialsJson: refreshed }, async () => {
        stored = refreshed;
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(stored).toBe(refreshed);
      expect(changed).toHaveBeenCalledOnce();
      expect(readFileSync(join(root, 'claude', '.credentials.json'), 'utf8')).toBe('');
    } finally {
      await sync.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects materialized agent env into control-plane backend runs', async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const backend = withControlPlaneAgentCredentials(
      {
        run: async (opts) => {
          seen = opts.env;
          return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
        },
      },
      async () => ({ CLAUDE_CONFIG_DIR: '/db/claude', CODEX_HOME: '/db/codex' }),
    );

    await backend.run({
      store: {} as never,
      worktree: '/wt',
      cwd: '/wt',
      env: {
        CLAUDE_TEST_LEAK: 'server-env',
        DATABASE_URL: 'postgres://server-secret',
        PATH: '/safe/bin',
      },
    });

    expect(seen?.CLAUDE_TEST_LEAK).toBeUndefined();
    expect(seen?.DATABASE_URL).toBeUndefined();
    expect(seen?.PATH).toBe('/safe/bin');
    expect(seen?.CLAUDE_CONFIG_DIR).toBe('/db/claude');
    expect(seen?.CODEX_HOME).toBe('/db/codex');
  });

  it('preserves runner supervisor backend capability through credential wrapping', () => {
    const backend = withControlPlaneAgentCredentials(
      {
        runnerSupervisorBackend: 'claude-acp',
        run: async () => ({ sessionId: 's1', exitCode: 0, stderr: '', aborted: false }),
      },
      async () => ({ CLAUDE_CONFIG_DIR: '/db/claude' }),
    );

    expect(backend.runnerSupervisorBackend).toBe('claude-acp');
  });
});

describe('buildRunnerConductorWiring (Stage 5c runner cutover)', () => {
  type WiringDeps = Parameters<typeof buildRunnerConductorWiring>[0];
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const claudeAcpBackend = { runnerSupervisorBackend: 'claude-acp' } as Backend;
  const codexAcpBackend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const openCodeAcpBackend = { runnerSupervisorBackend: 'opencode-acp' } as Backend;
  const nonSupervisorBackend = {} as Backend;
  const store: WiringDeps['store'] = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' }),
  };

  let dir: string;
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let transcript: TranscriptStore;
  const servers: Server[] = [];

  const baseDeps = (): WiringDeps => ({
    runnerSupervisor: false,
    runnerTransport: false,
    dataVolumeRoot: dir,
    store,
    bus: new InMemoryEventBus(),
    transcript,
    allocateEventFile: () => join(dir, 'events.jsonl'),
    allocateControlSocket: () => join(dir, 'control.sock'),
    getSession: async () => ({ projectId: 'proj-1' }),
    // A correctly composed Server always hands the runner factory the per-turn bearer
    // registry (`createMcpGatewayTokens()` in `createEmbeddedServer`), so the fixture
    // that stands for "composed correctly" carries it too. The test below is the one
    // that omits it, and pins that the omission is refused rather than absorbed.
    mcpGatewayTokens: {
      issue: () => 'test-gateway-bearer',
      release: () => undefined,
      resolve: () => undefined,
    },
  });

  it('maps persisted control-plane worktrees into the dedicated Runner mount', () => {
    expect(
      runnerSandboxPath(
        '/srv/verity/workspaces/verity-control/.verity-sessions/control-session',
        '/srv/verity/workspaces',
      ),
    ).toBe('/work/.verity-sessions/control-session');
    expect(
      runnerSandboxPath('/srv/verity/sessions/control-session', '/srv/verity/workspaces'),
    ).toBe('/srv/verity/sessions/control-session');
    expect(runnerAuthorizationProjectId('persisted-control', 'verity-control')).toBe(
      'persisted-control',
    );
    expect(runnerAuthorizationProjectId(null, 'verity-control')).toBe('verity-control');
  });

  it('canonicalizes current project and already sandbox-visible session worktrees', () => {
    expect(
      runnerSandboxPath(
        '/srv/verity/workspaces/heey-global--verity/.verity-sessions/agent-123',
        '/srv/verity/workspaces',
      ),
    ).toBe('/work/.verity-sessions/agent-123');
    expect(runnerSandboxPath('/work/.verity-sessions/agent-legacy', '/srv/verity/workspaces')).toBe(
      '/work/.verity-sessions/agent-legacy',
    );
  });

  it('leaves a worktree the clone-root mapping does not cover unchanged', () => {
    // Worth pinning because two callers depend on this answer being the SAME answer: the
    // runner maps a session's worktree through this function to launch a turn, and the
    // transcript purge and startup sweep map it again to find the files that turn wrote.
    // If an uncovered worktree came back differently for one of them, the sweep's
    // live-worktree guard would match nothing and start collecting `subagents/` trees
    // that no session can rebuild. There is no second expression to drift — the default
    // container root is shared — so the guarantee is that both get the host path back.
    expect(runnerSandboxPath('/srv/verity/sessions/loose', undefined)).toBe(
      '/srv/verity/sessions/loose',
    );
    expect(runnerSandboxPath('/srv/verity/workspaces', '/srv/verity/workspaces')).toBe(
      '/srv/verity/workspaces',
    );
    expect(RUNNER_CONTAINER_PROJECT_ROOT).toBe('/work');
    expect(
      runnerSandboxPath(
        '/srv/verity/workspaces/proj/.verity-sessions/agent-1',
        '/srv/verity/workspaces',
        RUNNER_CONTAINER_PROJECT_ROOT,
      ),
    ).toBe(
      runnerSandboxPath(
        '/srv/verity/workspaces/proj/.verity-sessions/agent-1',
        '/srv/verity/workspaces',
      ),
    );
  });

  // One migrated database for all tests below, truncated between them. Booting a
  // pglite is a WASM Postgres start plus 77 migrations — the dominant cost of these
  // tests, which otherwise do almost no work: paying it per test took 16.9s, paying
  // it once takes 2.7s (measured, `-t buildRunnerConductorWiring`). These tests only
  // ever reach the database through `transcript`, so truncation leaves them the same
  // empty schema a fresh instance did.
  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'verity-runner-wiring-'));
    await truncateAll(testDb.db);
    transcript = new TranscriptStore(testDb.db);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await rm(dir, { recursive: true, force: true });
  });

  it('off-flag builds the in-process loopback and keeps opts.transcript (byte-identical)', () => {
    const wiring = buildRunnerConductorWiring(baseDeps());
    // No runner override, no server-managed transcript, no recovery seam — the
    // Conductor keeps its default loopback and passes opts.transcript exactly as today.
    expect(wiring).toEqual({});
    expect(wiring.runner).toBeUndefined();
    expect(wiring.serverManagedTranscript).toBeUndefined();
    expect(wiring.runnerRecovery).toBeUndefined();
  });

  it('runnerTransport builds a FileTailRunnerClient with no supervisor semantics', async () => {
    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerTransport: true });
    expect(wiring.serverManagedTranscript).toBeUndefined();
    expect(wiring.runnerRecovery).toBeUndefined();
    const client = await wiring.runner?.(backend, {
      sessionId: 's',
      projectId: 'proj-1',
      worktree: '/wt',
    });
    expect(client).toBeInstanceOf(FileTailRunnerClient);
  });

  it('on-flag manages the transcript server-side and wires reattach recovery', () => {
    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });
    // Omit opts.transcript (server owns render+tail) and hand recovery the reattach seam.
    expect(wiring.serverManagedTranscript).toBe(true);
    expect(wiring.runnerRecovery).toBeInstanceOf(SupervisorRunnerRecovery);
  });

  it('on-flag builds a supervisor-backed client only when the project socket exists', async () => {
    const projectId = 'proj-1';
    const runtime = join(dir, 'runners', projectId);
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => peer.end(`${JSON.stringify({ ok: true })}\n`));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));

    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });
    const projectClient = await wiring.runner?.(backend, {
      sessionId: 's',
      projectId,
      worktree: '/wt',
    });
    expect(projectClient).toBeInstanceOf(SupervisorRunnerClient);
    await expect(
      wiring.runner?.(codexAcpBackend, {
        sessionId: 'codex-acp-control',
        projectId: null,
        worktree: '/wt',
      }),
    ).rejects.toThrow('ACP control-plane turns require the dedicated control-plane runner');
  });

  it('routes project-less Claude ACP and Codex through the dedicated control-plane supervisor', async () => {
    const runtime = join(dir, 'runners', 'verity-control');
    await mkdir(runtime, { recursive: true });
    let request: Record<string, unknown> | undefined;
    const server = createServer((peer) => {
      peer.on('data', (data) => {
        request = JSON.parse(data.toString('utf8').trim()) as Record<string, unknown>;
        peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));

    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      controlPlaneProjectId: 'verity-control',
    });
    const client = await wiring.runner?.(claudeAcpBackend, {
      sessionId: 'control-session',
      projectId: null,
      worktree: '/srv/verity/sessions/control-session',
    });

    expect(client).toBeInstanceOf(SupervisorRunnerClient);

    const codexAcpClient = await wiring.runner?.(codexAcpBackend, {
      sessionId: 'codex-acp-control-session',
      projectId: null,
      worktree: '/srv/verity/sessions/codex-acp-control-session',
    });
    expect(codexAcpClient).toBeInstanceOf(SupervisorRunnerClient);

    const codexClient = await wiring.runner?.(backend, {
      sessionId: 'codex-control-session',
      projectId: null,
      worktree: '/srv/verity/sessions/codex-control-session',
    });
    expect(codexClient).toBeInstanceOf(SupervisorRunnerClient);

    // OpenCode is the ACP backend this runner cannot serve. It is a fixed
    // deployment-launched container, not a provisioner-composed Sandbox: no
    // OpenCode config volume, no XDG_CONFIG_HOME, egress certificates for the
    // Claude and Codex gateways only. Routing a turn there would spawn an agent
    // with no provider and fail somewhere inside the first prompt, so the refusal
    // has to name the reason here — and it must be a refusal, because the loopback
    // is not an alternative for any ACP backend.
    await expect(
      wiring.runner?.(openCodeAcpBackend, {
        sessionId: 'opencode-control-session',
        projectId: null,
        worktree: '/srv/verity/sessions/opencode-control-session',
      }),
    ).rejects.toThrow(/OpenCode is not available for control-plane sessions/);

    const turn = codexClient!.startTurn(
      {
        store: {} as never,
        worktree: '/srv/verity/sessions/codex-control-session',
        cwd: '/srv/verity/sessions/codex-control-session',
        prompt: 'deliver the service',
        storeSessionId: 'codex-control-session',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('invalid start outcome');
    expect(request).toMatchObject({
      backend: 'codex-acp',
    });
  });

  it('maps a persisted control-plane project to the dedicated Claude runtime', async () => {
    const runtime = join(dir, 'runners', 'verity-control');
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => peer.end(`${JSON.stringify({ ok: true })}\n`));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));

    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      controlPlaneProjectId: 'verity-control',
      isControlPlaneProject: async (projectId) => projectId === 'persisted-control',
    });
    const client = await wiring.runner?.(claudeAcpBackend, {
      sessionId: 'control-session',
      projectId: 'persisted-control',
      worktree: '/srv/verity/workspaces/verity-control/.verity-sessions/control-session',
    });

    expect(client).toBeInstanceOf(SupervisorRunnerClient);

    // The other shape a control-plane turn takes: a session that HAS a project, whose
    // project is the control plane. It reaches the same dedicated container as a
    // project-less one and is refused for the same reason, so the refusal must not be
    // written as if only project-less sessions could hit it.
    await expect(
      wiring.runner?.(openCodeAcpBackend, {
        sessionId: 'control-session-opencode',
        projectId: 'persisted-control',
        worktree: '/srv/verity/workspaces/verity-control/.verity-sessions/control-session-opencode',
      }),
    ).rejects.toThrow(/OpenCode is not available for control-plane sessions/);
  });

  it('fails project-less ACP backends closed without the dedicated runner', async () => {
    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });

    for (const acpBackend of [claudeAcpBackend, codexAcpBackend]) {
      await expect(
        wiring.runner?.(acpBackend, {
          sessionId: 'control-session',
          projectId: null,
          worktree: '/srv/verity/sessions/control-session',
        }),
      ).rejects.toThrow('dedicated control-plane runner');
    }
  });

  it('reports why an ACP project without a supervisor socket fails closed', async () => {
    const onMissingSupervisorSocket = vi.fn();
    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      onMissingSupervisorSocket,
    });
    await expect(
      wiring.runner?.(backend, {
        sessionId: 's',
        projectId: 'proj-1',
        worktree: '/wt',
      }),
    ).rejects.toThrow('ACP requires a reachable project supervisor');
    expect(onMissingSupervisorSocket).toHaveBeenCalledWith({
      projectId: 'proj-1',
      socketPath: join(dir, 'runners', 'proj-1', 'supervisor.sock'),
      reason: expect.stringContaining('supervisor socket is missing'),
    });
  });

  it('fails ACP backends closed when the project supervisor socket is missing', async () => {
    const onMissingSupervisorSocket = vi.fn();
    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      onMissingSupervisorSocket,
    });

    for (const acpBackend of [claudeAcpBackend, codexAcpBackend]) {
      await expect(
        wiring.runner?.(acpBackend, {
          sessionId: 's-acp',
          projectId: 'proj-1',
          worktree: '/wt',
        }),
      ).rejects.toThrow('ACP requires a reachable project supervisor');
    }
    expect(onMissingSupervisorSocket).toHaveBeenCalledWith({
      projectId: 'proj-1',
      socketPath: join(dir, 'runners', 'proj-1', 'supervisor.sock'),
      reason: expect.stringContaining('supervisor socket is missing'),
    });
  });

  it('fails closed when the supervisor socket is there but nothing listens', async () => {
    // A retired Sandbox generation leaves its socket inode behind, and the Server
    // cannot remove it — the runtime directory belongs to the Runner runtime GID. The
    // presence of the file therefore proves nothing, and routing a turn at it killed
    // every message in the project with `connect ECONNREFUSED`.
    const projectId = 'proj-1';
    const runtime = join(dir, 'runners', projectId);
    await mkdir(runtime, { recursive: true });
    const socketPath = join(runtime, 'supervisor.sock');
    await writeFile(socketPath, '');
    const onMissingSupervisorSocket = vi.fn();
    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      onMissingSupervisorSocket,
    });

    await expect(
      wiring.runner?.(backend, {
        sessionId: 's',
        projectId,
        worktree: '/wt',
      }),
    ).rejects.toThrow('ACP requires a reachable project supervisor');
    expect(onMissingSupervisorSocket).toHaveBeenCalledWith({
      projectId,
      socketPath,
      reason: expect.stringContaining('not accepting connections'),
    });
  });

  it('fails ACP backends closed when a stale supervisor socket accepts no connections', async () => {
    const projectId = 'proj-1';
    const runtime = join(dir, 'runners', projectId);
    await mkdir(runtime, { recursive: true });
    const socketPath = join(runtime, 'supervisor.sock');
    await writeFile(socketPath, '');
    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });

    for (const acpBackend of [claudeAcpBackend, codexAcpBackend]) {
      await expect(
        wiring.runner?.(acpBackend, {
          sessionId: 's-acp',
          projectId,
          worktree: '/wt',
        }),
      ).rejects.toThrow('ACP requires a reachable project supervisor');
    }
  });

  it('refuses to start a brokered-tool ACP turn on a Server composed without the bearer registry', async () => {
    // The failure this closes: with no registry the supervisor client mints no bearer,
    // the worker offers no MCP server, and the agent starts with an EMPTY `mcpServers`
    // list — no `verity_http_request`, no control-plane session tools — and nothing
    // anywhere says so. `issue` is typed to return a string, so the only way that
    // happens for an ACP backend is a misassembled Server, which no retry fixes.
    const projectId = 'proj-1';
    const runtime = join(dir, 'runners', projectId);
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => peer.end(`${JSON.stringify({ ok: true })}\n`));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));

    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      mcpGatewayTokens: undefined,
    });

    for (const acpBackend of [claudeAcpBackend, codexAcpBackend]) {
      await expect(
        wiring.runner?.(acpBackend, { sessionId: 's-acp', projectId, worktree: '/wt' }),
      ).rejects.toThrow('composed without mcpGatewayTokens');
    }

    await expect(
      wiring.runner?.(claudeAcpBackend, { sessionId: null, projectId, worktree: '/wt' }),
    ).resolves.toBeInstanceOf(SupervisorRunnerClient);

    await expect(
      wiring.runner?.(openCodeAcpBackend, { sessionId: 's-oc', projectId, worktree: '/wt' }),
    ).resolves.toBeInstanceOf(SupervisorRunnerClient);

    const composed = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });
    await expect(
      composed.runner?.(claudeAcpBackend, { sessionId: 's-acp', projectId, worktree: '/wt' }),
    ).resolves.toBeInstanceOf(SupervisorRunnerClient);
  });

  it('falls back to loopback for backends the native supervisor worker cannot run', async () => {
    const projectId = 'proj-1';
    const runtime = join(dir, 'runners', projectId);
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => peer.end(`${JSON.stringify({ ok: true })}\n`));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));

    const wiring = buildRunnerConductorWiring({ ...baseDeps(), runnerSupervisor: true });
    const projectClient = await wiring.runner?.(nonSupervisorBackend, {
      sessionId: 's',
      projectId,
      worktree: '/wt',
    });

    expect(projectClient).toBeInstanceOf(LoopbackRunnerClient);
  });

  it('degrades to the transport/default posture when dataVolumeRoot is absent', () => {
    // Without a data volume there is no `<dataVolumeRoot>/runners/<projectId>` socket to
    // bind, so the supervisor posture must not build a broken client.
    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      dataVolumeRoot: undefined,
    });
    expect(wiring.serverManagedTranscript).toBeUndefined();
    expect(wiring.runnerRecovery).toBeUndefined();
    expect(wiring.runner).toBeUndefined();
  });

  it('binds the project turn to its supervisor socket and accepts the real prod option set', async () => {
    const projectId = 'proj-1';
    const socket = join(dir, 'runners', projectId, 'supervisor.sock');
    await mkdir(join(dir, 'runners', projectId), { recursive: true });
    let request: Record<string, unknown> | undefined;
    const server = createServer((peer) => {
      peer.once('data', (data) => {
        request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        // A benign non-launching outcome: the client rejects AFTER the guard passes and
        // the request reaches this project socket, so reaching here proves both.
        peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    const wiring = buildRunnerConductorWiring({
      ...baseDeps(),
      runnerSupervisor: true,
      hostCloneRoot: '/srv/verity/workspaces',
    });
    const client = await wiring.runner?.(claudeAcpBackend, {
      sessionId: 'session-1',
      projectId,
      worktree: '/srv/verity/workspaces/heey-global-verity/.verity-sessions/agent-x',
    });
    // The exact option set the Conductor builds for a fresh prod turn on the flag path:
    // durable identity + steer/permission/attachments, and — crucially — NONE of the
    // guard's fail-closed fields (command/extraArgs/spawner/claudeHome/env/onSteer/
    // onPermissionRequest) and NO opts.transcript (serverManagedTranscript omits it).
    const turn = client!.startTurn(
      {
        store: {} as never,
        worktree: '/srv/verity/workspaces/heey-global-verity/.verity-sessions/agent-x',
        cwd: '/srv/verity/workspaces/heey-global-verity/.verity-sessions/agent-x/packages/server',
        prompt: 'hello',
        appendSystemPrompt: 'policy',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        steerable: true,
        permissionControl: true,
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      },
      {},
    );
    // The guard did NOT fail closed (that throws 'turn options are not yet supported');
    // the request reached the project socket and the client rejects only on the outcome.
    await expect(turn.result).rejects.toThrow('invalid start outcome');
    expect(request).toMatchObject({
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: '/work/.verity-sessions/agent-x',
      cwd: '/work/.verity-sessions/agent-x/packages/server',
      prompt: 'hello',
      steerable: true,
      permissionControl: true,
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
  });
});

const testProjectRelayConfig = {
  projectRelayImage: `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'0'.repeat(64)}`,
  projectRelayGid: process.getgid?.() ?? 1000,
  dataVolume: 'verity-test-data',
  dataVolumeRoot: '/tmp',
  claudeEgressGatewayUrl: 'https://verity:9443',
  codexEgressGatewayUrl: 'https://verity:9444',
  claudeConnectorPort: 9444,
  // Claude routing has one target, so a Docker-backed server must name the
  // gateway and the control plane behind it.
  agentGatewayUrl: 'https://verity-agent-gateway:9443',
  agentGatewayClaudePort: 9443,
  agentGatewayControlSocket: '/tmp/verity-test-agent-gateway.sock',
  agentGatewayUnsealKey: 'test-unseal-key',
} as const;

describe('buildEmbeddedServer', () => {
  it('validates Secret Job activation atomically and requires direct unix attach', async () => {
    const withoutResolver = { ...secretJobsConfig() };
    delete withoutResolver.resolveSecrets;
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        secretJobs: withoutResolver,
      }),
    ).rejects.toThrow(/exactly one of resolveSecrets or doppler/);
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        secretJobs: {
          ...secretJobsConfig(),
          doppler: {},
        },
      }),
    ).rejects.toThrow(/exactly one of resolveSecrets or doppler/);
    await expect(buildTestEmbeddedServer({ secretJobs: secretJobsConfig() })).rejects.toThrow(
      /dockerBaseUrl is required/,
    );
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'http://docker-proxy:2375/v1.41',
        secretJobs: secretJobsConfig(),
      }),
    ).rejects.toThrow(/unix Docker socket/);
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix://',
        secretJobs: secretJobsConfig(),
      }),
    ).rejects.toThrow(/empty socket path/);
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix://relative.sock',
        secretJobs: secretJobsConfig(),
      }),
    ).rejects.toThrow(/absolute, non-empty unix Docker socket path/);
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        secretJobs: {
          ...secretJobsConfig(),
          executorImageRepository: 'ghcr.io/example/worker:latest',
        },
      }),
    ).rejects.toThrow(/untagged repository/);
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        secretJobs: {
          ...secretJobsConfig(),
          executorImageRepository: 'ghcr.io/example/',
        },
      }),
    ).rejects.toThrow(/untagged repository/);
    server = await buildTestEmbeddedServer({
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      secretJobs: {
        ...secretJobsConfig(),
        executorImageRepository: 'localhost:5000/example/worker',
      },
    });
    expect(server.secretJobs).toBeDefined();
  });

  it('composes the durable Secret Job core when every collaborator is present', async () => {
    server = await buildTestEmbeddedServer({
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      secretJobs: secretJobsConfig(),
    });

    expect(server.secretJobs).toBeDefined();
    expect(server.secretJobs?.executor.boundGrants()).toBe(0);
    const invocation = {
      context: {
        protocolVersion: 1 as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        channel: 'codex-mcp' as const,
      },
      request: {
        kind: 'restricted' as const,
        profile: { id: 'fixed-read', version: 1, policyHash: 'a'.repeat(64) },
        parameters: { operation: 'read' },
        snapshotId: 'b'.repeat(64),
      },
    };
    const actor = { actorId: 'actor-1', authorizationHash: 'c'.repeat(64) };
    await expect(server.secretJobs?.service.request(invocation, actor)).resolves.toEqual({
      approvalId: 'approval-1',
    });
    await expect(server.secretJobs?.frames.readPage('job-1')).resolves.toEqual({
      frames: [],
      nextSequence: 0,
      hasMore: false,
    });
  });

  it('does not require provider administration for the transitional resolver', async () => {
    const config = secretJobsConfig();
    delete config.authorizeProviderAdministration;
    server = await buildTestEmbeddedServer({
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      secretJobs: config,
    });
    expect(server.secretJobs).toBeDefined();
  });

  it('composes the real Doppler resolver with the durable catalog at startup', async () => {
    const config = secretJobsConfig();
    delete config.resolveSecrets;
    const fetch = vi.fn(() => Promise.reject(new Error('must not run during composition')));
    server = await buildTestEmbeddedServer({
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      secretJobs: {
        ...config,
        doppler: { fetch },
      },
    });

    expect(server.secretJobs).toBeDefined();
    expect(server.secretJobs?.executor.boundGrants()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  let server: EmbeddedServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('rejects project Docker provisioning without a project relay at startup', async () => {
    await expect(
      buildTestEmbeddedServer({
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        hostCloneRoot: '/tmp/workspaces',
      }),
    ).rejects.toThrow('Project Docker provisioning requires a digest-pinned project relay image');
  });

  it('rejects retired relay transport options from untyped callers', async () => {
    await expect(
      buildTestEmbeddedServer({
        signingBrokerUrl: 'http://legacy-broker',
      } as EmbeddedServerConfig & { signingBrokerUrl: string }),
    ).rejects.toThrow('signingBrokerUrl was removed');
  });

  it('rejects empty mandatory relay paths', async () => {
    await expect(
      buildTestEmbeddedServer({
        ...testProjectRelayConfig,
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        hostCloneRoot: '',
      }),
    ).rejects.toThrow('project relay requires: hostCloneRoot');
  });

  it('rejects an invalid mandatory Claude connector port', async () => {
    await expect(
      buildTestEmbeddedServer({
        ...testProjectRelayConfig,
        dockerBaseUrl: 'unix:///var/run/docker.sock',
        hostCloneRoot: '/tmp/workspaces',
        claudeConnectorPort: 0,
      }),
    ).rejects.toThrow('project relay requires: claudeConnectorPort');
  });

  it('wires an in-memory embedded server that serves the control-plane routes', async () => {
    server = await buildTestEmbeddedServer(); // no dataDir → in-memory pglite

    const health = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    // /healthz also carries the server version (baked in at release; a sentinel in
    // dev/test) — assert the liveness field and that a version string is present.
    expect(health.json()).toMatchObject({
      status: 'ok',
      version: expect.any(String),
      pushEnabled: false,
    });

    // The DB was migrated and wired: an empty store returns an empty list.
    const sessions = await server.app.inject({ method: 'GET', url: '/sessions' });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual([]);
  });

  it('runs the orphaned-transcript sweep on boot when a deployment leaves it on', async () => {
    // The units are covered directly; what this pins is the WIRING — that a booted
    // server points the sweep at `<dataVolumeRoot>/runners`, hands it the store's live
    // ids, and runs it with the real defaults rather than a test's. `buildTestEmbeddedServer`
    // keeps it off precisely because it deletes files, so this asks for it explicitly.
    const root = mkdtempSync(join(tmpdir(), 'verity-sweep-wiring-'));
    try {
      // A store with a session in it. Not decoration: an empty `sessions` table is how a
      // server pointed at the wrong control-plane database looks, and the sweep refuses to
      // delete anything on that reading — so a wiring test that boots on an empty store
      // would pass while deleting nothing, and pin nothing.
      const dataDir = join(root, 'db');
      const db = createEmbeddedDb(dataDir);
      await migrateToLatest(db);
      const store = new EventStore(db);
      await store.upsertProject({
        id: 'proj-1',
        owner: 'Heey-Global',
        repo: 'Verity',
        containerName: 'dev-heey-global--verity',
        state: 'active',
      });
      await store.createSession({
        sessionId: 's-sweep-live',
        worktree: join(root, 'clones', 'heey-global-verity', '.verity-sessions', 'agent-live'),
        model: 'codex/default',
        projectId: 'proj-1',
      });
      await db.destroy();

      const day = join(root, 'runners', 'proj-1', 'codex-sessions', '2026', '08', '18');
      await mkdir(day, { recursive: true });
      const orphan = join(day, 'rollout-2026-08-18T10-00-00-thread-gone.jsonl');
      const recent = join(day, 'rollout-2026-08-18T11-00-00-thread-fresh.jsonl');
      await writeFile(orphan, '{"payload":{"id":"thread-gone"}}\n', 'utf8');
      await writeFile(recent, '{"payload":{"id":"thread-fresh"}}\n', 'utf8');
      // Only the first is older than the default 24h grace window. The second is a
      // session that may still be binding, and the wiring must be passing that default
      // through for it to survive.
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(orphan, old, old);

      server = await buildTestEmbeddedServer({
        dataDir,
        dataVolumeRoot: root,
        transcriptSweep: 'on',
      });

      // Awaited through to the end of the walk, so `recent` surviving means the sweep
      // considered it and spared it — not merely that the walk had yet to reach it.
      const result = await server.transcriptSweepWalk;

      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(result).toMatchObject({
        scanned: 2,
        removed: 1,
        graceKept: 1,
        failed: 0,
        storeReportedNoSession: false,
      });
    } finally {
      await server?.close();
      server = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000); // A full embedded DB migration can exceed the shared CI timeout.

  it('deletes a session’s backend transcripts off the runner runtime', async () => {
    // The glue between the DELETE route and `purgeSessionArtifacts`: which runner runtime
    // to look in (the session's project), and which sandbox path claude encoded into its
    // directory name (the worktree, mapped through `hostCloneRoot`). Both are derived in
    // `embedded.ts` from the session row, so neither the route tests nor the resolver
    // tests can catch a wrong derivation — only a delete against a real layout can.
    const root = mkdtempSync(join(tmpdir(), 'verity-purge-wiring-'));
    try {
      const dataDir = join(root, 'db');
      const dataVolumeRoot = join(root, 'data');
      const hostCloneRoot = join(root, 'clones');
      const worktree = join(hostCloneRoot, 'heey-global-verity', '.verity-sessions', 'agent-p1');
      mkdirSync(worktree, { recursive: true });

      const db = createEmbeddedDb(dataDir);
      await migrateToLatest(db);
      const store = new EventStore(db);
      await store.upsertProject({
        id: 'p-purge',
        owner: 'Heey-Global',
        repo: 'Verity',
        containerName: 'dev-heey-global--verity',
        state: 'active',
      });
      await store.createSession({
        sessionId: 's-purge',
        worktree,
        model: 'codex/default',
        projectId: 'p-purge',
      });
      await store.upsertSessionBackendState({
        sessionId: 's-purge',
        backend: 'codex',
        backendSessionId: 'thread-purge',
        contextSeq: 0,
      });
      await db.destroy();

      const runtime = join(dataVolumeRoot, 'runners', 'p-purge');
      const day = join(runtime, 'codex-sessions', '2026', '08', '18');
      await mkdir(day, { recursive: true });
      const rollout = join(day, 'rollout-2026-08-18T10-00-00-thread-purge.jsonl');
      const strangerRollout = join(day, 'rollout-2026-08-18T10-00-00-thread-other.jsonl');
      await writeFile(rollout, '{"payload":{"id":"thread-purge"}}\n', 'utf8');
      await writeFile(strangerRollout, '{"payload":{"id":"thread-other"}}\n', 'utf8');

      // `/work/.verity-sessions/agent-p1` is what the sandbox sees, and claude encodes
      // exactly that into its directory name. A delete also resolves the VERITY session
      // id, which is what a cold-started thread writes before any binding row lands.
      const claudeDir = join(runtime, 'claude', 'projects', '-work--verity-sessions-agent-p1');
      await mkdir(join(claudeDir, 's-purge', 'subagents'), { recursive: true });
      const transcript = join(claudeDir, 's-purge.jsonl');
      const subagent = join(claudeDir, 's-purge', 'subagents', 'agent-1.jsonl');
      await writeFile(transcript, '{}\n', 'utf8');
      await writeFile(subagent, '{}\n', 'utf8');

      server = await buildTestEmbeddedServer({ dataDir, dataVolumeRoot, hostCloneRoot });
      const res = await server.app.inject({ method: 'DELETE', url: '/sessions/s-purge' });
      expect(res.statusCode).toBe(200);

      expect(existsSync(rollout)).toBe(false);
      expect(existsSync(transcript)).toBe(false);
      // The subagent tree goes with the session directory it sits in — it is the only
      // copy Verity ever has of that conversation.
      expect(existsSync(subagent)).toBe(false);
      // Scoped to this session's own ids: another session's rollout in the same archive
      // is untouched.
      expect(existsSync(strangerRollout)).toBe(true);
    } finally {
      await server?.close();
      server = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000); // A full embedded DB migration can exceed the shared CI timeout.

  it('returns PR status for a project worktree when the global repoDir is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-project-pr-'));
    const dataDir = join(root, 'db');
    const hostCloneRoot = join(root, 'clones');
    const projectRoot = join(hostCloneRoot, 'heey-global-verity');
    const worktree = join(root, 'session-worktree');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Verity Test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 'verity@example.test'], { cwd: projectRoot });
    writeFileSync(join(projectRoot, 'README.md'), 'test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: projectRoot });
    execFileSync('git', ['commit', '-m', 'test: initialize repository'], { cwd: projectRoot });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/Example-Org/Example-Repo.git'],
      {
        cwd: projectRoot,
      },
    );
    execFileSync('git', ['worktree', 'add', '-b', 'fix/project-pr', worktree], {
      cwd: projectRoot,
    });

    const db = createEmbeddedDb(dataDir);
    await migrateToLatest(db);
    const store = new EventStore(db);
    await store.upsertProject({
      id: 'p-verity',
      owner: 'Heey-Global',
      repo: 'Verity',
      containerName: 'dev-heey-global--verity',
      state: 'active',
    });
    await store.createSession({
      sessionId: 's-project-pr',
      worktree,
      model: 'codex/default',
      projectId: 'p-verity',
    });
    const scratchWorktree = join(root, 'scratch-session');
    mkdirSync(scratchWorktree);
    await store.createSession({
      sessionId: 's-scratch',
      worktree: scratchWorktree,
      model: 'codex/default',
    });
    await db.destroy();

    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              number: 730,
              title: 'Project PR status',
              html_url: 'https://github.com/Example-Org/Example-Repo/pull/730',
              state: 'open',
              updated_at: '2026-07-12T00:00:00Z',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    try {
      server = await buildTestEmbeddedServer({
        dataDir,
        repoDir: '',
        hostCloneRoot,
        githubToken: 'test-token',
      });
      const branches = await server.app.inject({
        method: 'GET',
        url: '/sessions/s-project-pr/branches',
      });
      expect(branches.statusCode).toBe(200);
      expect(branches.json()).toMatchObject({
        current: 'fix/project-pr',
        currentPr: 730,
        pullRequest: {
          number: 730,
          title: 'Project PR status',
          phase: 'open',
        },
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('head=Example-Org%3Afix%2Fproject-pr'),
        expect.objectContaining({ headers: expect.any(Object) }),
      );

      const scratchBranches = await server.app.inject({
        method: 'GET',
        url: '/sessions/s-scratch/branches',
      });
      expect(scratchBranches.statusCode).toBe(503);
      expect(scratchBranches.json()).toEqual({ error: 'branch switching is not configured' });
    } finally {
      fetch.mockRestore();
      await server?.close();
      server = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000); // Git worktree creation + a full embedded DB migration can exceed the shared CI timeout.

  it('rejects :latest default project images because update status needs pinned targets', async () => {
    await expect(
      buildTestEmbeddedServer({
        defaultProjectImage: 'ghcr.io/heey-global/verity/verity-sandbox:latest',
      }),
    ).rejects.toThrow(/VERITY_DEFAULT_PROJECT_IMAGE must be pinned/);
  });

  it('wires /projects without a static GitHub token so DB-backed Apps can list repos', async () => {
    // The first-project onboarding step uses GET /projects after the GitHub App
    // has been configured through the encrypted DB settings. That deployment has
    // no static ~/.gh-token/Env token, so construction must not gate the fleet
    // registry on config.githubToken being present at startup.
    server = await buildTestEmbeddedServer({
      ...testProjectRelayConfig,
      dockerBaseUrl: 'http://127.0.0.1:1',
      hostCloneRoot: '/tmp/verity-projects',
    });

    const res = await server.app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns sealed from /projects when DB-backed GitHub App credentials need unlock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-projects-sealed-'));
    const dataDir = join(dir, 'data');
    try {
      server = await buildTestEmbeddedServer({
        ...testProjectRelayConfig,
        dataDir,
        dockerBaseUrl: 'http://127.0.0.1:1',
        hostCloneRoot: '/tmp/verity-projects',
      });
      const init = await server.app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
      });
      const token = init.json().token as string;
      const settings = await server.app.inject({
        method: 'PATCH',
        url: '/settings',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          githubAppId: '123',
          githubAppInstallationId: '456',
          githubAppPrivateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
        },
      });
      expect(settings.statusCode).toBe(200);
      await server.close();

      server = await buildTestEmbeddedServer({
        ...testProjectRelayConfig,
        dataDir,
        dockerBaseUrl: 'http://127.0.0.1:1',
        hostCloneRoot: '/tmp/verity-projects',
      });
      const res = await server.app.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'secret store is sealed', status: 'sealed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * ADR 0008 D8: an update the operator asked for once must not end at a
   * master-password prompt, so a promoted Server that was handed its
   * predecessor's in-memory key comes up serving secrets — but only if that key
   * is the one this store was encrypted with.
   */
  it('comes up unlocked from a handed-off key, and sealed from a wrong one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-key-handoff-'));
    const dataDir = join(dir, 'data');
    try {
      server = await buildTestEmbeddedServer({ dataDir });
      const init = await server.app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
      });
      expect(init.statusCode).toBe(200);
      await server.close();

      // What the outgoing Server would have had in memory and sealed to its
      // successor — derived from the password the operator actually set.
      const db = createEmbeddedDb(dataDir);
      const meta = await new EventStore(db).getSecretKeyMeta();
      await db.destroy();
      const handedOver = deriveKeyFromPassword('correct horse battery staple', meta!.salt);

      server = await buildTestEmbeddedServer({ dataDir, adoptedSecretKeyMaterial: handedOver });
      expect((await server.app.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'unlocked',
      });
      await server.close();

      // A key from anywhere else must not unlock: writing under it would encrypt
      // secrets the operator's password can never reproduce.
      server = await buildTestEmbeddedServer({
        dataDir,
        adoptedSecretKeyMaterial: deriveKeyFromPassword('another password', meta!.salt),
      });
      expect((await server.app.inject({ method: 'GET', url: '/secret/status' })).json()).toEqual({
        status: 'sealed',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires /tasks on repoDir + tasksProjectNumber even without a token (ADR 0007 — DB-only App creds)', async () => {
    // The construction gate must NOT require a token at build time: an App configured
    // purely via the app UI (creds in the encrypted DB store) has no `githubToken` and no
    // `githubAppId` env config, yet the request-time mint would reach those DB creds. So
    // opting in (repoDir + board number) alone wires the service; with no token resolvable
    // here it degrades to an inert board rather than a 503.
    const repoDir = mkdtempSync(join(tmpdir(), 'verity-tasks-gate-'));
    try {
      server = await buildTestEmbeddedServer({ repoDir, tasksProjectNumber: 1 });
      const res = await server.app.inject({ method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(200); // wired (not 503), not gated out by the missing token
      expect(res.json()).toEqual({ board: null }); // inert: no token resolved
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('503s /tasks when the board number is not configured (not opted in)', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'verity-tasks-gate-'));
    try {
      server = await buildTestEmbeddedServer({ repoDir, githubToken: 'tok' }); // no tasksProjectNumber
      const res = await server.app.inject({ method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(503);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('honors logger + permissionMode + push config', async () => {
    server = await buildTestEmbeddedServer({
      logger: false,
      permissionMode: 'auto',
      pushEnabled: true,
    });
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushEnabled).toBe(true);
  });

  it('wires the OpenCode backend + /models when OpenCode is enabled (#143)', async () => {
    // Smoke: the OpenCode backend is constructed + passed to the conductor, and the
    // operator's pinned ids reach the picker. Since the ACP migration those ids ARE
    // the OpenCode catalogue — there is no `opencode serve` left to enumerate — so
    // this also covers the `listModels` glue no other test exercises end-to-end.
    server = await buildTestEmbeddedServer({
      openCodeEnabled: true,
      extraModels: ['deepinfra/zai-org/GLM-5.2'],
    });
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);

    const models = await server.app.inject({ method: 'GET', url: '/models' });
    expect(models.statusCode).toBe(200);
    const body = models.json<{ models: string[]; default?: string }>();
    expect(body.default).toBe('deepinfra/zai-org/GLM-5.2');
    expect(body.models).toEqual(['deepinfra/zai-org/GLM-5.2']);
  });

  it('offers Codex and OpenCode models side by side', async () => {
    server = await buildTestEmbeddedServer({
      codexEnabled: true,
      codexModels: ['codex/gpt-5.6-sol'],
      openCodeEnabled: true,
      extraModels: ['deepinfra/zai-org/GLM-5.2'],
    });

    // Codex ids are gated on a stored Codex login — a subscription backend is not
    // offered in the picker without one — while the OpenCode ids are not, because they
    // are pay-per-token against the operator's own provider config. Storing the login
    // is what makes this a side-by-side case rather than an OpenCode-only one.
    const init = await server.app.inject({
      method: 'POST',
      url: '/secret/init',
      payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
    });
    const token = init.json().token as string;
    const settings = await server.app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { codexAuthJson: '{"tokens":{"access_token":"codex-token"}}' },
    });
    expect(settings.statusCode).toBe(200);

    const models = await server.app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(200);
    const body = models.json<{ models: string[]; default?: string }>();
    expect(body.default).toBe('codex/gpt-5.6-sol');
    expect(body.models).toEqual(['codex/gpt-5.6-sol', 'deepinfra/zai-org/GLM-5.2']);
  });

  it('refreshes visible Codex models from the credential-free bundled catalog', async () => {
    const bundled = vi.fn(async () => ['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']);
    server = await buildTestEmbeddedServer({
      codexEnabled: true,
      codexBundledModelLoader: bundled,
    });

    const init = await server.app.inject({
      method: 'POST',
      url: '/secret/init',
      payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
    });
    const token = init.json().token as string;
    const settings = await server.app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { codexAuthJson: '{"tokens":{"access_token":"codex-token"}}' },
    });
    expect(settings.statusCode).toBe(200);

    const response = await server.app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: ['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra'],
      modelOrder: ['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra'],
      default: 'codex/gpt-5.6-sol',
    });
    expect(bundled).toHaveBeenCalled();
  });

  it('keeps the credential-free bundled Codex catalog across a sealed restart and unlock', async () => {
    // Reproduces the restart bug: after a reboot the secret store is sealed, so the
    // stored login cannot be decrypted. The picker must still be populated from the
    // bundled catalog, which needs neither an unlock nor a materialized credential,
    // instead of stalling on the `codex/default` fallback.
    const dataDir = await mkdtemp(join(tmpdir(), 'verity-codex-sealed-'));
    const password = 'correct horse battery staple';
    const bundled = vi.fn(async () => ['codex/gpt-5.6-nova']);
    try {
      // Phase 1 — a live, unlocked server logs Codex in and persists the encrypted
      // login in the encrypted on-disk store, then shuts down cleanly.
      const first = await buildTestEmbeddedServer({
        dataDir,
        codexEnabled: true,
        codexBundledModelLoader: bundled,
      });
      const init = await first.app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password, deviceLabel: 'test device' },
      });
      const firstToken = init.json().token as string;
      const login = await first.app.inject({
        method: 'PATCH',
        url: '/settings',
        headers: { authorization: `Bearer ${firstToken}` },
        payload: { codexAuthJson: '{"tokens":{"access_token":"codex-token"}}' },
      });
      expect(login.statusCode).toBe(200);
      await first.close();

      bundled.mockClear();

      // Phase 2 — restart against the same store. It boots SEALED, but the bundled
      // catalog remains available without reading the stored login.
      server = await buildTestEmbeddedServer({
        dataDir,
        codexEnabled: true,
        codexBundledModelLoader: bundled,
      });
      // The phase-1 device token is a persisted SHA-256 hash (auth.ts), reloaded into
      // the registry on restart, so it authenticates the gated `/models` route while the
      // store is still sealed — no unlock needed to read the picker.
      const sealedModels = await server.app.inject({
        method: 'GET',
        url: '/models',
        headers: { authorization: `Bearer ${firstToken}` },
      });
      expect(sealedModels.statusCode).toBe(200);
      expect(sealedModels.json()).toEqual({
        models: ['codex/gpt-5.6-nova'],
        modelOrder: ['codex/gpt-5.6-nova'],
        default: 'codex/gpt-5.6-nova',
      });
      expect(bundled).toHaveBeenCalled();

      // Unlock refreshes the same credential-free catalog. The Server never
      // materializes Codex credentials merely to discover models.
      const unlock = await server.app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password, deviceLabel: 'test device' },
      });
      expect(unlock.statusCode).toBe(200);

      const unlockedModels = await server.app.inject({
        method: 'GET',
        url: '/models',
        headers: { authorization: `Bearer ${firstToken}` },
      });
      expect(unlockedModels.statusCode).toBe(200);
      expect(unlockedModels.json()).toEqual({
        models: ['codex/gpt-5.6-nova'],
        modelOrder: ['codex/gpt-5.6-nova'],
        default: 'codex/gpt-5.6-nova',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('configures the agent gateway on unlock rather than on the 60s credential timer', async () => {
    // Reproduces the self-update stall. A sealed boot cannot read the Claude
    // credential, so `agentGatewayAccessToken` stayed `undefined` — and the
    // identity projection that runs on unlock skips sending a configuration
    // entirely in that state. The synchronizer then has no snapshot, which makes
    // its 5s reconciler a no-op (`latest === undefined`), so the gateway stayed
    // unconfigured until the 60s credential timer happened to fire.
    //
    // That hole is what a self-update falls into: it replaces the gateway with a
    // fresh container, whose `/healthz` answers 200 only once the Server has
    // projected into it, and gives up after ~30s. Measured on the dev-server:
    // unlock at 08:15:22, updater gave up at 08:16:16, credential timer due at
    // 08:16:22 — six seconds short, so every update rolled back. The signature
    // was zero reconciliation attempts during the entire replacement window.
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-unlock-'));
    const dataDir = join(root, 'data');
    const socketPath = join(root, 'control.sock');
    const password = 'correct horse battery staple';
    const configured: AgentGatewayConfiguration[] = [];
    const control = await startAgentGatewayControlServer({
      socketPath,
      configure(value): void {
        configured.push(value);
      },
      status: () => ({ ready: true, configured: configured.length > 0, claudePeerCount: 0 }),
    });
    // The egress identity — the thing `projectAgentGatewayIdentity` returns early
    // without — is only built for a Docker-backed server with a clone root, so
    // this needs the full relay config rather than the gateway keys alone.
    const gatewayConfig = {
      ...testProjectRelayConfig,
      dockerBaseUrl: 'http://127.0.0.1:1',
      hostCloneRoot: '/tmp/verity-projects',
      agentGatewayControlSocket: socketPath,
      // The gateway's control protocol rejects anything that is not 64 hex
      // characters, so the shared placeholder key would fail validation rather
      // than the assertion — a green test that proves nothing.
      agentGatewayUnsealKey: 'a'.repeat(64),
    } as const;
    try {
      // Phase 1 — create the store and persist a Claude credential into it. The
      // credential is the whole point: without one stored, reading it while
      // sealed resolves harmlessly to "revoked" instead of throwing, the token
      // is settled at construction, and the bug cannot appear at all.
      const first = await buildTestEmbeddedServer({ dataDir, ...gatewayConfig });
      try {
        const init = await first.app.inject({
          method: 'POST',
          url: '/secret/init',
          payload: { password, deviceLabel: 'test device' },
        });
        expect(init.statusCode).toBe(200);
        const token = init.json().token as string;
        const login = await first.app.inject({
          method: 'PATCH',
          url: '/settings',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-db-token"}}',
            codexAuthJson:
              '{"tokens":{"access_token":"codex-access","refresh_token":"codex-refresh","account_id":"account-1"}}',
          },
        });
        expect(login.statusCode).toBe(200);
      } finally {
        // An assertion above must not leak this server's timers into the rest of
        // the suite; the phase-2 server is the suite-managed one.
        await first.close();
      }

      // Phase 2 — boot SEALED against that store, the state a host reboot or a
      // self-update handover leaves behind.
      configured.length = 0;
      server = await buildTestEmbeddedServer({ dataDir, ...gatewayConfig });
      expect(configured).toEqual([]);

      const unlock = await server.app.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password, deviceLabel: 'test device' },
      });
      expect(unlock.statusCode).toBe(200);

      // Two things are asserted, and both matter. The DEADLINE: a configuration
      // has to reach the gateway now, well inside a replacement's health window
      // — waiting longer here would pass on the unfixed code too. And the
      // CONTENT: it must carry the credential that was locked away, not a
      // revocation. A refresh that resolved to `null` would leave the gateway
      // refusing to start its listener, so `/healthz` stays 503 and the update
      // still fails — a configuration arriving is not the same as the right one.
      await vi.waitFor(
        () => expect(configured.at(-1)?.claude.credential?.accessToken).toBe('claude-db-token'),
        { timeout: 5_000 },
      );
      expect(configured.at(-1)?.codex?.credential).toMatchObject({
        unsealKey: 'a'.repeat(64),
        authJson:
          '{"tokens":{"access_token":"codex-access","refresh_token":"codex-refresh","account_id":"account-1"}}',
      });
      expect(configured.at(-1)?.codex?.credential.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the operator ordering of the OpenCode picker catalogue', async () => {
    server = await buildTestEmbeddedServer({
      extraModels: ['deepinfra/moonshotai/Kimi-K2.7-Code', 'deepinfra/zai-org/GLM-5.2'],
      openCodeEnabled: true,
    });

    const models = await server.app.inject({ method: 'GET', url: '/models' });
    expect(models.statusCode).toBe(200);
    const body = models.json<{ models: string[]; default?: string }>();
    expect(body.default).toBe('deepinfra/moonshotai/Kimi-K2.7-Code');
    expect(body.models).toEqual([
      'deepinfra/moonshotai/Kimi-K2.7-Code',
      'deepinfra/zai-org/GLM-5.2',
    ]);
  });

  it('does not expose provider-qualified extra models without an OpenCode backend', async () => {
    server = await buildTestEmbeddedServer({
      extraModels: ['deepinfra/moonshotai/Kimi-K2.7-Code', 'deepinfra/zai-org/GLM-5.2'],
    });

    const models = await server.app.inject({ method: 'GET', url: '/models' });
    expect(models.statusCode).toBe(200);
    const body = models.json<{ models: string[]; default?: string }>();
    expect(body.default).toBeUndefined();
    expect(body.models).toEqual([]);
  });

  it('boots with OpenCode enabled but no models pinned', async () => {
    // Half-configured is the deployment that used to break: the flag alone means the
    // backend exists with nothing to offer, and that must read as an empty picker
    // (200) rather than a boot failure or a 500 on /models.
    server = await buildTestEmbeddedServer({ openCodeEnabled: true });
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);

    const models = await server.app.inject({ method: 'GET', url: '/models' });
    expect(models.statusCode).toBe(200);
    const body = models.json<{ models: string[]; default?: string }>();
    expect(body.default).toBeUndefined();
    expect(body.models).toEqual([]);
  });

  it('returns the local project cache when provisioning is not configured (#174)', async () => {
    server = await buildTestEmbeddedServer({ githubToken: 'tok' });
    const res = await server.app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('does not resume relay-era Codex project turns through credential-bearing docker exec', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-relay-resume-'));
    const dataDir = join(root, 'db');
    const hostCloneRoot = join(root, 'clones');
    const worktree = join(hostCloneRoot, 'heey-global-k8s', '.verity-sessions', 'agent-test');
    mkdirSync(worktree, { recursive: true });
    const db = createEmbeddedDb(dataDir);
    await migrateToLatest(db);
    const store = new EventStore(db);
    await store.upsertProject({
      id: 'p-k8s',
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'dev-heey-k8s',
      state: 'active',
    });
    await store.createSession({
      sessionId: 's-k8s',
      worktree,
      model: 'codex/default',
      projectId: 'p-k8s',
    });
    await db.destroy();

    const binDir = join(root, 'bin');
    const argsFile = join(root, 'docker-args.json');
    mkdirSync(binDir, { recursive: true });
    const fakeDocker = join(binDir, 'docker');
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }) + "\\n");
`,
    );
    chmodSync(fakeDocker, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      server = await buildTestEmbeddedServer({
        ...testProjectRelayConfig,
        dataDir,
        dockerBaseUrl: 'http://docker-proxy:2375/v1.41',
        hostCloneRoot,
        codexEnabled: true,
        runnerSupervisor: true,
        runnerSupervisorTrustedDefaultImage: true,
      });
      const res = await server.app.inject({
        method: 'POST',
        url: '/sessions/s-k8s/turns',
        payload: { prompt: 'diagnose' },
      });
      expect(res.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const calls = readFileSync(argsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.some((call) => call.includes('codex'))).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('wires sandbox update status whenever project Docker provisioning is configured', async () => {
    server = await buildTestEmbeddedServer({
      ...testProjectRelayConfig,
      dockerBaseUrl: 'http://127.0.0.1:9234/v1.41',
      githubToken: 'tok',
      hostCloneRoot: '/data/dev',
    });

    const created = await server.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { repo: 'heey-global/legal-docs' },
    });
    expect(created.statusCode).toBe(201);

    const projects = await server.app.inject({ method: 'GET', url: '/projects' });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual([
      expect.objectContaining({
        owner: 'heey-global',
        repo: 'legal-docs',
        sandboxUpdate: expect.objectContaining({
          state: 'unknown',
          reason: 'project is not active',
        }),
      }),
    ]);
    const repositories = await server.app.inject({ method: 'GET', url: '/github/repositories' });
    expect(repositories.statusCode).toBe(200);
    expect(repositories.json()).toEqual([]);
  });

  it('rejects an unknown permissionMode at build time (not a background spawn failure)', async () => {
    await expect(buildTestEmbeddedServer({ permissionMode: 'acceptedits' })).rejects.toThrow(
      /invalid permissionMode/,
    );
  });

  it('close() is idempotent — a double call coalesces onto one teardown', async () => {
    const s = await buildTestEmbeddedServer();
    await Promise.all([s.close(), s.close()]); // concurrent
    await s.close(); // repeat after settled — still safe, no throw

    // A fresh build afterwards shares no global state.
    server = await buildTestEmbeddedServer();
    const res = await server.app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
  });
});
