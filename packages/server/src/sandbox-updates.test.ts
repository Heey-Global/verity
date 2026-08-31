import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { DockerError, type ContainerInspect, type DockerClient } from './docker.js';
import { clearRegistryTokenCache, createCachedImageVersionResolver } from './oci-ref.js';
import {
  clearSandboxVersionWarnings,
  createSandboxUpdateChecker,
  statusForInspect,
} from './sandbox-updates.js';
import { SIGNING_BROKER_TOKEN_HASH_LABEL } from './git-signer.js';

const DEFAULT_IMAGE =
  'ghcr.io/heey-global/verity/verity-sandbox@sha256:7445ec4d7aa770cb66d238621be6b4f2fc617cdc29db2142c8825f831f84fcfc';
const TOOLKIT = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:v1.11.6';

// The warn cooldown is module-global: a test that warns would otherwise
// suppress the assertion of a later one anywhere in this file.
afterEach(() => {
  clearSandboxVersionWarnings();
});

function inspect(overrides: Partial<ContainerInspect>): ContainerInspect {
  return { id: 'c1', running: true, ...overrides };
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    owner: 'heey-global',
    repo: 'legal-docs',
    containerName: 'dev-heey-global--legal-docs',
    imageRef: null,
    state: 'active',
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
    ...overrides,
  };
}

function docker(
  inspectContainer: DockerClient['inspectContainer'],
  overrides: Partial<DockerClient> = {},
): DockerClient {
  return {
    inspectContainer,
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    ...overrides,
  };
}

describe('statusForInspect', () => {
  it('marks the configured sandbox image as current', () => {
    expect(
      statusForInspect(inspect({ image: DEFAULT_IMAGE }), {
        defaultProjectImage: DEFAULT_IMAGE,
        toolkitFeatureRef: TOOLKIT,
      }),
    ).toMatchObject({ state: 'current', current: DEFAULT_IMAGE, target: DEFAULT_IMAGE });
  });

  it('marks older sandbox image refs as updateable', () => {
    expect(
      statusForInspect(
        inspect({
          image: 'ghcr.io/heey-global/verity/verity-sandbox:latest',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'org.opencontainers.image.version': 'v1.17.2',
            'org.opencontainers.image.revision': '66765c373795e06bf890ed0fb67afa1a41701df1',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          targetLabels: {
            'org.opencontainers.image.version': 'v1.18.0',
            'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
          },
        },
      ),
    ).toMatchObject({
      state: 'available',
      kind: 'normal',
      reason: 'sandbox image update available',
      current: 'ghcr.io/heey-global/verity/verity-sandbox:latest',
      target: DEFAULT_IMAGE,
      currentVersion: 'v1.17.2',
      currentRevision: '66765c373795e06bf890ed0fb67afa1a41701df1',
      targetVersion: 'v1.18.0',
      targetRevision: '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
    });
  });

  it('marks pinned sandbox image refs as current', () => {
    const pinned = 'ghcr.io/heey-global/verity/verity-sandbox@sha256:abc123';
    expect(
      statusForInspect(inspect({ image: pinned }), {
        defaultProjectImage: pinned,
        toolkitFeatureRef: TOOLKIT,
      }),
    ).toMatchObject({ state: 'current', current: pinned, target: pinned });
  });

  it('honors explicit security update metadata', () => {
    // This case used to be posed on a dev-base image, which made the security
    // classification look like a property of the retired branch. It is not: the
    // label is the publish-metadata contract from ADR 0004 ("CI stamps the
    // security class onto the published artifact"), and every surviving branch
    // reads it. Nothing in this repo stamps it yet — no LABEL in
    // deploy/verity-sandbox.Dockerfile or its workflow — so the test synthesizes
    // it, and posing it on the image Verity actually publishes is what keeps the
    // consumer side honest once the producer lands.
    expect(
      statusForInspect(
        inspect({
          image: 'ghcr.io/heey-global/verity/verity-sandbox:2026-01-01',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'dev.heey.verity.update.kind': 'security',
          },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({ state: 'available', kind: 'security' });
  });

  it('marks sandbox image labels as current', () => {
    expect(
      statusForInspect(
        inspect({
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'org.opencontainers.image.revision': 'abc123',
          },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({ state: 'current', current: 'abc123', target: DEFAULT_IMAGE });
  });

  it('marks devcontainer toolkit drift as updateable', () => {
    const current = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.9.0';
    expect(
      statusForInspect(
        inspect({
          labels: { 'devcontainer.metadata': JSON.stringify([{ id: current }]) },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({
      state: 'available',
      kind: 'normal',
      current,
      target: TOOLKIT,
    });
  });

  it('keeps current devcontainer toolkit images current', () => {
    expect(
      statusForInspect(
        inspect({
          labels: {
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
            [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'token-hash-current',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'token-hash-current',
        },
      ),
    ).toMatchObject({ state: 'current', current: TOOLKIT, target: TOOLKIT });
  });

  it('keeps a derived devcontainer with inherited sandbox labels current', () => {
    expect(
      statusForInspect(
        inspect({
          image: 'vsc-verity-legal-docs-features:derived',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'org.opencontainers.image.version': 'v1.18.0',
            'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
            [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'token-hash-current',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'token-hash-current',
          targetLabels: {
            'org.opencontainers.image.version': 'v1.18.0',
            'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
          },
        },
      ),
    ).toMatchObject({ state: 'current', current: TOOLKIT, target: TOOLKIT });
  });

  it('still detects toolkit drift on a derived image with inherited sandbox labels', () => {
    const staleToolkit = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:v1.11.5';
    expect(
      statusForInspect(
        inspect({
          image: 'vsc-verity-legal-docs-features:derived',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'devcontainer.metadata': JSON.stringify([{ id: staleToolkit }]),
          },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({
      state: 'available',
      reason: 'devcontainer toolkit update available',
      current: staleToolkit,
      target: TOOLKIT,
    });
  });

  it('still detects base image drift on a derived image with a current toolkit', () => {
    const derivedImage = 'vsc-verity-legal-docs-features:derived';
    expect(
      statusForInspect(
        inspect({
          image: derivedImage,
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'org.opencontainers.image.version': 'v1.17.2',
            'org.opencontainers.image.revision': '66765c373795e06bf890ed0fb67afa1a41701df1',
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          targetLabels: {
            'org.opencontainers.image.version': 'v1.18.0',
            'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
          },
        },
      ),
    ).toMatchObject({
      state: 'available',
      reason: 'sandbox image update available',
      current: derivedImage,
      target: DEFAULT_IMAGE,
      currentVersion: 'v1.17.2',
      targetVersion: 'v1.18.0',
    });
  });

  it('uses the resolved target version when target image labels are unavailable', () => {
    const derived = (version: string) =>
      inspect({
        image: 'vsc-verity-legal-docs-features:derived',
        labels: {
          'org.opencontainers.image.title': 'heey-global/verity-sandbox',
          'org.opencontainers.image.version': version,
          'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
        },
      });
    const target = {
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
      targetVersion: 'v1.18.0',
    };

    expect(statusForInspect(derived('v1.18.0'), target)).toMatchObject({ state: 'current' });
    expect(statusForInspect(derived('v1.17.2'), target)).toMatchObject({
      state: 'available',
      reason: 'sandbox image update available',
    });
  });

  it('does not hide base updates when a derived image loses inherited version metadata', () => {
    expect(
      statusForInspect(
        inspect({
          image: 'vsc-verity-legal-docs-features:derived',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          targetVersion: 'v1.18.0',
        },
      ),
    ).toMatchObject({
      state: 'available',
      reason: 'sandbox image update available',
    });
  });

  it('still detects broker token drift on a derived image with inherited sandbox labels', () => {
    expect(
      statusForInspect(
        inspect({
          image: 'vsc-verity-legal-docs-features:derived',
          labels: {
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
            [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'old-token-hash',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'current-token-hash',
        },
      ),
    ).toMatchObject({
      state: 'available',
      reason: 'signing broker token update available',
      current: 'stale signing broker token',
      target: 'current signing broker token',
    });
  });

  it('marks broker token hash drift as updateable', () => {
    expect(
      statusForInspect(
        inspect({
          labels: {
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
            [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'old-token-hash',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'current-token-hash',
        },
      ),
    ).toMatchObject({
      state: 'available',
      kind: 'normal',
      reason: 'signing broker token update available',
      current: 'stale signing broker token',
      target: 'current signing broker token',
    });
  });

  it('does not compare a relay capability with the legacy signing broker token', () => {
    expect(
      statusForInspect(
        inspect({
          labels: {
            'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
            'verity.container-generation': 'generation-1',
            [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'project-relay-capability-hash',
          },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'legacy-global-token-hash',
        },
      ),
    ).toMatchObject({ state: 'current', current: TOOLKIT, target: TOOLKIT });
  });

  it('marks missing broker token hash metadata as updateable when broker mode is configured', () => {
    expect(
      statusForInspect(
        inspect({
          labels: { 'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]) },
        }),
        {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
          signingBrokerTokenHash: 'current-token-hash',
        },
      ),
    ).toMatchObject({
      state: 'available',
      reason: 'signing broker token metadata missing',
      current: 'missing signing broker token metadata',
    });
  });

  it('keeps devcontainer toolkit images current when no target ref is configured', () => {
    const current = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:1.9.0';
    expect(
      statusForInspect(
        inspect({
          labels: {
            'devcontainer.metadata': JSON.stringify([
              null,
              {},
              { id: 'ghcr.io/devcontainers/features/node:1' },
              { id: current },
            ]),
          },
        }),
        { defaultProjectImage: DEFAULT_IMAGE },
      ),
    ).toMatchObject({ state: 'current', current, target: current });
  });

  it('returns unknown for custom images and malformed metadata', () => {
    expect(
      statusForInspect(
        inspect({
          image: 'ghcr.io/acme/custom:latest',
          labels: { 'devcontainer.metadata': 'nope' },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({ state: 'unknown', reason: 'project uses a custom image' });
  });

  it('treats a bare container on the retired dev-base as a custom image', () => {
    // The dedicated legacy branch is gone: a dev-base container is now simply an
    // image Verity does not publish. With no toolkit metadata to go on it gets no
    // update offer, rather than one pointing at a migration that has no
    // candidates left. Both the image name and the source label used to match
    // that branch, so both are pinned here.
    //
    // `unknown` also puts such a container out of the auto-update scheduler's
    // reach: startSandboxAutoUpdateScheduler in server.ts skips anything whose
    // `status.state !== 'available'`. Recreating it by hand stays possible either
    // way — POST /concierge/projects/:id/recreate-container never reads the
    // update state.
    // The security label is in the list deliberately: it is the one input that
    // used to change this answer. The removed branch read `updateKind(labels)`,
    // so a security-stamped dev-base container surfaced as an `available`
    // security update. It no longer does, and that is the sharpest edge of the
    // removal — pinned here rather than left to be discovered.
    for (const labels of [
      {},
      { 'org.opencontainers.image.title': 'heey-global/dev-base' },
      { 'org.opencontainers.image.source': 'https://github.com/Heey-Global/dev-server' },
      {
        'org.opencontainers.image.title': 'heey-global/dev-base',
        'dev.heey.verity.update.kind': 'security',
      },
    ]) {
      expect(
        statusForInspect(inspect({ image: 'ghcr.io/heey-global/dev-base:2026-01-01', labels }), {
          defaultProjectImage: DEFAULT_IMAGE,
          toolkitFeatureRef: TOOLKIT,
        }),
      ).toMatchObject({ state: 'unknown', reason: 'project uses a custom image' });
    }
  });

  it('tracks a dev-base container that carries the toolkit by its toolkit ref', () => {
    // The removed branch ran BEFORE the toolkit check, so it also decided the
    // precedence: a dev-base container carrying the Feature reported the
    // migration, never its toolkit state. Now the toolkit branch sees it first,
    // which is the point — that container is exactly what the retirement assumes
    // the fleet has become, and it is tracked like any other custom base with the
    // Feature: a stale ref is offered, a matching one reads current.
    const stale = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit:v1.9.0';
    const devBase = { image: 'ghcr.io/heey-global/dev-base:2026-01-01' };
    expect(
      statusForInspect(
        inspect({
          ...devBase,
          labels: { 'devcontainer.metadata': JSON.stringify([{ id: stale }]) },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({ state: 'available', current: stale, target: TOOLKIT });
    // Current toolkit, retired base: reported current. Verity tracks the Feature
    // it ships, not a base image it does not publish — the same answer any other
    // custom devcontainer gets, and the reason the base itself needs no branch.
    expect(
      statusForInspect(
        inspect({
          ...devBase,
          labels: { 'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]) },
        }),
        { defaultProjectImage: DEFAULT_IMAGE, toolkitFeatureRef: TOOLKIT },
      ),
    ).toMatchObject({ state: 'current', current: TOOLKIT, target: TOOLKIT });
  });
});

describe('createSandboxUpdateChecker', () => {
  it('does not inspect inactive projects', async () => {
    const inspectContainer = vi.fn<DockerClient['inspectContainer']>();
    const checker = createSandboxUpdateChecker({
      docker: docker(inspectContainer),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });

    await expect(checker.status(project({ state: 'absent' }))).resolves.toMatchObject({
      state: 'unknown',
      reason: 'project is not active',
    });
    expect(inspectContainer).not.toHaveBeenCalled();
  });

  it('returns unknown when the container is gone or stopped', async () => {
    const checkerGone = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () => {
          throw new DockerError({ kind: 'container_not_found', id: 'missing' });
        }),
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });
    await expect(checkerGone.status(project())).resolves.toMatchObject({
      state: 'unknown',
      reason: 'container is not running',
    });

    const checkerStopped = createSandboxUpdateChecker({
      docker: docker(vi.fn(async () => inspect({ image: DEFAULT_IMAGE, running: false }))),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });
    await expect(checkerStopped.status(project())).resolves.toMatchObject({
      state: 'unknown',
      reason: 'container is not running',
    });
  });

  it('returns unknown when inspect fails unexpectedly', async () => {
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () => {
          throw new Error('docker unavailable');
        }),
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'unknown',
      reason: 'container inspect failed',
    });
  });

  it('uses the configured broker token hash provider when checking a running container', async () => {
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            labels: {
              'devcontainer.metadata': JSON.stringify([{ id: TOOLKIT }]),
              [SIGNING_BROKER_TOKEN_HASH_LABEL]: 'old-token-hash',
            },
          }),
        ),
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
      signingBrokerTokenHash: vi.fn(async () => 'current-token-hash'),
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'available',
      reason: 'signing broker token update available',
    });
  });

  it('adds target image metadata from the local Docker image when available', async () => {
    const inspectImageLabels = vi.fn(async () => ({
      'org.opencontainers.image.version': 'v1.18.0',
      'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
    }));
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            image: 'ghcr.io/heey-global/verity/verity-sandbox:latest',
            labels: {
              'org.opencontainers.image.title': 'heey-global/verity-sandbox',
              'org.opencontainers.image.version': 'v1.17.2',
              'org.opencontainers.image.revision': '66765c373795e06bf890ed0fb67afa1a41701df1',
            },
          }),
        ),
        { inspectImageLabels },
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'available',
      currentVersion: 'v1.17.2',
      currentRevision: '66765c373795e06bf890ed0fb67afa1a41701df1',
      targetVersion: 'v1.18.0',
      targetRevision: '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
    });
    expect(inspectImageLabels).toHaveBeenCalledWith(DEFAULT_IMAGE);
  });

  it('does not ask the registry for a version the local image labels already carry', async () => {
    // `statusForInspect` prefers the label, so resolving the registry version
    // here spends a three-request manifest walk on a value it then discards.
    const defaultProjectImageVersion = vi.fn(async () => 'v1.18.0');
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
            labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
          }),
        ),
        {
          inspectImageLabels: vi.fn(async () => ({
            'org.opencontainers.image.version': 'v1.18.0',
          })),
        },
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      defaultProjectImageVersion,
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'available',
      targetVersion: 'v1.18.0',
    });
    expect(defaultProjectImageVersion).not.toHaveBeenCalled();
  });

  it('fills the target version from the labels on the up-to-date and outdated rows too', async () => {
    // The laziness rests on `statusForInspect` preferring the label in EVERY
    // branch, not just the one the test above happens to take. A branch that
    // read the resolved version directly would silently lose it here.
    const defaultProjectImageVersion = vi.fn(async () => 'v1.18.0');
    const checkerFor = (inspected: Partial<ContainerInspect>) =>
      createSandboxUpdateChecker({
        docker: docker(
          vi.fn(async () => inspect(inspected)),
          {
            inspectImageLabels: vi.fn(async () => ({
              'org.opencontainers.image.version': 'v1.18.0',
            })),
          },
        ),
        defaultProjectImage: DEFAULT_IMAGE,
        defaultProjectImageVersion,
      });

    // Already on the target image: the `current` branch.
    await expect(checkerFor({ image: DEFAULT_IMAGE }).status(project())).resolves.toMatchObject({
      state: 'current',
      targetVersion: 'v1.18.0',
    });
    // A container on an older sandbox image: the `available` branch.
    await expect(
      checkerFor({
        image: 'ghcr.io/heey-global/verity/verity-sandbox:2026-01-01',
        labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
      }).status(project()),
    ).resolves.toMatchObject({ state: 'available', targetVersion: 'v1.18.0' });
    expect(defaultProjectImageVersion).not.toHaveBeenCalled();
  });

  it('still asks the registry when the local labels exist but carry no version', async () => {
    // Laziness keys on the version label, not on whether labels were readable
    // at all — an image built without one must not silently lose its target.
    const defaultProjectImageVersion = vi.fn(async () => 'v1.18.0');
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
            labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
          }),
        ),
        {
          inspectImageLabels: vi.fn(async () => ({
            'org.opencontainers.image.title': 'heey-global/verity-sandbox',
          })),
        },
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      defaultProjectImageVersion,
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'available',
      targetVersion: 'v1.18.0',
    });
    expect(defaultProjectImageVersion).toHaveBeenCalledOnce();
  });

  it('reports a failed version resolution instead of dropping it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
            labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
          }),
        ),
        { inspectImageLabels: vi.fn(async () => undefined) },
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      defaultProjectImageVersion: vi.fn(async () => {
        throw new Error('ghcr.io says no');
      }),
    });

    // The check still answers — a missing target version is not a failed
    // status — but the registry error has to leave a trace somewhere.
    await expect(checker.status(project())).resolves.toMatchObject({ targetVersion: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghcr.io says no'));
    // The caller is a poll: a registry that stays down must not reprint the
    // same line on every refresh for as long as the outage lasts.
    await checker.status(project());
    await checker.status(project());
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('uses the published semver ref when the target image is not local yet', async () => {
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async () =>
          inspect({
            image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
            labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
          }),
        ),
        { inspectImageLabels: vi.fn(async () => undefined) },
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      defaultProjectImageVersion: 'ghcr.io/heey-global/verity/verity-sandbox:1.18.0',
    });

    await expect(checker.status(project())).resolves.toMatchObject({
      state: 'available',
      targetVersion: 'v1.18.0',
    });
  });
});

describe('createSandboxUpdateChecker.statusAll', () => {
  const projects = (count: number, overrides: Partial<ProjectRecord> = {}) =>
    Array.from({ length: count }, (_, index) =>
      project({ id: `p${index}`, containerName: `c${index}`, ...overrides }),
    );

  /** A checker whose every request-constant input counts how often it was asked. */
  function countingChecker(targetLabels: Record<string, string> | undefined) {
    const counts = { image: 0, imageLabels: 0, version: 0, toolkit: 0, brokerHash: 0 };
    const inspectContainer = vi.fn(async () =>
      inspect({
        image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
        labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
      }),
    );
    const checker = createSandboxUpdateChecker({
      docker: docker(inspectContainer, {
        inspectImageLabels: vi.fn(async () => {
          counts.imageLabels += 1;
          return targetLabels;
        }),
      }),
      defaultProjectImage: async () => {
        counts.image += 1;
        return DEFAULT_IMAGE;
      },
      defaultProjectImageVersion: async () => {
        counts.version += 1;
        return 'v1.18.0';
      },
      toolkitFeatureRef: async () => {
        counts.toolkit += 1;
        return TOOLKIT;
      },
      signingBrokerTokenHash: async () => {
        counts.brokerHash += 1;
        return null;
      },
    });
    return { checker, counts, inspectContainer };
  }

  it('resolves the request-constant target once for the whole list', async () => {
    // The regression this guards: every one of these was resolved per project,
    // so an overview poll over ten projects walked ghcr.io ten times for one
    // answer. Only the container inspect is genuinely per project.
    const { checker, counts, inspectContainer } = countingChecker(undefined);

    const statuses = await checker.statusAll(projects(10));

    expect(statuses.size).toBe(10);
    expect(inspectContainer).toHaveBeenCalledTimes(10);
    expect(counts).toEqual({ image: 1, imageLabels: 1, version: 1, toolkit: 1, brokerHash: 1 });
  });

  it('asks the registry for no version at all when the local image labels carry one', async () => {
    const { checker, counts } = countingChecker({
      'org.opencontainers.image.version': 'v1.18.0',
    });

    const statuses = await checker.statusAll(projects(10));

    expect(counts.version).toBe(0);
    expect([...statuses.values()].every((status) => status.targetVersion === 'v1.18.0')).toBe(true);
  });

  it('resolves no target at all when no project has a container to compare', async () => {
    const { checker, counts } = countingChecker(undefined);

    const statuses = await checker.statusAll(projects(5, { state: 'absent' }));

    expect(statuses.size).toBe(5);
    for (const status of statuses.values()) {
      expect(status).toMatchObject({ state: 'unknown', reason: 'project is not active' });
    }
    expect(counts).toEqual({ image: 0, imageLabels: 0, version: 0, toolkit: 0, brokerHash: 0 });
  });

  it('keys each status by its own project id, checkable or not', async () => {
    const checker = createSandboxUpdateChecker({
      docker: docker(
        vi.fn(async (name: string) => {
          if (name === 'c1') throw new DockerError({ kind: 'container_not_found', id: name });
          return inspect({ image: DEFAULT_IMAGE });
        }),
      ),
      defaultProjectImage: DEFAULT_IMAGE,
      toolkitFeatureRef: TOOLKIT,
    });

    const statuses = await checker.statusAll([
      project({ id: 'p0', containerName: 'c0' }),
      project({ id: 'p1', containerName: 'c1' }),
      project({ id: 'p2', containerName: 'c2', state: 'absent' }),
    ]);

    expect(statuses.get('p0')).toMatchObject({ state: 'current' });
    expect(statuses.get('p1')).toMatchObject({ reason: 'container is not running' });
    expect(statuses.get('p2')).toMatchObject({ reason: 'project is not active' });
  });

  it('reports the image as unavailable per project rather than failing the batch', async () => {
    const checker = createSandboxUpdateChecker({
      docker: docker(vi.fn(async () => inspect({ image: DEFAULT_IMAGE }))),
      defaultProjectImage: async () => undefined,
    });

    const statuses = await checker.statusAll(projects(3));

    expect(statuses.size).toBe(3);
    for (const status of statuses.values()) {
      expect(status).toMatchObject({
        state: 'unknown',
        reason: 'default project image is unavailable',
      });
    }
  });

  /**
   * What an overview poll actually costs at ghcr.io, measured through the real
   * version resolver rather than a stub.
   *
   * The regression being pinned: this path used to issue one three-manifest
   * walk per project per request — nine HTTPS requests each, because the pull
   * token was thrown away between reads — several times a minute, per client.
   */
  describe('registry cost of a steady-state poll', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      clearRegistryTokenCache();
    });

    const ghcr = () => {
      const requests: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          requests.push(url);
          if (url.startsWith('https://ghcr.io/token')) {
            return Response.json({ token: 'pull', expires_in: 300 });
          }
          // ghcr.io answers every anonymous /v2/ read with a challenge, which is
          // why an uncached token turns each read into three requests.
          if ((init?.headers as Record<string, string> | undefined)?.authorization === undefined) {
            return new Response(null, {
              status: 401,
              headers: {
                'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
              },
            });
          }
          if (url.endsWith('/manifests/sha256:target')) {
            return Response.json({
              manifests: [
                { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
              ],
            });
          }
          if (url.includes('/manifests/')) return Response.json({ config: { digest: 'sha256:c' } });
          return Response.json({
            config: { Labels: { 'org.opencontainers.image.version': 'v1.18.0' } },
          });
        }),
      );
      return requests;
    };

    const pollChecker = (targetLabels: Record<string, string> | undefined) =>
      createSandboxUpdateChecker({
        docker: docker(
          vi.fn(async () =>
            inspect({
              image: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:old',
              labels: { 'org.opencontainers.image.title': 'heey-global/verity-sandbox' },
            }),
          ),
          { inspectImageLabels: vi.fn(async () => targetLabels) },
        ),
        defaultProjectImage: 'ghcr.io/heey-global/verity/verity-sandbox@sha256:target',
        defaultProjectImageVersion: createCachedImageVersionResolver(),
      });

    it('touches the registry not at all while the local image can answer', async () => {
      const requests = ghcr();
      const checker = pollChecker({ 'org.opencontainers.image.version': 'v1.18.0' });

      for (let poll = 0; poll < 3; poll += 1) await checker.statusAll(projects(10));

      expect(requests).toEqual([]);
    });

    it('walks it once for the whole TTL window when the local image cannot', async () => {
      const requests = ghcr();
      const checker = pollChecker(undefined);

      for (let poll = 0; poll < 3; poll += 1) await checker.statusAll(projects(10));

      // Three polls over ten projects: one manifest walk, and one token minted
      // for it rather than one per read. Thirty walks and 270 requests before.
      expect(requests).toEqual([
        'https://ghcr.io/v2/heey-global/verity/verity-sandbox/manifests/sha256:target',
        'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aheey-global%2Fverity%2Fverity-sandbox%3Apull',
        'https://ghcr.io/v2/heey-global/verity/verity-sandbox/manifests/sha256:target',
        'https://ghcr.io/v2/heey-global/verity/verity-sandbox/manifests/sha256:amd64',
        'https://ghcr.io/v2/heey-global/verity/verity-sandbox/blobs/sha256:c',
      ]);
    });
  });
});
