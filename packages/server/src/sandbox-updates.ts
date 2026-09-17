import type { ProjectRecord } from '@verity/store';
import { DockerError, type DockerClient, type ContainerInspect } from './docker.js';
import { SIGNING_BROKER_TOKEN_HASH_LABEL } from './git-signer.js';
import { CONTAINER_GENERATION_LABEL } from './project-relay-migration.js';

type SandboxUpdateKind = 'normal' | 'security';
type SandboxUpdateCategory = 'software' | 'security' | 'configuration';
type SandboxUpdateState = 'current' | 'available' | 'unknown';

/**
 * Whether Verity's own automatic recreate is still expected to close the gap this
 * status names.
 *
 * Verity recreates every sandbox after a Server restart — the relays a new
 * process serves are new, so the previous generation's sandboxes are orphaned and
 * the reconciler rebuilds them onto the current image. `state: 'available'` is
 * therefore the normal, self-clearing state of the whole fleet for the first
 * minute after every Server update, and on its own says nothing an operator needs
 * to act on. This is the field that separates the two:
 *
 * - `converging` — the gap exists and the automatic repair is expected to close
 *   it: the reconciler has not reached this project yet, or is deferring around a
 *   turn in flight.
 * - `stalled` — the automatic repair has tried and failed repeatedly
 *   (`SANDBOX_SELF_REPAIR_FAILURE_LIMIT`). The sandbox keeps running on its old
 *   image; nothing will fix it without someone looking.
 *
 * Clients decide what to surface from this, not from `state` alone.
 */
type SandboxSelfRepairState = 'converging' | 'stalled';

export interface SandboxUpdateStatus {
  state: SandboxUpdateState;
  kind: SandboxUpdateKind | null;
  category: SandboxUpdateCategory | null;
  reason: string | null;
  current: string | null;
  target: string | null;
  currentVersion: string | null;
  currentRevision: string | null;
  targetVersion: string | null;
  targetRevision: string | null;
  /** See {@link SandboxSelfRepairState}. The checker itself only ever reports
   *  `converging`: it compares images and knows nothing about the reconciler's
   *  attempts. The route that serializes a project overlays the verdict from
   *  `Provisioner.unrepairedSandboxes()`. */
  selfRepair: SandboxSelfRepairState;
  /**
   * Whether this update is waiting on a turn rather than on Verity.
   *
   * The reconciler never recreates a sandbox out from under a live turn, and for
   * an image update that deferral is unbounded — the sandbox is fully usable, so
   * nothing justifies killing working agent to swap it. A project that never goes
   * idle therefore waits forever, and `converging` alone would keep promising a
   * rebuild that cannot start for as long as it does.
   *
   * Set once the wait passes `IMAGE_UPDATE_DEFER_REPORT_AFTER_MS`, so it means "long
   * enough that someone should know", not merely "deferred this tick". Like
   * {@link selfRepair} the checker always reports `false` — it compares images
   * and knows nothing about turns — and the route overlays the answer from
   * `Provisioner.turnBlockedSandboxes()`.
   *
   * Additive rather than a third {@link SandboxSelfRepairState}: the app parses
   * that field as a closed enum, so a new member would fail the whole project
   * list on every already-installed client. An older app ignores this field and
   * still gets the `stalled` the route sets alongside it.
   */
  turnBlocked: boolean;
}

/**
 * The half of an update check that does not depend on the project.
 *
 * The default image, its labels, the toolkit ref and the broker token hash are
 * the same answer for every project in one request, but each of them costs a
 * Docker or registry round trip to produce. Resolving them per project
 * multiplied one answer by the project count on every overview poll, so
 * `statusAll` resolves this once and each project then only needs its own
 * container inspect.
 */
interface SandboxUpdateTarget {
  defaultProjectImage: string;
  targetVersion?: string | undefined;
  toolkitFeatureRef?: string | undefined;
  signingBrokerTokenHash?: string | undefined;
  targetLabels?: Record<string, string> | undefined;
}

export interface SandboxUpdateChecker {
  status(project: ProjectRecord): Promise<SandboxUpdateStatus>;
  /**
   * Check many projects against one shared target, keyed by project id.
   *
   * Prefer this over a loop of `status()` wherever several projects are checked
   * to answer one request: that loop is what fanned `GET /projects` out into P
   * registry walks. `status()` remains for the single-project routes, where
   * there is no batch to share a target with and the answer must be fresh.
   */
  statusAll(projects: readonly ProjectRecord[]): Promise<Map<string, SandboxUpdateStatus>>;
}

export type SandboxRefSource = string | (() => Promise<string | undefined>);
export type SandboxVersionSource = string | ((imageRef: string) => Promise<string | undefined>);

const CURRENT: SandboxUpdateStatus = {
  state: 'current',
  kind: null,
  category: null,
  reason: null,
  current: null,
  target: null,
  currentVersion: null,
  currentRevision: null,
  targetVersion: null,
  targetRevision: null,
  selfRepair: 'converging',
  turnBlocked: false,
};

/**
 * How long one resolved {@link SandboxUpdateTarget} is reused.
 *
 * The target is the same answer for every project and every client, and it costs
 * a docker image inspect plus — when the image cannot answer — a registry
 * manifest walk. `statusAll` already shares it within ONE request; without this
 * every poll from every device still repaid it, several times a minute forever,
 * to learn that the image did not change. A new image becomes visible one TTL
 * later, which is far below the time a rollout takes to reach a sandbox anyway.
 *
 * NO INVALIDATION HOOK, unlike the branch label: everything the target is built
 * from — the configured image ref, its labels, the toolkit feature ref, the
 * signing-broker token hash — is answered by a source this module only reads, so
 * there is no single edit for a hook to hang off. The TTL is therefore the whole
 * freshness contract, and it bounds every one of those inputs: a settings change
 * (or a broker token rotation) shows up in the update status within 30 s, and a
 * status that is at most one window behind is what the badge already means.
 */
const TARGET_TTL_MS = 30_000;

export function createSandboxUpdateChecker(args: {
  docker: DockerClient;
  defaultProjectImage: SandboxRefSource;
  defaultProjectImageVersion?: SandboxVersionSource | undefined;
  toolkitFeatureRef?: SandboxRefSource | undefined;
  signingBrokerTokenHash?: (() => Promise<string | null | undefined>) | undefined;
  /** Override {@link TARGET_TTL_MS} (tests). `0` disables the cache. */
  targetTtlMs?: number | undefined;
}): SandboxUpdateChecker {
  const resolveTargetUncached = async (): Promise<SandboxUpdateTarget | undefined> => {
    const defaultProjectImage = await resolveSandboxRefSource(args.defaultProjectImage);
    if (defaultProjectImage === undefined) return undefined;
    const [targetLabels, toolkitFeatureRef, signingBrokerTokenHash] = await Promise.all([
      inspectImageLabels(args.docker, defaultProjectImage),
      resolveSandboxRefSource(args.toolkitFeatureRef),
      resolveSigningBrokerTokenHash(args.signingBrokerTokenHash),
    ]);
    return {
      defaultProjectImage,
      targetLabels,
      // Asked of the registry only when the LOCAL image cannot answer.
      // `statusForInspect` prefers the label, so on the normal path — image
      // present, labels intact — an eagerly resolved version is a three-request
      // manifest walk whose result is then discarded.
      targetVersion:
        imageVersion(targetLabels) === null
          ? await resolveSandboxVersion(args.defaultProjectImageVersion, defaultProjectImage)
          : undefined,
      toolkitFeatureRef,
      signingBrokerTokenHash,
    };
  };

  // Stale-while-revalidate around that resolution, plus single-flight so a burst
  // of polls against a cold cache produces ONE registry walk rather than one per
  // request. Both failure shapes are paced by the TTL like any other answer — a
  // resolution that returns `undefined` because it could not tell, and one that
  // throws (see the catch below): retrying a broken registry on every poll is
  // what the cache exists to stop.
  const ttl = args.targetTtlMs ?? TARGET_TTL_MS;
  let cachedTarget: { target: SandboxUpdateTarget | undefined; at: number } | undefined;
  let inFlight: Promise<SandboxUpdateTarget | undefined> | undefined;
  const refreshTarget = (): Promise<SandboxUpdateTarget | undefined> => {
    inFlight ??= resolveTargetUncached()
      .then((target) => {
        cachedTarget = { target, at: Date.now() };
        return target;
      })
      .catch((error: unknown) => {
        // A REJECTED resolution paces like a resolved one: without this the
        // entry stays stale, so a registry that is down is retried on every poll
        // by every client — the load the cache exists to prevent, arriving
        // precisely when the far end is already failing. Nothing to stamp on a
        // cold cache: there is no answer to serve, so the next call must retry.
        if (cachedTarget !== undefined) cachedTarget = { ...cachedTarget, at: Date.now() };
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const resolveTarget = async (): Promise<SandboxUpdateTarget | undefined> => {
    if (ttl <= 0) return resolveTargetUncached();
    const cached = cachedTarget;
    if (cached === undefined) return refreshTarget();
    if (Date.now() - cached.at >= ttl) void refreshTarget().catch(() => undefined);
    return cached.target;
  };

  const inspectProject = async (project: ProjectRecord): Promise<Inspection> => {
    if (project.state !== 'active') return { ok: false, status: unknown('project is not active') };
    let inspected: ContainerInspect;
    try {
      inspected = await args.docker.inspectContainer(project.containerName);
    } catch (error) {
      if (error instanceof DockerError && error.kind === 'container_not_found') {
        return { ok: false, status: unknown('container is not running') };
      }
      return { ok: false, status: unknown('container inspect failed') };
    }
    if (!inspected.running) return { ok: false, status: unknown('container is not running') };
    return { ok: true, inspected };
  };

  const statusFrom = (
    inspection: Inspection,
    target: SandboxUpdateTarget | undefined,
  ): SandboxUpdateStatus =>
    !inspection.ok
      ? inspection.status
      : target === undefined
        ? unknown('default project image is unavailable')
        : statusForInspect(inspection.inspected, target);

  return {
    async status(project) {
      const inspection = await inspectProject(project);
      // Only a project that can use the target pays for resolving it: an
      // inactive or stopped container costs no image inspect and no registry
      // round trip, as before.
      return statusFrom(inspection, inspection.ok ? await resolveTarget() : undefined);
    },
    async statusAll(projects) {
      const inspections = await Promise.all(
        projects.map(async (project) => [project, await inspectProject(project)] as const),
      );
      const target = inspections.some(([, inspection]) => inspection.ok)
        ? await resolveTarget()
        : undefined;
      return new Map(
        inspections.map(([project, inspection]) => [project.id, statusFrom(inspection, target)]),
      );
    },
  };
}

type Inspection =
  { ok: true; inspected: ContainerInspect } | { ok: false; status: SandboxUpdateStatus };

async function resolveSigningBrokerTokenHash(
  source: (() => Promise<string | null | undefined>) | undefined,
): Promise<string | undefined> {
  try {
    return (await source?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveSandboxVersion(
  source: SandboxVersionSource | undefined,
  imageRef: string,
): Promise<string | undefined> {
  try {
    const version = typeof source === 'function' ? await source(imageRef) : source;
    return versionFromRef(version) ?? version;
  } catch (error) {
    // Swallowing this left an unbounded registry call with no trace at all —
    // the target version simply went missing and the row rendered as if the
    // registry had answered "no version".
    warnVersionResolutionFailed(imageRef, error);
    return undefined;
  }
}

const versionWarnings = new Map<string, number>();

/** Forget which refs have been reported. Exported for tests, which share refs. */
export function clearSandboxVersionWarnings(): void {
  versionWarnings.clear();
}

/** How long one failing ref stays quiet after it has been reported once. */
const VERSION_WARNING_COOLDOWN_MS = 60_000;

/**
 * Report a failed version resolution at most once a minute per ref.
 *
 * The caller behind this is a poll, and the resolver caches its failures — so
 * an outage would otherwise reprint the same line for every client on every
 * refresh, several times a minute, for as long as it lasts.
 */
function warnVersionResolutionFailed(imageRef: string, error: unknown): void {
  const now = Date.now();
  const lastWarned = versionWarnings.get(imageRef);
  if (lastWarned !== undefined && now - lastWarned < VERSION_WARNING_COOLDOWN_MS) return;
  versionWarnings.set(imageRef, now);
  console.warn(
    `verity: could not resolve the sandbox image version for ${imageRef}: ${String(error)}`,
  );
}

async function resolveSandboxRefSource(
  source: SandboxRefSource | undefined,
): Promise<string | undefined> {
  return typeof source === 'function' ? await source() : source;
}

async function inspectImageLabels(
  docker: DockerClient,
  imageRef: string,
): Promise<Record<string, string> | undefined> {
  try {
    return await docker.inspectImageLabels?.(imageRef);
  } catch {
    return undefined;
  }
}

export function statusForInspect(
  inspected: Pick<ContainerInspect, 'image' | 'labels'>,
  args: {
    defaultProjectImage: string;
    targetVersion?: string | undefined;
    toolkitFeatureRef?: string | undefined;
    signingBrokerTokenHash?: string | undefined;
    targetLabels?: Record<string, string> | undefined;
  },
): SandboxUpdateStatus {
  const image = inspected.image ?? null;
  const labels = inspected.labels ?? {};
  const targetVersion = imageVersion(args.targetLabels) ?? args.targetVersion ?? null;
  const targetRevision = imageRevision(args.targetLabels);
  const toolkit = devcontainerToolkitRef(labels);
  if (
    toolkit !== null &&
    args.toolkitFeatureRef !== undefined &&
    toolkit !== args.toolkitFeatureRef
  ) {
    return available({
      reason: 'devcontainer toolkit update available',
      current: toolkit,
      target: args.toolkitFeatureRef,
      // The target here is a Feature ref, whose labels nothing in this module
      // resolves — so this is the base image's class, not the toolkit's. Still the
      // closer of the two available answers: the base image and the toolkit ship
      // from the same release, while the CONTAINER's labels describe the build
      // being replaced. Reads `normal` until a Feature-side class exists to ask.
      kind: updateKind(args.targetLabels),
      category: updateCategory(args.targetLabels),
      currentVersion: imageVersion(labels),
      currentRevision: imageRevision(labels),
      targetVersion,
      targetRevision,
    });
  }

  if (
    args.signingBrokerTokenHash !== undefined &&
    labels[CONTAINER_GENERATION_LABEL] === undefined &&
    labels[SIGNING_BROKER_TOKEN_HASH_LABEL] !== args.signingBrokerTokenHash
  ) {
    return available({
      reason:
        labels[SIGNING_BROKER_TOKEN_HASH_LABEL] === undefined
          ? 'signing broker token metadata missing'
          : 'signing broker token update available',
      current:
        labels[SIGNING_BROKER_TOKEN_HASH_LABEL] === undefined
          ? 'missing signing broker token metadata'
          : 'stale signing broker token',
      target: 'current signing broker token',
      // Not read from any labels, unlike every other branch here. What this one
      // offers is a re-issued token, not an image, so the target image's class
      // says nothing about it — inheriting it would let an ordinary token refresh
      // announce itself as a security update because some unrelated release
      // happened to be one. The container's own labels, which this used to read,
      // were no better: they describe the build being replaced.
      kind: 'normal',
      category: 'configuration',
    });
  }

  if (image === args.defaultProjectImage) {
    return {
      ...CURRENT,
      current: image ?? labels['org.opencontainers.image.revision'] ?? null,
      target: args.defaultProjectImage,
      currentVersion: imageVersion(labels),
      currentRevision: imageRevision(labels),
      targetVersion: targetVersion ?? imageVersion(labels),
      targetRevision: targetRevision ?? imageRevision(labels),
    };
  }

  // A devcontainer build produces a derived image, so its image id can never
  // equal the configured base image. Docker carries the base image's OCI labels
  // into that derived image, though, which lets us distinguish a genuinely old
  // base from the expected derived-image id mismatch. Toolkit and broker drift
  // were handled above; matching base metadata plus a matching toolkit is the
  // authoritative current identity for this image.
  if (toolkit !== null) {
    if (
      labels['org.opencontainers.image.title'] === 'heey-global/verity-sandbox' &&
      sandboxBaseMetadataDiffers(labels, args.targetLabels, args.targetVersion)
    ) {
      return available({
        reason: 'sandbox image update available',
        current: image,
        target: args.defaultProjectImage,
        kind: updateKind(args.targetLabels),
        category: updateCategory(args.targetLabels),
        currentVersion: imageVersion(labels),
        currentRevision: imageRevision(labels),
        targetVersion,
        targetRevision,
      });
    }
    return {
      ...CURRENT,
      current: toolkit,
      target: args.toolkitFeatureRef ?? toolkit,
    };
  }

  if (labels['org.opencontainers.image.title'] === 'heey-global/verity-sandbox') {
    if (image !== null) {
      return available({
        reason: 'sandbox image update available',
        current: image,
        target: args.defaultProjectImage,
        kind: updateKind(args.targetLabels),
        category: updateCategory(args.targetLabels),
        currentVersion: imageVersion(labels),
        currentRevision: imageRevision(labels),
        targetVersion,
        targetRevision,
      });
    }
    return {
      ...CURRENT,
      current: labels['org.opencontainers.image.revision'] ?? null,
      target: args.defaultProjectImage,
      currentVersion: imageVersion(labels),
      currentRevision: imageRevision(labels),
      targetVersion: targetVersion ?? imageVersion(labels),
      targetRevision: targetRevision ?? imageRevision(labels),
    };
  }

  return unknown('project uses a custom image');
}

function devcontainerToolkitRef(labels: Record<string, string>): string | null {
  const raw = labels['devcontainer.metadata'];
  if (raw === undefined) return null;
  try {
    const metadata = JSON.parse(raw) as unknown;
    if (!Array.isArray(metadata)) return null;
    for (const item of metadata) {
      if (typeof item !== 'object' || item === null || !('id' in item)) continue;
      const id = (item as { id?: unknown }).id;
      if (
        typeof id === 'string' &&
        id.startsWith('ghcr.io/heey-global/verity/verity-sandbox-toolkit')
      ) {
        return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The security class of the update being OFFERED, read off the target image.
 *
 * The labels to ask are the target's, never the running container's. The label is
 * stamped at build time onto the artifact it describes (ADR 0004), so a container
 * carrying it is one that already HAS the security fix — reading it there answers
 * the opposite question and answers it backwards: every sandbox that had been
 * updated would report a security update pending, and the one still running the
 * vulnerable image would report a normal one, which is the single case the
 * distinction exists for.
 *
 * Nothing in this repository stamps the label yet (no LABEL in
 * `deploy/verity-sandbox.Dockerfile` or its workflow), so today every answer here
 * is `normal`/`software`. That is the honest answer for a fleet whose publisher
 * does not classify its releases — and it is `undefined`-safe for the same
 * reason the target itself is optional: a registry that could not be reached
 * yields no labels, and an unreachable registry is not evidence of a security
 * release.
 */
function updateKind(labels: Record<string, string> | undefined): SandboxUpdateKind {
  return labels?.['dev.heey.verity.update.kind'] === 'security' ? 'security' : 'normal';
}

function updateCategory(labels: Record<string, string> | undefined): SandboxUpdateCategory {
  return updateKind(labels) === 'security' ? 'security' : 'software';
}

function imageVersion(labels: Record<string, string> | undefined): string | null {
  const version = labels?.['org.opencontainers.image.version'];
  return version && version.trim().length > 0 ? version.trim() : null;
}

function sandboxBaseMetadataDiffers(
  currentLabels: Record<string, string>,
  targetLabels: Record<string, string> | undefined,
  fallbackTargetVersion: string | undefined,
): boolean {
  const currentVersion = imageVersion(currentLabels);
  const targetVersion = imageVersion(targetLabels) ?? fallbackTargetVersion ?? null;
  const currentRevision = imageRevision(currentLabels);
  const targetRevision = imageRevision(targetLabels);
  // A derived image id cannot be compared with its base image id. Without one
  // complete comparable metadata dimension we cannot prove that the inherited
  // base is current, so keep the update visible rather than suppressing a real
  // rebuild after label loss or a failed target-image inspection.
  if (currentVersion === null && currentRevision === null) return true;
  if (targetVersion === null && targetRevision === null) return true;
  return (
    (targetVersion !== null && currentVersion !== targetVersion) ||
    (targetRevision !== null && currentRevision !== targetRevision)
  );
}

function imageRevision(labels: Record<string, string> | undefined): string | null {
  const revision = labels?.['org.opencontainers.image.revision'];
  return revision && revision.trim().length > 0 ? revision.trim() : null;
}

function versionFromRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const tag = ref.match(/:v?([0-9]+(?:\.[0-9]+){2}(?:[-.][A-Za-z0-9]+)*)$/)?.[1];
  return tag === undefined ? undefined : `v${tag}`;
}

function available(args: {
  reason: string;
  current: string | null;
  target: string;
  kind: SandboxUpdateKind;
  category: SandboxUpdateCategory;
  currentVersion?: string | null;
  currentRevision?: string | null;
  targetVersion?: string | null;
  targetRevision?: string | null;
}): SandboxUpdateStatus {
  return {
    state: 'available',
    kind: args.kind,
    category: args.category,
    reason: args.reason,
    current: args.current,
    target: args.target,
    currentVersion: args.currentVersion ?? null,
    currentRevision: args.currentRevision ?? null,
    targetVersion: args.targetVersion ?? null,
    targetRevision: args.targetRevision ?? null,
    selfRepair: 'converging',
    turnBlocked: false,
  };
}

function unknown(reason: string): SandboxUpdateStatus {
  return {
    state: 'unknown',
    kind: null,
    category: null,
    reason,
    current: null,
    target: null,
    currentVersion: null,
    currentRevision: null,
    targetVersion: null,
    targetRevision: null,
    selfRepair: 'converging',
    turnBlocked: false,
  };
}
