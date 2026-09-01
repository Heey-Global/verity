import { readFile } from 'node:fs/promises';
import type { ContainerInspect, ContainerSpec, DockerClient } from '../docker.js';
import { MANAGED_SERVER_DEFAULT_RESOURCES, type ServerDeploymentSpec } from './deployment-spec.js';
import { readManagedDeployment } from './managed-deployment.js';

export const MANAGED_SERVER_NAME = 'verity-managed-server';
export const MANAGED_DEPLOYMENT_LABEL = 'verity.managed-deployment-id';
export const MANAGED_ROLE_LABEL = 'verity.managed-role';
const MANAGED_ROLE = 'server';

export type ManagedServerDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'startContainer'
>;

export interface ReconcileManagedServerOptions {
  readonly managedRoot: string;
  readonly docker: ManagedServerDocker;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => Promise<string>;
  readonly identity?: {
    readonly name: string;
    readonly operationId: string;
    readonly generation: number;
  };
}

export interface ManagedServerReconcileResult {
  readonly containerId: string;
  readonly action: 'created' | 'started' | 'unchanged';
  /**
   * Sealed environment names the running Server was tolerated on despite the spec
   * now resolving them differently — or the one name whose source this host can no
   * longer resolve at all.
   *
   * Names only, never values. This travels to `GET /v1/reconcile`, and most of
   * these are secrets. Absent when the container matched.
   */
  readonly drift?: readonly string[];
}

/**
 * What the Updater's startup reconcile concluded about the Server it found,
 * as `GET /v1/reconcile` reports it.
 *
 * Tolerated drift that nothing can see is drift that nobody fixes, so the
 * tolerance and this report are one decision. `'unknown'` is the third honest
 * answer: an Updater that came up with an unfinished operation logs the failure
 * and carries on without ever reaching a verdict, and reporting `'ok'` for that
 * would be a claim nothing checked.
 *
 * Names, never values — see {@link ManagedServerReconcileResult.drift}.
 */
export type ManagedServerReconcileVerdict =
  | { readonly status: 'ok' }
  | { readonly status: 'drift'; readonly environment: readonly string[] }
  | { readonly status: 'unknown' };

function ownedBy(inspect: ContainerInspect, deploymentId: string): boolean {
  return (
    inspect.labels?.[MANAGED_DEPLOYMENT_LABEL] === deploymentId &&
    inspect.labels?.[MANAGED_ROLE_LABEL] === MANAGED_ROLE
  );
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/** The environment the daemon will report for a container created from
 *  `imageEnv` with `desired` applied on top: image entries first, each spec
 *  entry overriding the image's value for that name. Comparing the container
 *  against THIS — rather than against `desired` alone — is what keeps the check
 *  exact. `desired` never contains the image's own baked variables (`PATH`,
 *  `NODE_ENV`, …), so requiring equality with `desired` can never hold against a
 *  real daemon, and relaxing it to "contains `desired`" would stop noticing an
 *  extra variable injected into the container. */
/**
 * Baked into every Server image — a release publishes the relay that matches it,
 * and `resolveProjectRelayImage` reads it straight from the image environment.
 *
 * Deployments sealed before that was understood also carry it as an env source
 * resolved against the Updater, and the Updater replaces itself during an update:
 * from the next release on, its copy names a different relay than the promoted
 * Server was created with, so the two can never agree again and the Updater stops
 * starting at all. New deployments no longer seal it (see `managed-bootstrap`);
 * skipping it here is what keeps the already-sealed ones working.
 *
 * Deliberately the ONLY exemption. The cutover's own variables — the activation
 * flag, the update id and the holder id — are compared exactly: `reconcileManagedServer`
 * reconstructs them from the identity it is given, so for the generation actually
 * promoted they already agree, and a container claiming a different operation must
 * still be refused rather than started into an activation that never comes.
 */
const IMAGE_PROVIDED_ENVIRONMENT = ['VERITY_BUNDLED_PROJECT_RELAY_IMAGE'];

/**
 * Variables the Server used to be given and no longer is, because the deployment
 * that fed them was removed.
 *
 * The sealed spec outlives the Compose file it was sealed from. `managed-bootstrap`
 * snapshots the Updater's own environment into a list of env SOURCES, every later
 * generation copies that list forward verbatim (`advanceManagedDeploymentImage`),
 * and the Updater resolves every source on every reconcile — forever. So deleting a
 * variable from `deploy/docker-compose.yml` does not retire it: it turns it into an
 * unresolvable source in every spec sealed before the deletion, and
 * `resolveEnvironment` then throws on a path with no repair — `recoverManagedUpdater`
 * rethrows whenever no operation is in flight, so the Updater exits, restarts, and
 * fails identically. A deployment in that state cannot update itself out of it,
 * which is precisely how it would receive the fix.
 *
 * Recording the name here is what makes the removal a retirement rather than an
 * outage: the Updater builds the Server without it and judges a Server that still
 * carries it as matching. The two halves are one decision and must stay together —
 * dropping the variable from `desired` alone would only move the crash loop from
 * `resolveEnvironment` to `managedContainerMatchesSpec`, because the running Server
 * was created while the deployment still supplied it and reconciliation never
 * recreates on a mismatch.
 *
 * A LIST rather than blanket tolerance, deliberately. An unresolvable source
 * normally means the deployment is broken — a secret not mounted, `DATABASE_URL`
 * lost out of the Compose environment — and building a Server without it would
 * turn a loud, correct refusal into a Server running on defaults. This distinguishes
 * "upstream retired it" from "something is wrong" by the only evidence that can
 * actually tell them apart: a reviewed record, written in the same commit that
 * removes the variable. Nothing infers it, so nothing can be fooled into inferring
 * it wrongly.
 *
 * Add a name here in the commit that removes it from Compose, and never one the
 * Server still reads — `managed-topology-deployment.test.ts` enforces the second
 * half against the Compose file.
 */
export const RETIRED_MANAGED_SERVER_ENVIRONMENT: readonly string[] = [
  // #1553 removed the bundled local transcription sidecar and its three variables
  // from the Compose server environment, leaving every deployment sealed before it
  // naming sources nothing supplies.
  'VERITY_LOCAL_TRANSCRIBE_AVAILABLE',
  'VERITY_LOCAL_TRANSCRIBE_BASE_URL',
  'VERITY_LOCAL_TRANSCRIBE_MODEL',
  // #1490 removed the Kubernetes preview edge. Those variables survive as empty
  // values in the Updater's Compose service, which is the same drift handled one
  // deployment at a time; recorded here so an Updater carrying this list no longer
  // depends on the operator's checkout having them.
  'VERITY_PREVIEW_DOMAIN',
  'VERITY_PREVIEW_EDGE_IMAGE',
  'VERITY_PREVIEW_CONNECTOR_IMAGE',
  'VERITY_PREVIEW_KUBERNETES_API_URL',
  'VERITY_PREVIEW_KUBERNETES_TOKEN_FILE',
  'VERITY_PREVIEW_KUBERNETES_NAMESPACE',
  'VERITY_PREVIEW_GATEWAY_NAME',
  'VERITY_PREVIEW_GATEWAY_NAMESPACE',
  'VERITY_PREVIEW_GATEWAY_SECTION',
];

/**
 * Variables whose VALUE says which install and which operation a container
 * belongs to, rather than how it is configured.
 *
 * These are the one part of the environment where a difference is not drift, so
 * {@link describeManagedContainerMismatch} calls it `'structural'` and
 * `reconcileManagedServer` keeps refusing it. Everything the tolerance below
 * rests on is an argument about a Server that is *this* deployment's Server,
 * merely configured from an older resolution of the sealed sources; a container
 * naming a different deployment or a different update is not that, and starting
 * it would either adopt another install's Server or join an activation that is
 * never coming.
 *
 * `VERITY_MANAGED_DEPLOYMENT_ID` is checked twice on purpose. `resolveEnvironment`
 * refuses to BUILD a spec whose source disagrees with the sealed authority; this
 * refuses to ADOPT a container that carries a different one, which is a fact about
 * the container and survives the tolerance.
 */
const MANAGED_SERVER_IDENTITY_ENVIRONMENT = [
  'VERITY_MANAGED_DEPLOYMENT_ID',
  'VERITY_CONTROL_PLANE_HOLDER_ID',
  'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION',
  'VERITY_UPDATE_ID',
];

function comparableEnvironment(env: readonly string[], promoted: boolean): string[] {
  return env.filter((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return true;
    const name = entry.slice(0, separator);
    // Unconditional, unlike the relay exemption: a retired variable has to be
    // ignored for a CANDIDATE too. Preparation builds one from this same spec, so
    // it never carries the variable, while a candidate a PREVIOUS Updater prepared
    // still does — and refusing that one wedges an update mid-flight.
    if (RETIRED_MANAGED_SERVER_ENVIRONMENT.includes(name)) return false;
    return !promoted || !IMAGE_PROVIDED_ENVIRONMENT.includes(name);
  });
}

function effectiveEnvironment(
  imageEnv: readonly string[],
  desired: readonly string[] | undefined,
): string[] {
  const merged = new Map<string, string>();
  for (const entry of [...imageEnv, ...(desired ?? [])]) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    merged.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).sort();
}

/** A host ceiling as the daemon states it. Docker writes "no limit" as `0` for
 *  `Memory`/`NanoCpus` and as `0` or `-1` for `MemorySwap`/`PidsLimit`, and
 *  `createContainer` omits the field entirely when the spec leaves it out, so all
 *  of those have to compare equal or an unlimited container would look like a
 *  match for one shape of "unlimited" and a mismatch for another. */
const ceiling = (value: number | undefined): number =>
  value === undefined || value <= 0 ? 0 : value;

/** Whether a container carries exactly the four host ceilings a spec states. */
function hostLimitsMatch(inspect: ContainerInspect, desired: ContainerSpec): boolean {
  return (
    ceiling(inspect.memoryBytes) === ceiling(desired.memoryBytes) &&
    ceiling(inspect.memorySwapBytes) === ceiling(desired.memorySwapBytes) &&
    ceiling(inspect.nanoCpus) === ceiling(desired.nanoCpus) &&
    ceiling(inspect.pidsLimit) === ceiling(desired.pidsLimit)
  );
}

/**
 * How a live container differs from the one `desired` describes.
 *
 * - `'match'` — it is that container.
 * - `'environment'` — every difference is a value-or-presence difference on a
 *   name the sealed spec itself supplies (or one since retired). The container is
 *   this deployment's Server, configured from an older resolution of the same
 *   sources: a value that Compose has since changed, a secret file rewritten, a
 *   variable interpolated differently on the host.
 * - `'structural'` — anything else. A different image, mounts, user, groups,
 *   network, root filesystem, restart policy, privilege flags, capabilities,
 *   command, init, sealed host ceilings — or an environment variable the
 *   container carries that neither the spec nor the image accounts for, which is
 *   the injected-variable case this comparison was built to catch.
 *
 * The split exists because the two verdicts deserve different answers, and
 * welding them together is what made an ordinary upstream change unrecoverable.
 * A structural difference means the container is not the Server the authority
 * describes and cannot be made into it without being replaced. An environment
 * difference means it IS that Server, running on a value that has since moved —
 * and a running one is already serving on it, which no refusal by the Updater can
 * improve. See `reconcileManagedServer` for what each verdict then does.
 */
export type ManagedContainerMismatch = 'match' | 'environment' | 'structural';

interface ManagedContainerVerdict {
  readonly kind: ManagedContainerMismatch;
  /** For `'environment'`, the differing names, sorted. Names only, never values:
   *  this is reported over the control socket and most of them are secrets. */
  readonly environment: readonly string[];
}

function environmentByName(entries: readonly string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    byName.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return byName;
}

/** Everything about a container except its environment: the properties that
 *  cannot be changed without recreating it, and that no host-side value moves. */
function structureMatches(
  inspect: ContainerInspect,
  desired: ContainerSpec,
  hostLimits: 'exact' | 'ignored',
): boolean {
  const expectedMounts = [
    ...(desired.binds ?? []).map((bind) => {
      const [source, destination, mode] = bind.split(':');
      return { type: 'bind', source, destination, readWrite: mode !== 'ro' };
    }),
    // Matched on the volume NAME. The daemon reports `source` for a volume mount
    // as the host path it currently resolves to, which is neither the name nor
    // stable, so a spec's `verity-data` is compared against `name`.
    ...(desired.volumeMounts ?? []).map((mount) => ({
      type: 'volume',
      source: mount.volume,
      destination: mount.target,
      readWrite: mount.readOnly !== true,
    })),
  ].sort((a, b) => String(a.destination).localeCompare(String(b.destination)));
  const actualMounts = [...(inspect.mounts ?? [])]
    .map((mount) => ({
      type: mount.type,
      source: mount.type === 'volume' ? mount.name : mount.source,
      destination: mount.destination,
      readWrite: mount.readWrite,
    }))
    .sort((a, b) => String(a.destination).localeCompare(String(b.destination)));
  return (
    inspect.image === desired.image &&
    inspect.user === desired.user &&
    inspect.networkMode === desired.network &&
    inspect.readOnlyRootfs === desired.readOnlyRootfs &&
    inspect.restartPolicy === desired.restartPolicy &&
    JSON.stringify(sorted(inspect.securityOpt)) === JSON.stringify(sorted(desired.securityOpt)) &&
    JSON.stringify(sorted(inspect.capAdd)) === JSON.stringify(sorted(desired.capAdd)) &&
    JSON.stringify(sorted(inspect.groupAdd)) === JSON.stringify(sorted(desired.groupAdd)) &&
    JSON.stringify(actualMounts) === JSON.stringify(expectedMounts) &&
    JSON.stringify(inspect.entrypoint ?? []) === JSON.stringify(desired.entrypoint ?? []) &&
    JSON.stringify(inspect.command ?? []) === JSON.stringify(desired.command ?? []) &&
    (hostLimits === 'ignored' || hostLimitsMatch(inspect, desired)) &&
    inspect.init === true
  );
}

function judgeManagedContainer(
  inspect: ContainerInspect,
  desired: ContainerSpec,
  imageEnv: readonly string[],
  promoted: boolean,
  hostLimits: 'exact' | 'ignored',
  /**
   * The names the SEALED SPEC supplies, which is what may legitimately drift.
   *
   * Defaults to the names in `desired.env` and is passed explicitly by
   * `reconcileManagedServer`, because those two sets come apart in exactly the
   * case that matters: a source this host cannot resolve is absent from
   * `desired.env` while still being a sealed name, and deriving the set from
   * `desired.env` alone would call the running Server's value for it an injected
   * variable.
   */
  sealed?: ReadonlySet<string>,
): ManagedContainerVerdict {
  if (!structureMatches(inspect, desired, hostLimits))
    return { kind: 'structural', environment: [] };
  const actualEntries = comparableEnvironment(sorted(inspect.env), promoted);
  const actual = environmentByName(actualEntries);
  // Comparing by NAME is what makes "which names differ" answerable at all, but
  // the map is lossy on exactly the two shapes the container should never have:
  // an entry with no `=`, which is dropped, and a repeated name, of which only
  // the last survives. Neither can come from a container this code created, and
  // leaving them out of the comparison would hide an injected entry behind a
  // well-formed one. The previous exact array comparison refused both implicitly;
  // this refuses them on purpose, before any of them can be called drift.
  if (actual.size !== actualEntries.length) return { kind: 'structural', environment: [] };
  const expected = environmentByName(
    comparableEnvironment(effectiveEnvironment(imageEnv, desired.env), promoted),
  );
  const differing = [...new Set([...actual.keys(), ...expected.keys()])]
    .filter((name) => actual.get(name) !== expected.get(name))
    .sort();
  if (differing.length === 0) return { kind: 'match', environment: [] };
  // Only names the SEALED SPEC supplies may drift. A name the container carries
  // that is neither sealed nor baked into the image is an injected variable, and
  // a baked name whose value the container overrides is the image's own
  // environment being tampered with — both stay structural, which is what keeps
  // this comparison the boundary it was written to be.
  const sealedNames = sealed ?? new Set(environmentByName(desired.env ?? []).keys());
  const drifted = differing.every((name) => {
    if (MANAGED_SERVER_IDENTITY_ENVIRONMENT.includes(name)) return false;
    if (!sealedNames.has(name) && !RETIRED_MANAGED_SERVER_ENVIRONMENT.includes(name)) return false;
    // Only a VALUE may drift. A sealed name the container does not carry at all
    // is not a Server configured differently, it is a Server running WITHOUT a
    // variable the authority says it must have — the "quietly running on
    // defaults" state, and the one thing tolerance must never bless. There is no
    // value of its own to preserve, so the argument for keeping it has nothing
    // to stand on.
    //
    // The converse is fine and is the whole point: the container carries the
    // name and the environment built here does not, because this host can no
    // longer resolve that source. That Server is serving on the value it was
    // created with.
    return actual.has(name);
  });
  return drifted
    ? { kind: 'environment', environment: differing }
    : { kind: 'structural', environment: [] };
}

/**
 * Classify a live container against the one `desired` describes.
 *
 * `imageEnv` is `desired.image`'s baked `Config.Env`; see
 * {@link effectiveEnvironment} for why the comparison needs it.
 */
export function describeManagedContainerMismatch(
  inspect: ContainerInspect,
  desired: ContainerSpec,
  imageEnv: readonly string[],
  /** Set only for the steady-state reconcile of an already-promoted Server, where
   *  the baked relay reference legitimately predates the Updater's own. A CANDIDATE
   *  is compared exactly: one left over from an earlier attempt may name a relay
   *  from another release, and adopting it would pin the promoted Server to it. */
  promoted = false,
  /**
   * Whether the four host ceilings are part of "exactly".
   *
   * `'exact'` for a container this operation PREPARES — the standby and the
   * preflight probe. Those are created by this code, from this spec, inside the
   * one operation that also adopts them, so there is no older shape to tolerate:
   * a resumed attempt can only meet a container the same Updater generation made,
   * and preparation reruns before any cutover. A standby is what recovery
   * promotes into the running Server, so a candidate that somehow carries no
   * ceilings must be refused rather than routed to.
   *
   * For a container that is already running when the reconciler merely FINDS it,
   * the mode follows the sealed authority — see {@link sealedHostLimitsMode},
   * which is where that argument lives.
   *
   * Note this axis is NOT {@link promoted}. A generation-suffixed reconcile passes
   * `promoted = false` while looking at the already-promoted Server: for the
   * terminal `completed`/`rolled-back` phases `recoverManagedUpdater` derives the
   * identity from the Gateway's selected backend and reconciles the container that
   * is already routed. Keying the ceilings off `promoted` would wedge exactly the
   * hosts that have completed an update, which is all of them.
   */
  hostLimits: 'exact' | 'ignored' = 'ignored',
): ManagedContainerMismatch {
  return judgeManagedContainer(inspect, desired, imageEnv, promoted, hostLimits).kind;
}

/**
 * Whether a live container is exactly the one `desired` describes.
 *
 * Deliberately `describeManagedContainerMismatch(...) === 'match'` rather than a
 * second comparison: a caller that only needs a yes/no keeps getting one, and
 * there is no way for the two answers to drift apart.
 */
export function managedContainerMatchesSpec(
  inspect: ContainerInspect,
  desired: ContainerSpec,
  imageEnv: readonly string[],
  promoted = false,
  hostLimits: 'exact' | 'ignored' = 'ignored',
): boolean {
  return (
    describeManagedContainerMismatch(inspect, desired, imageEnv, promoted, hostLimits) === 'match'
  );
}

/**
 * How strictly a RUNNING Server's host ceilings are judged against the authority
 * that owns it.
 *
 * A spec that states its ceilings is exact. `resources` is only ever written by
 * `runManagedBootstrap` through the create-only `initializeManagedDeployment`;
 * the two re-sealing paths carry it forward and never introduce it. So a spec
 * carrying it was adopted by a release that has this code, and every Server that
 * spec has ever produced was created by `managedServerContainerSpec` with those
 * four values applied. An Updater old enough to create one without them cannot
 * even read such a spec — its parser rejects the unknown key and it creates no
 * container at all. There is therefore no older container shape to tolerate, and
 * refusing a Server whose ceilings have since been weakened cannot wedge a host
 * that was never able to reach that state honestly.
 *
 * A spec that states nothing is tolerated, for two reasons. Its Server may
 * predate the ceilings entirely, and this comparison has no repair path:
 * `reconcileManagedServer` throws on a mismatch and never recreates, and
 * `recoverManagedUpdater` rethrows that failure whenever no operation is in
 * flight, so the Updater exits, restarts, and rejects the same container again —
 * a permanent crash loop with the control plane unable to update itself. And its
 * ceilings come from {@link MANAGED_SERVER_DEFAULT_RESOURCES}, a code constant a
 * later release may change; comparing against a value that moves under a running
 * container would wedge the deployment on the release that changed it, which is
 * exactly the failure a sealed value does not have.
 *
 * The tolerance is therefore no wider than the problem, and it retires itself:
 * a deployment that is re-bootstrapped seals its ceilings and becomes exact.
 */
export function sealedHostLimitsMode(spec: ServerDeploymentSpec): 'exact' | 'ignored' {
  return spec.resources === undefined ? 'ignored' : 'exact';
}

/** Read the baked environment of the image a spec pins. A missing image is not a
 *  match failure to paper over: the container under comparison is running it. */
export async function specImageEnvironment(
  docker: Pick<DockerClient, 'inspectImageEnv'>,
  image: string,
): Promise<readonly string[]> {
  if (docker.inspectImageEnv === undefined)
    throw new Error('managed container comparison requires image inspection');
  const env = await docker.inspectImageEnv(image);
  if (env === undefined) throw new Error(`managed container image is not present: ${image}`);
  return env;
}

/**
 * A sealed environment SOURCE that this host cannot resolve right now: an env
 * variable the Updater's Compose service no longer sets, a secret file that is
 * not mounted.
 *
 * Distinguished from every other failure in `resolveEnvironment` because it is
 * the only one that says nothing about the container already running. A spec
 * naming a name twice is corrupt, a value carrying a NUL is garbage, and a
 * deployment id that disagrees with the authority is a different install — those
 * are facts, and they stay fatal. An unresolvable source is a fact about the
 * Updater's own environment, and a Server that is up was created back when it
 * resolved; refusing to exist does not get that value back, it only removes the
 * channel through which the value could be restored.
 */
class ManagedServerEnvironmentSourceError extends Error {
  /** The sealed entry whose source failed — reported as the drifting name, since
   *  the running Server is serving on whatever that source used to yield. */
  readonly variable: string;

  constructor(variable: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.variable = variable;
  }
}

interface EnvironmentResolution {
  /** Every sealed entry this host could resolve, as `NAME=value`. */
  readonly env: string[];
  /** The entries it could not, in sealed order. */
  readonly unresolved: readonly ManagedServerEnvironmentSourceError[];
}

/**
 * Resolve the sealed environment sources against this host.
 *
 * `'strict'` throws on the first source it cannot resolve, which is what BUILDING
 * a Server requires: a Server missing a sealed variable is not the Server the
 * authority describes.
 *
 * `'lenient'` collects them all and returns everything else. That is what JUDGING
 * a running Server requires, and the difference is not cosmetic: stopping at the
 * first failure would report one name and hide both the other unresolvable
 * sources and any resolvable value that has ALSO moved, which is precisely what
 * `GET /v1/reconcile` exists to show. The caller decides what the unresolved
 * entries mean; nothing here tolerates anything.
 *
 * A corrupt spec, a NUL, and a deployment id that disagrees with the authority
 * throw in BOTH modes. Those are facts about the spec rather than about this
 * host, and no amount of leniency makes them safe.
 */
async function resolveEnvironment(
  spec: ServerDeploymentSpec,
  environment: NodeJS.ProcessEnv,
  read: (path: string) => Promise<string>,
  mode: 'strict' | 'lenient' = 'strict',
): Promise<EnvironmentResolution> {
  const result: string[] = [];
  const unresolved: ManagedServerEnvironmentSourceError[] = [];
  const seen = new Set<string>();
  const unresolvable = (error: ManagedServerEnvironmentSourceError): void => {
    if (mode === 'strict') throw error;
    unresolved.push(error);
  };
  for (const entry of spec.environment) {
    if (seen.has(entry.name))
      throw new Error(`duplicate managed Server environment: ${entry.name}`);
    seen.add(entry.name);
    // Checked before the source is touched, not after it fails to resolve. Retired
    // means this build does not give the Server the variable at all, so whether the
    // deployment happens to still supply it changes nothing — and a spec naming a
    // retired secret FILE must not depend on that file still being mounted either.
    // The duplicate check above stays ahead of it: a spec naming one name twice is
    // corrupt whatever the name is.
    if (RETIRED_MANAGED_SERVER_ENVIRONMENT.includes(entry.name)) continue;
    let value: string | undefined;
    if (entry.source.kind === 'env') {
      value = environment[entry.source.name];
      if (value === undefined) {
        unresolvable(
          new ManagedServerEnvironmentSourceError(
            entry.name,
            `managed Server environment source is missing: ${entry.name}`,
          ),
        );
        continue;
      }
    } else {
      try {
        value = (await read(entry.source.path)).replace(/[\r\n]+$/, '');
      } catch (error) {
        // A file source that cannot be read is the same fact as an env source
        // that is unset, and has to arrive as the same error — it is the likelier
        // half of the pair, since a secret stops being mounted far more often
        // than a Compose variable disappears.
        unresolvable(
          new ManagedServerEnvironmentSourceError(
            entry.name,
            `managed Server environment source is missing: ${entry.name}`,
            { cause: error },
          ),
        );
        continue;
      }
    }
    if (value.includes('\0'))
      throw new Error(`managed Server environment contains NUL: ${entry.name}`);
    if (entry.name === 'VERITY_MANAGED_DEPLOYMENT_ID' && value !== spec.deploymentId)
      throw new Error('managed Server deployment ID does not match the sealed authority');
    result.push(`${entry.name}=${value}`);
  }
  return { env: result, unresolved };
}

/**
 * The container a spec describes, given an already-resolved environment.
 *
 * Split out because everything here EXCEPT the environment is knowable without
 * the host: image, mounts, user, groups, network, security and ceilings all come
 * straight off the sealed spec. Only `resolveEnvironment` can fail on a host
 * whose sources have moved, so when it does, `reconcileManagedServer` builds this
 * with an empty environment and can still judge the container on every other
 * axis rather than adopting it unexamined.
 */
function containerSpecFrom(spec: ServerDeploymentSpec, env: string[]): ContainerSpec {
  const resources = spec.resources ?? MANAGED_SERVER_DEFAULT_RESOURCES;
  const binds: string[] = [];
  const volumeMounts: NonNullable<ContainerSpec['volumeMounts']> = [];
  for (const mount of spec.mounts) {
    if (mount.source.kind === 'bind') {
      binds.push(`${mount.source.path}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
    } else {
      volumeMounts.push({
        volume: mount.source.name,
        target: mount.target,
        readOnly: mount.readOnly,
      });
    }
  }
  return {
    image: spec.image,
    name: MANAGED_SERVER_NAME,
    labels: {
      [MANAGED_DEPLOYMENT_LABEL]: spec.deploymentId,
      [MANAGED_ROLE_LABEL]: MANAGED_ROLE,
    },
    env,
    user: `${String(spec.user.uid)}:${String(spec.user.gid)}`,
    groupAdd: spec.user.supplementaryGids.map(String),
    binds,
    volumeMounts,
    restartPolicy: spec.restart,
    network: spec.network,
    platform: `linux/${spec.platform.architecture}`,
    readOnlyRootfs: spec.security.readOnlyRootFilesystem,
    securityOpt: ['no-new-privileges:true'],
    entrypoint: ['/usr/bin/tini', '--', 'node', 'packages/server/dist/main.js'],
    command: [],
    capAdd: [...spec.security.capAdd],
    // Host resource guardrails, the ones Compose gives the `verity` service. The
    // managed topology takes the Server away from Compose, so without these the
    // control plane runs with no ceiling at all on a box that also carries the CI
    // runners and every agent sandbox — the drift class that already cost
    // VERITY_BUNDLED_PROJECT_RELAY_IMAGE and memorySwapBytes elsewhere.
    //
    // A spec sealed before the field existed carries no value, and the fallback is
    // exactly what Compose states, so an old spec and a new one build the same
    // container.
    memoryBytes: resources.memoryBytes,
    // Set, not omitted: Docker's default is twice the memory limit, so leaving it
    // out would quietly grant the Server swap that Compose's matching
    // `memswap_limit` denies — trading a clean OOM kill for a thrashing host.
    memorySwapBytes: resources.memorySwapBytes,
    nanoCpus: resources.nanoCpus,
    pidsLimit: resources.pidsLimit,
  };
}

export async function managedServerContainerSpec(
  spec: ServerDeploymentSpec,
  environment: NodeJS.ProcessEnv,
  read: (path: string) => Promise<string>,
): Promise<ContainerSpec> {
  return containerSpecFrom(spec, (await resolveEnvironment(spec, environment, read)).env);
}

/**
 * Reconcile exactly one updater-owned Server without adopting or deleting any
 * foreign container.
 *
 * A mismatch between the sealed spec and the running container used to be a
 * single verdict with a single answer: throw, never recreate. `recoverManagedUpdater`
 * rethrows that whenever no operation is in flight, so the Updater exited,
 * restarted, and refused the same container again — forever. The one operation
 * that would have rebuilt the Server with the current environment is the cutover,
 * which is exactly what the crash loop made unreachable, so the host could not be
 * repaired by the channel that exists to repair it. Two ordinary upstream changes
 * reached production that way in one night.
 *
 * The refusal was right; the exit was not, and they were welded together.
 * {@link describeManagedContainerMismatch} separates them:
 *
 * - `'structural'` is still fatal, running or stopped. The container is not the
 *   Server the authority describes.
 * - `'environment'` on a RUNNING owned Server is tolerated and REPORTED. It is
 *   already serving on that environment and the Updater cannot improve it by
 *   refusing to exist; the mismatch is evidence about the past, not a decision
 *   about the present. `drift` carries the names so `GET /v1/reconcile` can say so.
 * - `'environment'` on a STOPPED owned Server is recreated, because without that
 *   a host reboot would turn every tolerated drift into no Server at all. It
 *   grants no new authority: the environment used is byte-for-byte the one
 *   {@link managedServerContainerSpec} already builds from scratch, which is the
 *   path taken today whenever the container is simply absent.
 *
 * The trade, stated plainly: a name that now resolves WRONGLY — an operator
 * fat-fingers `DATABASE_URL` — moves from "the Updater refuses to run" to "the
 * Server fails to start". Equally loud, but the repair channel survives. Nothing
 * here ever omits a variable; it only tolerates a different value for a name the
 * spec sealed, so the "Server quietly running on defaults" hazard the retired
 * list warns about does not arise.
 */
export async function reconcileManagedServer(
  options: ReconcileManagedServerOptions,
): Promise<ManagedServerReconcileResult> {
  const state = await readManagedDeployment(options.managedRoot);
  if (!state.managed) throw new Error(`managed Server authority unavailable: ${state.reason}`);
  const listContainers = options.docker.listContainers;
  if (listContainers === undefined)
    throw new Error('managed Server reconciliation requires Docker container listing');
  const spec = state.spec;
  const summaries = await listContainers();
  const identity = options.identity;
  const withIdentity = (base: ContainerSpec): ContainerSpec => {
    if (identity === undefined) {
      // A deployment sealed before the bootstrap stopped forwarding it still names the
      // relay as an env source, resolved against the CURRENT Updater — a different
      // release than the Server image being created here. Drop it so the image's own
      // bundled reference wins, which is the only one guaranteed to match it.
      return { ...base, env: comparableEnvironment(base.env ?? [], true) };
    }
    const overrides = new Map<string, string>([
      ['VERITY_CONTROL_PLANE_HOLDER_ID', identity.name],
      ['VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION', '1'],
      ['VERITY_UPDATE_ID', identity.operationId],
    ]);
    const env = (base.env ?? []).filter(
      (entry) => !overrides.has(entry.slice(0, entry.indexOf('='))),
    );
    for (const [name, value] of overrides) env.push(`${name}=${value}`);
    return {
      ...base,
      name: identity.name,
      env,
      labels: {
        ...base.labels,
        'verity.update-id': identity.operationId,
        'verity.generation': String(identity.generation),
      },
    };
  };
  // Resolved LENIENTLY, so a source this host has lost does not stop the reconcile
  // before it has looked at anything. It is fatal for BUILDING a Server and not
  // for JUDGING one that is already up — the running container was created when
  // that source still resolved and is serving on what it yielded, and exiting
  // would remove the only channel through which the source could be restored.
  // `requireBuildable` below is where that distinction is actually made, and it
  // guards every path that would produce or start a Server.
  //
  // Resolving the REST rather than stopping at the first failure is what lets the
  // drift report name every sealed value that has moved, instead of only the one
  // that happened to fail first.
  const resolution = await resolveEnvironment(
    spec,
    options.environment ?? process.env,
    options.readFile ?? ((path) => readFile(path, 'utf8')),
    'lenient',
  );
  const desired = withIdentity(containerSpecFrom(spec, resolution.env));
  // From the SPEC, not from `desired.env`: an unresolved source is missing from
  // the latter while still being a name the spec seals, and judging it against
  // `desired.env` would call the running Server's value for it an injected
  // variable and refuse the container.
  const sealedNames = new Set(spec.environment.map((entry) => entry.name));
  /** Nothing that produces or starts a Server may run while a sealed source is
   *  unresolvable: the result would be a Server missing a variable the authority
   *  says it must have — the "quietly running on defaults" outcome the retired
   *  list exists to prevent. Only leaving an ALREADY-RUNNING Server alone is
   *  defensible, because that one is not being produced. */
  const requireBuildable = (): void => {
    const first = resolution.unresolved[0];
    if (first !== undefined) throw first;
  };
  const desiredName = desired.name;
  const named = summaries.filter((container) => container.names?.includes(desiredName));
  if (named.length > 1) throw new Error('multiple containers use the managed Server name');
  const reuse = async (
    id: string,
    /** Whether a stopped Server whose only mismatch is environment may be
     *  replaced. False on the create-conflict path: a container that appeared
     *  under this name while we were creating one is not ours to delete a second
     *  time, and allowing it would let create and reuse call each other forever. */
    recreatable: boolean,
  ): Promise<ManagedServerReconcileResult> => {
    const inspect = await options.docker.inspectContainer(id);
    if (!ownedBy(inspect, spec.deploymentId))
      throw new Error('managed Server name is occupied by a foreign container');
    const imageEnv = await specImageEnvironment(options.docker, desired.image);
    // Without `identity` this is the steady-state reconcile of whatever the last
    // cutover promoted; with it, a candidate mid-update, which stays exact.
    const verdict = judgeManagedContainer(
      inspect,
      desired,
      imageEnv,
      identity === undefined,
      sealedHostLimitsMode(spec),
      sealedNames,
    );
    if (verdict.kind === 'structural')
      throw new Error('managed Server container conflicts with the sealed deployment spec');
    if (inspect.running) {
      // Tolerating a source this host has lost is an argument about a value the
      // Server ALREADY HAS: it was created when the source resolved, it is
      // serving on what the source yielded, and refusing to exist cannot give
      // that value back. If the container does not carry the name either, there
      // is no such value and the argument is empty — the Server is simply running
      // without a variable the authority says it must have, which is exactly the
      // "quietly running on defaults" state this must not bless. Nothing about
      // that is recoverable by tolerating it, so it stays fatal.
      const absent = resolution.unresolved.find(
        (error) => !environmentByName(sorted(inspect.env)).has(error.variable),
      );
      if (absent !== undefined) throw absent;
      // The comparison alone is the complete report. Every unresolved source is
      // necessarily in it already: tolerance just required the container to carry
      // that name, and the environment built without it therefore differs on
      // exactly that name. Adding the unresolved names separately would be a
      // second path to the same list that no test could tell apart from this one.
      return verdict.environment.length === 0
        ? { containerId: inspect.id, action: 'unchanged' }
        : { containerId: inspect.id, action: 'unchanged', drift: verdict.environment };
    }
    // Nothing is serving, so the "already running on it" argument does not apply
    // and there is no honest Server to produce here — by rebuilding or by
    // starting one that lacks a sealed variable.
    requireBuildable();
    if (verdict.kind === 'environment') {
      if (!recreatable) {
        // The create-conflict path: something else put this container here while
        // we were creating one, and it is stopped and drifted. Replacing it is
        // not ours to do a second time, and STARTING it would be the one thing
        // this change exists to stop — a stopped drifted Server brought up
        // instead of rebuilt. Refusing is transient rather than terminal: the
        // next reconcile finds it as the single named container and rebuilds it
        // with full authority.
        throw new Error('managed Server container conflicts with the sealed deployment spec');
      }
      // Named volumes — `verity-data` above all — are untouched by a container
      // removal, so this replaces the process and keeps every byte of durable
      // state. What it costs is the stopped container's identity, which is the
      // thing that is wrong.
      await options.docker.removeContainer(inspect.id);
      return create();
    }
    await options.docker.startContainer(inspect.id);
    return { containerId: inspect.id, action: 'started' };
  };
  const create = async (): Promise<ManagedServerReconcileResult> => {
    requireBuildable();
    try {
      const created = await options.docker.createContainer(desired);
      await options.docker.startContainer(created.id);
      return { containerId: created.id, action: 'created' };
    } catch (error) {
      if ((error as { kind?: unknown }).kind === 'conflict') {
        const winner = (await listContainers()).filter((container) =>
          container.names?.includes(desiredName),
        );
        if (winner.length !== 1)
          throw new Error('managed Server create conflict has no unique owner', { cause: error });
        return reuse(winner[0]!.id, false);
      }
      if (
        (error as { kind?: unknown }).kind !== 'image_not_found' ||
        options.docker.pullImage === undefined
      )
        throw error;
      await options.docker.pullImage(spec.image);
      const pulled = await options.docker.createContainer(desired);
      await options.docker.startContainer(pulled.id);
      return { containerId: pulled.id, action: 'created' };
    }
  };
  if (named.length === 1) return reuse(named[0]!.id, true);
  return create();
}
