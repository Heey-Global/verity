/**
 * Host garbage collection for the Docker resources Verity creates.
 *
 * Verity's two container-adjacent caches were both append-only, and a long-lived
 * runner filled its disk because of it:
 *
 *  1. **Devcontainer images.** `Provisioner.resolveOrBuildImage` is a
 *     content-addressed cache — it hashes `.devcontainer/` plus the resolved base
 *     image into `verity-devc-<owner>-<repo>:<hash12>`, reuses that tag when it
 *     exists, and builds it otherwise. Correct as a cache, but nothing ever
 *     retired the superseded tags: every sandbox base-image release (routinely
 *     daily) re-hashes every project, so each repo accumulated one 5–7 GB image
 *     per release, forever. `docker system prune` cannot help — the old tags are
 *     tagged, not dangling.
 *  2. **Anonymous volumes.** Fixed at the source in `docker.ts` (`removeContainer`
 *     now passes `v=true`), but that only stops NEW leakage; volumes already
 *     orphaned by past teardowns, and any minted by tooling outside Verity's
 *     container lifecycle (devcontainer CLI, buildx), still need sweeping.
 *  3. **Orphaned buildx builder state volumes.** A `docker buildx` builder on the
 *     `docker-container` driver keeps its BuildKit cache in a
 *     `buildx_buildkit_builder-<uuid>_state` volume. When the builder is removed
 *     or orphaned (daemon restart, `buildx rm`, a CI job that creates a throwaway
 *     builder), that volume is NOT cleaned up — and its cache runs to multiple GB
 *     each. Critically, this cache is INVISIBLE to the build-cache prune below:
 *     that prunes the daemon's own BuildKit, a `docker-container` builder is a
 *     separate BuildKit instance. On one runner 12 such volumes had accumulated to
 *     ~45 GB. A builder volume that appears in the daemon's `dangling=true` listing
 *     has no builder container mounting it, so it is orphaned and safe to sweep.
 *
 *  4. **Superseded project relays.** Each sandbox generation gets its own relay
 *     container (`project-relay-docker.ts`), and the only thing that ever removed
 *     one was `ProjectRelayLifecycle.stop`, which tears down what THIS process
 *     holds in memory. A control-plane restart empties that map, so relays started
 *     by the previous process become unowned: the reconciler correctly classifies
 *     their sandboxes as `orphaned` and recreates them (each minting a fresh
 *     generation and a fresh relay), while `stop` is a no-op for the old container.
 *     Net effect: one leaked relay per project per restart, running indefinitely
 *     with a project-network attachment — exactly what
 *     `deploy/bin/verity-project-relay-cutover-check.mjs` reports as
 *     "relay … has 0 matching sandboxes". Each is small (64 MiB, 0.25 CPU) but the
 *     leak is unbounded, and no other pass reclaims them.
 *
 * Design notes:
 *  - The policy decisions are PURE functions ({@link planImageSweep},
 *    {@link planVolumeSweep}, {@link planBuilderVolumeSweep},
 *    {@link planRelaySweep}) taking daemon state and returning what to delete, so
 *    the "never delete the wrong thing" guarantees are unit-testable without a
 *    daemon. {@link runDockerGc} is the thin impure shell around them.
 *  - Deletion is deliberately narrow. Images must carry a
 *    {@link DEVCONTAINER_IMAGE_PREFIX} tag; anonymous volumes must be dangling AND
 *    carry the daemon's anonymous label AND have a daemon-generated 64-hex name;
 *    builder volumes must be dangling AND match the `buildx_buildkit_builder-*
 *    _state` name; a relay container must carry Verity's own
 *    {@link RELAY_COMPONENT_LABEL} plus both identity labels AND have no sandbox
 *    left anywhere on the daemon carrying its exact project + generation. A
 *    hand-created or Verity-owned named volume (`verity-data`, `verity-db`), a
 *    foreign container, and a live generation's relay match none of these, so no
 *    reachable input makes this module touch durable state.
 *  - A failure on one resource is logged and skipped, never fatal: a half-swept
 *    pass still reclaims space, and the next pass retries.
 *
 * Scheduling follows the house pattern for daily server work (see
 * `agent-loop-scheduler.ts`) — a single self-rescheduling unref'd timer, an
 * overlap guard, and a disposer.
 */
import { statfs } from 'node:fs/promises';
import { DockerError } from './docker.js';
import { DEVCONTAINER_IMAGE_PREFIX } from './provisioner.js';
import type {
  DockerClient,
  DockerContainerSummary,
  DockerImageSummary,
  DockerVolumeSummary,
} from './docker.js';

/** Label the daemon sets on volumes it minted itself for an image's `VOLUME`
 *  instruction. Its presence is a hard precondition for deletion — an operator's
 *  named volume never carries it. */
const ANONYMOUS_VOLUME_LABEL = 'com.docker.volume.anonymous';

/** Shape of a daemon-generated anonymous volume name (the same 64-hex id form
 *  Docker uses for content ids). Belt-and-braces alongside the label check: even
 *  if some tool mislabelled a volume, a human-meaningful name like `verity-data`
 *  cannot match this. */
const ANONYMOUS_VOLUME_NAME = /^[0-9a-f]{64}$/;

/** Name of a buildx `docker-container` driver builder's state volume. buildx
 *  creates exactly one per builder as `buildx_buildkit_builder-<uuid>_state`; a
 *  volume matching this that ALSO appears in the daemon's dangling listing has no
 *  builder container mounting it and is therefore orphaned. The active `default`
 *  builder uses the `docker` driver and has no such volume, so it is never at
 *  risk. */
const BUILDER_STATE_VOLUME_NAME = /^buildx_buildkit_[a-z0-9][a-z0-9_.-]{1,127}_state$/i;

/** `verity.component` value every project relay carries. Owned by
 *  `project-relay-docker.ts`; duplicated as a constant here rather than imported
 *  so the GC's delete predicate stays readable in one place, and asserted equal in
 *  the tests. */
const RELAY_COMPONENT_LABEL = 'project-relay';
/** Value this label carried before ADR 0013 renamed the component. Relays are
 *  found again only by label, so a relay minted by an older Verity would be
 *  invisible to the sweep below — and, worse, would fall on the sandbox side of
 *  every `!== RELAY_COMPONENT_LABEL` test and so vouch for its own generation.
 *  Recognised for collection only; nothing mints it. */
const LEGACY_RELAY_COMPONENT_LABEL = 'project-broker-relay';

/** True for a relay Verity minted under either the current or the pre-ADR-0013
 *  component label. */
function isRelayComponent(component: string | undefined): boolean {
  return component === RELAY_COMPONENT_LABEL || component === LEGACY_RELAY_COMPONENT_LABEL;
}
/** Label pairing a relay and the one sandbox generation it serves. Both are set by
 *  the relay adapter and the provisioner from the same identity. */
const PROJECT_ID_LABEL = 'verity.project-id';
const CONTAINER_GENERATION_LABEL = 'verity.container-generation';
const COMPONENT_LABEL = 'verity.component';

export interface DockerGcPolicy {
  /** Devcontainer image generations to keep per `<owner>-<repo>`, newest first.
   *  Above 1 so an in-flight provision that resolved the previous hash — or a
   *  quick revert of a `.devcontainer/` edit — still hits a warm cache. */
  keepImagesPerRepo: number;
  /** Grace period before a dangling anonymous volume is swept. Guards the window
   *  between `containers/create` and `containers/start`, where a just-minted
   *  volume is briefly attached to nothing and would otherwise look collectable. */
  volumeMinAgeMs: number;
  /** Build-cache entries older than this are pruned. `undefined` disables the
   *  build-cache step entirely. */
  buildCacheMaxAgeMs?: number | undefined;
  /** Sweep orphaned buildx `docker-container` builder state volumes (a dangling
   *  `buildx_buildkit_builder-*_state`). Their BuildKit cache is invisible to the
   *  build-cache prune (a separate BuildKit instance) and reaches tens of GB, so
   *  this is on by default. */
  sweepOrphanedBuilderVolumes: boolean;
  /** Sweep project relays whose sandbox generation no longer exists. On by
   *  default: nothing else reclaims them after a control-plane restart. */
  sweepSupersededRelays: boolean;
  /** Grace period before a relay with no matching sandbox is swept. Guards the
   *  provisioning window: the relay is started BEFORE its sandbox container is
   *  created, and between the two the provisioner may still pull a multi-GB
   *  sandbox image. 30 minutes is far beyond that window and far below the daily
   *  pass interval, so a relay is only ever collected once it is genuinely
   *  superseded. A relay whose creation time the daemon did not report is never
   *  swept — without an age this cannot prove the window has passed. */
  relayMinAgeMs: number;
  /** Below this much free space on the data root, the pass switches to
   *  {@link lowDiskKeepImagesPerRepo} and ignores {@link volumeMinAgeMs}.
   *  `undefined` disables disk-pressure escalation. */
  lowDiskFreeBytes?: number | undefined;
  /** Generations to keep per repo while under disk pressure. */
  lowDiskKeepImagesPerRepo: number;
}

export const DEFAULT_DOCKER_GC_POLICY: DockerGcPolicy = {
  keepImagesPerRepo: 2,
  volumeMinAgeMs: 60 * 60_000,
  // 3 days. The original 7-day default was too conservative for a busy build
  // host: one runner churned >60 GB of build cache — all of it younger than a
  // week — so the prune reclaimed nothing. 3 days keeps a useful warm cache while
  // bounding the growth.
  buildCacheMaxAgeMs: 3 * 24 * 60 * 60_000,
  sweepOrphanedBuilderVolumes: true,
  sweepSupersededRelays: true,
  relayMinAgeMs: 30 * 60_000,
  lowDiskFreeBytes: 40 * 1024 ** 3,
  lowDiskKeepImagesPerRepo: 1,
};

export interface DockerGcLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface DockerGcDeps {
  docker: DockerClient;
  log: DockerGcLogger;
  policy?: Partial<DockerGcPolicy>;
  /** Path whose filesystem free space drives disk-pressure escalation — the
   *  Verity data root in production. Omit to disable the probe. */
  dataRoot?: string;
  /** Injectable free-space probe (tests). Defaults to `statfs` on `dataRoot`. */
  freeBytes?: () => Promise<number | undefined>;
  /** Injectable clock in ms (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Project + generation of every relay this process currently holds — the relay
   *  lifecycle's own view. Omitting it falls back to the listing plus elapsed
   *  time, neither of which can see a provision whose sandbox does not exist yet;
   *  wire it wherever both the GC and the lifecycle are available. */
  heldRelays?: () => Iterable<{ projectId: string; containerGeneration: string }>;
}

export interface DockerGcReport {
  imagesRemoved: string[];
  /** Sum of the removed images' apparent sizes. An UPPER BOUND on space actually
   *  reclaimed: the Engine counts shared layers once per image, so two generations
   *  sharing a base double-count it. Fine for logging, not for accounting. */
  estimatedImageBytes: number;
  volumesRemoved: number;
  /** Orphaned buildx builder state volumes removed this pass. */
  builderVolumesRemoved: number;
  /** Names of the superseded project relays removed this pass. */
  relaysRemoved: string[];
  buildCacheBytes: number;
  /** True when the pass ran with the escalated low-disk policy. */
  lowDisk: boolean;
  /** Per-resource failures that were skipped rather than aborting the pass. */
  errors: Array<{ resource: string; message: string }>;
}

/** Split `repo:tag` into its repository part. Uses the LAST colon so a future
 *  registry-qualified tag (`host:5000/name:tag`) still splits correctly, and
 *  returns undefined for a ref with no tag (nothing to group). */
function repositoryOf(ref: string): string | undefined {
  const colon = ref.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const repo = ref.slice(0, colon);
  // A colon that belongs to a registry host+port has a `/` after it; that is a
  // repository path, not a tag separator.
  if (ref.slice(colon + 1).includes('/')) return undefined;
  return repo;
}

export interface ImageSweepPlan {
  ref: string;
  imageId: string;
  size: number;
}

/**
 * Decide which devcontainer image tags to retire.
 *
 * Only tags under {@link DEVCONTAINER_IMAGE_PREFIX} are considered. Within each
 * repository the newest `keepPerRepo` generations survive; so does any image a
 * container still references, however old — a long-running sandbox pinned to an
 * older generation must never have its image pulled out from under it.
 *
 * Ties on `created` (two images built in the same second) break on id so the plan
 * is deterministic; without that, a tie could retire a different image each pass.
 */
export function planImageSweep(input: {
  images: readonly DockerImageSummary[];
  /** Image content ids referenced by any container, running or stopped. */
  inUseImageIds: ReadonlySet<string>;
  keepPerRepo: number;
}): ImageSweepPlan[] {
  const byRepository = new Map<string, Map<string, DockerImageSummary>>();
  for (const image of input.images) {
    for (const ref of image.repoTags) {
      const repository = repositoryOf(ref);
      if (repository === undefined) continue;
      if (!repository.startsWith(DEVCONTAINER_IMAGE_PREFIX)) continue;
      const group = byRepository.get(repository) ?? new Map<string, DockerImageSummary>();
      group.set(image.id, image);
      byRepository.set(repository, group);
    }
  }
  const plan: ImageSweepPlan[] = [];
  for (const [repository, group] of byRepository) {
    const ordered = [...group.values()].sort(
      (a, b) => b.created - a.created || a.id.localeCompare(b.id),
    );
    for (const image of ordered.slice(Math.max(0, input.keepPerRepo))) {
      if (input.inUseImageIds.has(image.id)) continue;
      for (const ref of image.repoTags) {
        if (repositoryOf(ref) !== repository) continue;
        plan.push({ ref, imageId: image.id, size: image.size });
      }
    }
  }
  return plan;
}

/**
 * Decide which dangling volumes to sweep.
 *
 * All three conditions must hold: the daemon's anonymous label, a
 * daemon-generated 64-hex name, and an age past `minAgeMs`. `volumes` is expected
 * to be the daemon's own `dangling=true` listing — attachment is decided daemon-
 * side, so this function never has to reason about it.
 *
 * A volume with no parseable `createdAt` is treated as OLD (the daemon has
 * reported this field for many releases; an absent one means a very old volume,
 * which is exactly what should be swept — not something to protect indefinitely).
 */
export function planVolumeSweep(input: {
  volumes: readonly DockerVolumeSummary[];
  nowMs: number;
  minAgeMs: number;
}): string[] {
  return input.volumes
    .filter((volume) => {
      if (!(ANONYMOUS_VOLUME_LABEL in volume.labels)) return false;
      if (!ANONYMOUS_VOLUME_NAME.test(volume.name)) return false;
      if (volume.createdAt === undefined) return false;
      const created = Date.parse(volume.createdAt);
      if (Number.isNaN(created)) return false;
      if (input.minAgeMs <= 0) return true;
      return input.nowMs - created >= input.minAgeMs;
    })
    .map((volume) => volume.name);
}

/**
 * Decide which orphaned buildx builder state volumes to sweep.
 *
 * Both conditions must hold: the `buildx_buildkit_builder-*_state` name and an age
 * past `minAgeMs`. As with {@link planVolumeSweep}, `volumes` is expected to be
 * the daemon's `dangling=true` listing — an ACTIVE builder mounts its state
 * volume, so it never appears there; only an orphaned one does. The name match is
 * what distinguishes a builder volume from an anonymous volume (their name shapes
 * are disjoint), so the two planners never both claim the same volume.
 *
 * An absent/unparseable `createdAt` is treated as OLD, same rationale as
 * {@link planVolumeSweep}.
 */
export function planBuilderVolumeSweep(input: {
  volumes: readonly DockerVolumeSummary[];
  nowMs: number;
  minAgeMs: number;
}): string[] {
  return input.volumes
    .filter((volume) => {
      if (!BUILDER_STATE_VOLUME_NAME.test(volume.name)) return false;
      if (volume.createdAt === undefined) return false;
      const created = Date.parse(volume.createdAt);
      if (Number.isNaN(created)) return false;
      if (input.minAgeMs <= 0) return true;
      return input.nowMs - created >= input.minAgeMs;
    })
    .map((volume) => volume.name);
}

export interface RelaySweepPlan {
  /** Container id to stop and remove. */
  id: string;
  /** Best-effort display name for the log line; the id when the daemon reported none. */
  name: string;
  projectId: string;
  generation: string;
}

/**
 * Decide which project relays are superseded and collectable.
 *
 * A relay is only ever a target when ALL of these hold:
 *  - it carries `verity.component=project-relay` — Verity minted it;
 *  - it carries a non-empty project id AND container generation — an unstamped
 *    relay cannot be proven superseded, so it is left for a human;
 *  - NO container in the listing (running or stopped) is a sandbox carrying that
 *    exact project id + generation — i.e. the generation it was built to serve is
 *    gone, so it can never be reached again; the sandbox's broker hostname is
 *    baked into a container that no longer exists;
 *  - this process is not currently HOLDING it (`held`);
 *  - the daemon reported a creation time and it is older than `minAgeMs`.
 *
 * `containers` is expected to be the daemon's `all=true` listing, so a merely
 * STOPPED sandbox still protects its relay: the reconciler can restart that
 * generation, and pulling its relay out from under it would strand it.
 *
 * `held` closes the one gap the listing cannot, because the answer is not in the
 * listing at all: a provision that started its relay but has not created its
 * sandbox yet. `minAgeMs` is elapsed time, which a stalled multi-GB image pull
 * outlasts, and re-listing before the removal only narrows the window between
 * planning and deleting — both still see a project with no sandbox and collect
 * the relay it is about to be wired to. A held relay is in use by definition, so
 * it is excluded regardless of age.
 */
export function planRelaySweep(input: {
  containers: readonly DockerContainerSummary[];
  nowMs: number;
  minAgeMs: number;
  /** Project + generation of every relay this process currently holds. */
  held?: Iterable<{ projectId: string; containerGeneration: string }> | undefined;
}): RelaySweepPlan[] {
  const heldGenerations = new Set(
    [...(input.held ?? [])].map((relay) =>
      generationKey(relay.projectId, relay.containerGeneration),
    ),
  );
  const isRelay = (container: DockerContainerSummary): boolean =>
    isRelayComponent(container.labels?.[COMPONENT_LABEL]);
  const servedGenerations = new Set(
    input.containers.flatMap((container) => {
      if (isRelay(container)) return [];
      const projectId = container.labels?.[PROJECT_ID_LABEL];
      const generation = container.labels?.[CONTAINER_GENERATION_LABEL];
      if (!projectId || !generation) return [];
      return [generationKey(projectId, generation)];
    }),
  );
  return input.containers.flatMap((container): RelaySweepPlan[] => {
    if (!isRelay(container)) return [];
    const projectId = container.labels?.[PROJECT_ID_LABEL];
    const generation = container.labels?.[CONTAINER_GENERATION_LABEL];
    if (!projectId || !generation) return [];
    if (servedGenerations.has(generationKey(projectId, generation))) return [];
    if (heldGenerations.has(generationKey(projectId, generation))) return [];
    if (container.created === undefined) return [];
    if (input.nowMs - container.created * 1000 < input.minAgeMs) return [];
    return [
      { id: container.id, name: container.names?.[0] ?? container.id, projectId, generation },
    ];
  });
}

function generationKey(projectId: string, generation: string): string {
  return `${projectId}\0${generation}`;
}

async function probeFreeBytes(dataRoot: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dataRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // A missing/unreadable root must not break the sweep; it only means disk
    // pressure cannot be detected, so the pass runs the normal policy.
    return undefined;
  }
}

/** Run one GC pass. Resolves with what it did; only a failure to even list the
 *  daemon's state rejects, and {@link startDockerGcScheduler} catches that too. */
export async function runDockerGc(deps: DockerGcDeps): Promise<DockerGcReport> {
  const policy: DockerGcPolicy = { ...DEFAULT_DOCKER_GC_POLICY, ...deps.policy };
  const now = deps.now ?? Date.now;
  const { docker, log } = deps;
  const errors: DockerGcReport['errors'] = [];

  const freeBytes =
    deps.freeBytes !== undefined
      ? await deps.freeBytes()
      : deps.dataRoot !== undefined
        ? await probeFreeBytes(deps.dataRoot)
        : undefined;
  const lowDisk =
    policy.lowDiskFreeBytes !== undefined &&
    freeBytes !== undefined &&
    freeBytes < policy.lowDiskFreeBytes;
  const keepPerRepo = lowDisk ? policy.lowDiskKeepImagesPerRepo : policy.keepImagesPerRepo;
  // Disk pressure may reduce retained image generations, but never remove the
  // create-to-attach grace window for volumes: a fresh volume is not reclaimable
  // merely because the host is low on space.
  const volumeMinAgeMs = policy.volumeMinAgeMs;

  const report: DockerGcReport = {
    imagesRemoved: [],
    estimatedImageBytes: 0,
    volumesRemoved: 0,
    builderVolumesRemoved: 0,
    relaysRemoved: [],
    buildCacheBytes: 0,
    lowDisk,
    errors,
  };

  // --- Devcontainer images -------------------------------------------------
  // Requires listContainers as well: without the in-use set this would happily
  // delete the image a live sandbox runs on, so skip the whole step rather than
  // sweep blind against a client that lacks either call.
  if (docker.listImages !== undefined && docker.listContainers !== undefined) {
    try {
      const [images, containers] = await Promise.all([
        docker.listImages(),
        docker.listContainers(),
      ]);
      const inUseImageIds = new Set(containers.map((container) => container.imageId));
      const plan = planImageSweep({ images, inUseImageIds, keepPerRepo });
      for (const entry of plan) {
        try {
          await docker.removeImage?.(entry.ref);
          report.imagesRemoved.push(entry.ref);
          report.estimatedImageBytes += entry.size;
        } catch (err) {
          // Most commonly a 409: a container grabbed the image between the
          // listing and the delete. Next pass re-evaluates.
          errors.push({ resource: `image ${entry.ref}`, message: errorMessage(err) });
        }
      }
    } catch (err) {
      errors.push({ resource: 'images', message: errorMessage(err) });
    }
  }

  // --- Superseded project relays -------------------------------------------
  // Deliberately its own listing rather than reusing the images step's: that step
  // is skipped whenever `listImages` is absent, and a relay leak must still be
  // reclaimed then. Unlike the disk steps this one is NOT escalated under disk
  // pressure — the grace period exists to protect an in-flight provision, and a
  // full disk is no reason to strand a sandbox that is still coming up.
  if (policy.sweepSupersededRelays && docker.listContainers !== undefined) {
    try {
      const containers = await docker.listContainers();
      const plan = planRelaySweep({
        containers,
        nowMs: now(),
        minAgeMs: policy.relayMinAgeMs,
        held: deps.heldRelays?.() ?? [],
      });
      for (const relay of plan) {
        const currentContainers = await docker.listContainers();
        const matchingSandboxExists = currentContainers.some(
          (container) =>
            !isRelayComponent(container.labels?.[COMPONENT_LABEL]) &&
            container.labels?.[PROJECT_ID_LABEL] === relay.projectId &&
            container.labels?.[CONTAINER_GENERATION_LABEL] === relay.generation,
        );
        if (matchingSandboxExists) continue;
        // Re-read the hold too, for the same reason the sandbox check is repeated
        // here: a provision that began after the plan was computed is invisible to
        // it, and its relay exists before its sandbox does.
        //
        // A snapshot is enough, and no lock shared with the provisioner is needed,
        // because a provision can never come to hold a relay that is IN this plan.
        // The plan only names containers the listing already returned, a relay is
        // addressed by `sha256(projectId + containerGeneration)`, and a generation
        // is a fresh `randomUUID()` minted per container phase (`provisioner.ts`)
        // — never re-adopted, and the relay adapter has no name-conflict adoption
        // path. So a starting provision always creates a NEW container, which by
        // construction is not in this plan. If generations ever stop being unique
        // per start, this reasoning fails and the check has to become a shared
        // reservation.
        const heldNow = new Set(
          [...(deps.heldRelays?.() ?? [])].map((held) =>
            generationKey(held.projectId, held.containerGeneration),
          ),
        );
        if (heldNow.has(generationKey(relay.projectId, relay.generation))) continue;
        let stopError: unknown;
        try {
          await docker.stopContainer(relay.id);
        } catch (err) {
          if (!(err instanceof DockerError && err.kind === 'container_not_found')) stopError = err;
        }
        try {
          await docker.removeContainer(relay.id);
          report.relaysRemoved.push(relay.name);
          log.info(
            { relay: relay.name, projectId: relay.projectId, generation: relay.generation },
            'docker gc removed a superseded project relay',
          );
        } catch (err) {
          if (err instanceof DockerError && err.kind === 'container_not_found') {
            report.relaysRemoved.push(relay.name);
            continue;
          }
          const message =
            stopError === undefined
              ? errorMessage(err)
              : `stop: ${errorMessage(stopError)}; remove: ${errorMessage(err)}`;
          errors.push({ resource: `relay ${relay.name}`, message });
        }
      }
    } catch (err) {
      errors.push({ resource: 'relays', message: errorMessage(err) });
    }
  }

  // --- Dangling volumes (anonymous + orphaned builder state) ---------------
  // One dangling listing feeds both planners: anonymous volumes (leaked by the
  // pre-v=true teardown path) and orphaned buildx builder state volumes. Their
  // name shapes are disjoint, so a volume is claimed by at most one planner.
  if (docker.listVolumes !== undefined && docker.removeVolume !== undefined) {
    try {
      const volumes = await docker.listVolumes({ danglingOnly: true });
      const nowMs = now();
      const anonymous = planVolumeSweep({ volumes, nowMs, minAgeMs: volumeMinAgeMs });
      const builder = policy.sweepOrphanedBuilderVolumes
        ? planBuilderVolumeSweep({ volumes, nowMs, minAgeMs: volumeMinAgeMs })
        : [];
      const targets = [
        ...anonymous.map((name) => ({ name, builder: false })),
        ...builder.map((name) => ({ name, builder: true })),
      ];
      for (const target of targets) {
        try {
          await docker.removeVolume(target.name);
          if (target.builder) report.builderVolumesRemoved += 1;
          else report.volumesRemoved += 1;
        } catch (err) {
          errors.push({ resource: `volume ${target.name}`, message: errorMessage(err) });
        }
      }
    } catch (err) {
      errors.push({ resource: 'volumes', message: errorMessage(err) });
    }
  }

  // --- Build cache ---------------------------------------------------------
  if (docker.pruneBuildCache !== undefined && policy.buildCacheMaxAgeMs !== undefined) {
    try {
      report.buildCacheBytes = await docker.pruneBuildCache({
        untilHours: Math.max(1, Math.round(policy.buildCacheMaxAgeMs / 3_600_000)),
      });
    } catch (err) {
      errors.push({ resource: 'build cache', message: errorMessage(err) });
    }
  }

  log.info(
    {
      images: report.imagesRemoved.length,
      estimatedImageBytes: report.estimatedImageBytes,
      volumes: report.volumesRemoved,
      builderVolumes: report.builderVolumesRemoved,
      relays: report.relaysRemoved.length,
      buildCacheBytes: report.buildCacheBytes,
      lowDisk,
      ...(freeBytes !== undefined ? { freeBytes } : {}),
      errors: errors.length,
    },
    'docker gc pass complete',
  );
  for (const error of errors) {
    log.warn(error, 'docker gc skipped a resource');
  }
  return report;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hour of day (local) for the daily pass. Kept in the small hours because the
 *  sweep competes with project work for disk and daemon time, and nothing it
 *  reclaims is urgent — sandbox image generations are superseded whenever the
 *  relay reconciler recreates a sandbox, which is its own trigger, not a clock. */
const DOCKER_GC_HOUR = 4;
const DAY_MS = 24 * 60 * 60_000;

/** Delay before the boot pass. A restart is the moment stale state from the
 *  previous process is most likely to be lying around, but the server should
 *  finish coming up (migrations, provisioner reconcile) before doing disk work. */
const DOCKER_GC_BOOT_DELAY_MS = 5 * 60_000;

export interface DockerGcScheduler {
  stop(): void;
  /** Run one pass now (test seam; does not touch the timer). */
  runOnce(): Promise<DockerGcReport>;
}

export function startDockerGcScheduler(deps: DockerGcDeps): DockerGcScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runDockerGc(deps);
    } catch (err) {
      deps.log.warn({ err }, 'docker gc pass failed');
    } finally {
      running = false;
      scheduleDaily();
    }
  };

  const scheduleDaily = (): void => {
    if (stopped) return;
    const now = new Date(deps.now?.() ?? Date.now());
    const next = new Date(now);
    next.setHours(DOCKER_GC_HOUR, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setTime(next.getTime() + DAY_MS);
    timer = setTimeout(() => void run(), next.getTime() - now.getTime());
    timer.unref?.();
  };

  timer = setTimeout(() => void run(), DOCKER_GC_BOOT_DELAY_MS);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    runOnce: () => runDockerGc(deps),
  };
}
