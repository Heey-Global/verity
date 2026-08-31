import type { ContainerInspect } from './docker.js';

/**
 * Stage 5 (Temporary Public Previews spike §7.5): migrate existing shared-network
 * sandboxes onto a dedicated per-project network + relay instead of silently
 * reusing them. This module is the pure decision layer — it classifies a project
 * sandbox from a Docker inspect and decides whether it must be recreated. The
 * destructive recreate itself lives in the provisioner; keeping the policy pure
 * lets the §6 reconciliation rules be exhaustively unit-tested without Docker.
 */

/** Label every Verity sandbox carries identifying its owning project. */
export const PROJECT_ID_LABEL = 'verity.project-id';
/** Label a RELAY-era sandbox carries binding it to its relay generation. A
 *  pre-relay (legacy) sandbox never has it; a migrated sandbox always does. */
export const CONTAINER_GENERATION_LABEL = 'verity.container-generation';

/**
 * How a project's current sandbox container relates to the relay world:
 * - `absent`   — no container exists for this project yet (nothing to migrate).
 * - `migrated` — a relay-era sandbox: carries a container-generation stamp and is
 *                single-homed on its own `verity-proj-<id>` network, its relay is
 *                live, and it carries whole every env block the provisioner writes
 *                as one. Leave it.
 * - `orphaned` — a relay-era sandbox that looks migrated but whose relay is GONE:
 *                the relay container is not running, or this server no longer owns
 *                the listeners and capabilities behind it. The sandbox is intact
 *                but cut off from the broker (no GitHub token, no signing, no
 *                Claude egress), and nothing else recovers it, so it is recreated
 *                on the same path as a legacy sandbox.
 * - `legacy`   — OUR sandbox (project-id matches) but pre-relay / anomalous: no
 *                generation stamp, not single-homed on the project network, or
 *                carrying only part of an env block the provisioner writes whole
 *                ({@link SANDBOX_ENV_COHORTS}). It must be recreated, never silently
 *                reused, once relay mode is on.
 * - `foreign`  — a container that is not this project's Verity sandbox (missing or
 *                mismatched project-id label). Migration must NEVER touch it.
 */
export type ProjectContainerClass = 'absent' | 'legacy' | 'migrated' | 'orphaned' | 'foreign';

/**
 * Groups of env vars the provisioner writes as ONE block — all of them, or none.
 *
 * Classification looked only at labels, networks and relay health, all of which a
 * container keeps forever once stamped. A sandbox provisioned before an env var was
 * introduced therefore classified `migrated`, which means "leave it", and no other
 * path ever revisited it. Observed live: sandboxes built before the Codex egress leg
 * existed carry `VERITY_CLAUDE_EGRESS_URL` but not `VERITY_CODEX_EGRESS_URL`, so the
 * in-sandbox connector answers every Codex request with `502 … it was provisioned
 * without a Codex gateway`. Claude keeps working, the container looks healthy from
 * the outside, and Codex is dead in that project until somebody recreates it by hand.
 *
 * The test is a cohort being PARTIALLY present, deliberately, rather than a list of
 * vars every sandbox must have. The provisioner writes this block behind an
 * all-or-nothing gate (Claude-egress projection: identity service + gateway URL +
 * connector port + secret root), so a deployment that has not opted in gives every
 * sandbox none of these — which "must have" would read as a fleet-wide drift and
 * recreate on every reconcile tick, forever, since `legacy` has no attempt ceiling.
 * Partial presence has no such failure mode: it is a state today's provisioner
 * CANNOT produce, so recreating always resolves it — the new container has the whole
 * cohort or none of it, and either way classifies `migrated`. That property, not the
 * key list, is what makes this safe; keep it when adding a cohort.
 *
 * The known blind spot, and it is the price of that property: a sandbox built while
 * the gate was CLOSED carries none of the cohort, so if the deployment later opens
 * the gate that sandbox keeps no egress at all and nothing here notices — an absent
 * cohort is indistinguishable from a deployment that simply never opted in, which is
 * the overwhelmingly common case and must stay silent. Enabling egress on a
 * deployment that already has sandboxes therefore still needs those sandboxes
 * recreated by hand; only sandboxes that were built with PART of the block repair
 * themselves. Deciding otherwise means asking the provisioner (which knows whether
 * the gate is open now) rather than the container, and accepting a fleet-wide
 * recreate the first time egress is switched on.
 *
 * So a cohort must be exactly a set of vars written together at one call site under
 * one condition. Two vars that merely tend to appear together are not a cohort: the
 * first deployment that sets one without the other recreates its fleet in a loop.
 *
 * This deliberately does NOT compare values. A gateway that moved is a config change
 * every sandbox notices at once; keying on presence keeps the check to the one thing
 * it can be sure about — that this container was built before the var existed.
 */
export const SANDBOX_ENV_COHORTS: readonly (readonly string[])[] = [
  // provisioner.ts — the Claude-egress projection block, which grew the Codex leg.
  [
    'VERITY_CLAUDE_EGRESS_URL',
    'VERITY_CLAUDE_EGRESS_AUTHORITY',
    'VERITY_CODEX_EGRESS_URL',
    'VERITY_CODEX_EGRESS_AUTHORITY',
  ],
];

/**
 * Does this container carry only PART of a cohort — i.e. was it built before the
 * block grew the rest of it?
 *
 * Module-private on purpose. It answers "is part of a block missing", which is only
 * half a verdict: a pre-relay sandbox carrying Claude-era vars answers yes here and
 * is nonetheless legacy for an entirely structural reason. Callers outside get
 * {@link envDriftIsSoleReason}, which is the whole one.
 *
 * An env we do not actually have reads as "no drift", on the same principle as an
 * unprobed relay: a fact we did not gather must never be what condemns a working
 * sandbox. `inspect.env` is populated by a conditional spread over `Config.Env`
 * (`docker.ts`), so it is absent exactly when the inspect carried no env array —
 * an older Docker shim, a partial inspect, a hand-built fixture. An EMPTY list is
 * treated the same way rather than as "this container has no env at all": every
 * real container has at least `PATH`, so an empty read is far likelier to be a
 * shim that dropped the field than a container that genuinely has none, and the
 * cost of being wrong is a recreate.
 *
 * A key present but EMPTY counts as UNUSABLE but still present. The connector's own
 * test is `process.env.VERITY_CODEX_EGRESS_URL === undefined`, so an empty value slips
 * past it and is then used as a URL — broken in a way that reports worse than the 502
 * this check exists to end. So the two halves of the test read the cohort differently:
 * "is any of this block here at all" decides whether the block applies to this
 * container, and "is all of it usable" decides whether it is intact. A cohort whose
 * members are all present and all empty is therefore drift, where treating empty as
 * simply absent would have blessed it as a container the block does not apply to.
 */
function hasPartialEnvCohort(inspect: ContainerInspect): boolean {
  const env = inspect.env;
  // `Array.isArray` rather than an `undefined` check: the input is a parsed Docker
  // reply, so the declared type is a claim about it and not a guarantee. A `null`
  // or a non-array must land on the same safe side as an absent field.
  if (!Array.isArray(env) || env.length === 0) return false;
  const values = new Map<string, string>();
  for (const entry of env) {
    // Same reasoning as the array guard: an element that is not a string is not a
    // variable, and must not throw out of a classification whose whole job is to
    // decide whether to destroy a container.
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('=');
    // Docker writes `KEY=value`. A separator-less entry is not a variable at all, so
    // it is skipped rather than recorded as `entry -> ''` — recording it would let a
    // stray bare `VERITY_CODEX_EGRESS_URL` shadow a real assignment made earlier in
    // the list and condemn a perfectly current sandbox.
    if (separator === -1) continue;
    values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const isPresent = (key: string): boolean => values.has(key);
  const isUsable = (key: string): boolean => (values.get(key) ?? '') !== '';
  return SANDBOX_ENV_COHORTS.some((cohort) => cohort.some(isPresent) && !cohort.every(isUsable));
}

/**
 * Would this container be `migrated` if env were not considered — i.e. is a partial
 * env cohort the ONLY thing wrong with it?
 *
 * Two callers need this rather than the classification alone. It is what makes the
 * recreate attributable: a genuinely pre-relay sandbox that happens to carry
 * Claude-era vars and no Codex ones is `legacy` for a structural reason, and logging
 * that recreate as env drift would misattribute it on the one deploy where the
 * distinction matters. And it is what a bound on repeated drift recreates has to be
 * keyed on, so that suppressing the drift reason can never suppress a structural one.
 */
export function envDriftIsSoleReason(input: ClassifyProjectContainerInput): boolean {
  const { inspect } = input;
  if (inspect === null || inspect === undefined) return false;
  // With the switch off there is no such thing as a drift reason, so there is
  // nothing for drift to be the sole one of. Attribution has to agree with the
  // classifier here or a recreate the switch did NOT cause gets logged as drift.
  if (input.considerEnvDrift === false) return false;
  if (!hasPartialEnvCohort(inspect)) return false;
  // Ask the same classifier with env out of scope: whatever it says now is what is
  // wrong with this container BESIDES its env. `migrated` means nothing is.
  return classifyProjectContainer({ ...input, considerEnvDrift: false }) === 'migrated';
}

/**
 * How many times the reconciler may recreate the SAME project's sandbox for env
 * drift ALONE before it stops trying and reports instead.
 *
 * Every other reason to recreate carries its own proof of termination: a `legacy`
 * sandbox is legacy because of its network and generation, and the recreate sets
 * both, so the next tick classifies it `migrated` whatever else is true of the
 * deployment. Env drift has no such proof. It terminates only if the provisioner,
 * *in this deployment's configuration*, now writes the cohort whole — and the whole
 * point of {@link SANDBOX_ENV_COHORTS} is that the provisioner sometimes writes it
 * and sometimes doesn't. Get the cohort wrong (declare a var here that is written
 * behind a second condition, or split one call site into two), and the recreated
 * sandbox comes back drifted, is recreated again, and the fleet is destroyed one
 * tick at a time — killing every turn that happens to be idle at the moment.
 *
 * The bound turns that from an outage into a log line. It is deliberately keyed on
 * drift being the sole reason ({@link envDriftIsSoleReason}): a sandbox that is also
 * structurally legacy or orphaned keeps its unbounded repair, so exhausting this
 * budget can never strand a container on the wrong network.
 *
 * Three rather than one because a recreate can fail for reasons of its own — a
 * transient image pull, a host under load — and one such failure should not
 * permanently disqualify a project from a repair that would have worked.
 */
export const ENV_DRIFT_RECREATE_LIMIT = 3;

/**
 * How many sandboxes one reconcile pass may recreate for env drift alone.
 *
 * {@link ENV_DRIFT_RECREATE_LIMIT} bounds how often a single project is rebuilt;
 * it says nothing about how many are rebuilt at once. Those are different
 * failures. Drift is a fleet-wide property by construction — it appears when a
 * deployment starts writing a cohort its running sandboxes predate — so the first
 * tick after such a deploy finds *every* idle sandbox drifted and, unthrottled,
 * destroys and rebuilds all of them in one pass. That is the correct repair
 * arriving as an outage.
 *
 * With a cap the same fleet converges over a handful of ticks instead, a few
 * projects at a time, and a rollout that turns out to be wrong is noticed while
 * most sandboxes are still standing. Legacy and orphaned recreates are
 * deliberately not throttled: those are one-off structural faults, already rare
 * and already bounded by the number of pre-relay containers left.
 *
 * Four rather than one because the reconciler ticks once a minute
 * (`PROJECT_RELAY_MIGRATION_INTERVAL_MS`): a cap of one would leave a fifteen-project
 * fleet a quarter of an hour of dead Codex legs, while four clears it in about four
 * minutes and still leaves three quarters of the fleet standing after the first tick
 * — long enough for a bad rollout to be noticed before it has touched everything.
 */
export const ENV_DRIFT_RECREATES_PER_TICK = 4;

export interface ClassifyProjectContainerInput {
  /** Result of `docker.inspectContainer(<sandbox name>)`, or null/undefined when
   *  no such container exists. */
  inspect: ContainerInspect | null | undefined;
  /** The project whose sandbox this container is expected to be. */
  projectId: string;
  /** This project's isolation network name (`projectNetworkName(projectId)`). */
  projectNetwork: string;
  /** Whether this sandbox's relay is live — its container running AND this server
   *  still holding the listeners/capabilities that back it. `undefined` means the
   *  caller did not probe (relay health unknown), which is treated as healthy so a
   *  missing probe can never trigger a destructive recreate. */
  relayHealthy?: boolean | undefined;
  /** Whether a partially-present env cohort counts as a reason to recreate. Default
   *  true; `false` is the deployment kill switch
   *  (`VERITY_RECREATE_ENV_DRIFTED_SANDBOXES=0`) and the internal question
   *  {@link envDriftIsSoleReason} asks.
   *
   *  It lives on the INPUT rather than at the one call site that owns the flag, so
   *  that the switch travels with the question. Implementing it by withholding
   *  `inspect.env` from the classifier worked, but only for the caller that
   *  remembered to withhold it: any second caller — an orphan sweep, a future
   *  diagnostic — would have passed a full inspect and gone on condemning drifted
   *  sandboxes with the emergency switch flipped. A switch one caller can forget is
   *  not an emergency switch. */
  considerEnvDrift?: boolean | undefined;
}

/**
 * Classify a project's sandbox container for migration. Pure — no Docker calls.
 *
 * The `foreign` guard is deliberately strict: a container is only ever eligible
 * for a Verity-driven stop/remove when its `verity.project-id` label equals the
 * project we are reconciling. A container with no such label, or one belonging to
 * a different project, is reported `foreign` so the reconciler leaves it alone
 * (spike §8: "teardown removes the relay and project network without deleting
 * foreign Docker state").
 */
export function classifyProjectContainer(
  input: ClassifyProjectContainerInput,
): ProjectContainerClass {
  const { inspect, projectId, projectNetwork, relayHealthy } = input;
  if (inspect === null || inspect === undefined) return 'absent';

  const labels = inspect.labels ?? {};
  const owner = labels[PROJECT_ID_LABEL];
  // Not ours (or someone else's) → never a migration target.
  if (owner === undefined || owner !== projectId) return 'foreign';

  const generation = labels[CONTAINER_GENERATION_LABEL];
  const hasGeneration = generation !== undefined && generation !== '';

  const networkNames = Object.keys(inspect.networks ?? {});
  // A migrated sandbox is SINGLE-HOMED on exactly its own project network. Being
  // on the shared network, on no network, or additionally on any other network
  // is an anomaly the reconciler resolves by recreating (spike §6: "multiple
  // project-network attachments, wrong labels").
  const singleHomedOnProjectNetwork =
    networkNames.length === 1 && networkNames[0] === projectNetwork;

  // A sandbox that is structurally migrated is still only USABLE while its relay
  // is live: the broker hostname baked into its env resolves to that one container,
  // and the capabilities on its disk are only redeemable against the listeners this
  // server holds for it. Losing either (server restart, relay container exit) leaves
  // a healthy-looking sandbox with no GitHub token, no commit signing and no egress,
  // and no other path repairs it — `migrated` would park it there forever.
  if (hasGeneration && singleHomedOnProjectNetwork) {
    if (relayHealthy === false) return 'orphaned';
    // Structurally migrated, but built before env it now needs. `legacy` rather than
    // `orphaned` on purpose: such a sandbox still reaches its broker and still signs
    // commits, so it is only PARTLY broken and can afford to wait for idle. Orphans
    // get a bounded defer window because their own breakage keeps the project busy;
    // this one has no such livelock, so the gentler path is also the correct one.
    if (input.considerEnvDrift === false) return 'migrated';
    return hasPartialEnvCohort(inspect) ? 'legacy' : 'migrated';
  }
  return 'legacy';
}

/** The relay generation a sandbox is stamped with, or undefined when it carries no
 *  usable stamp (pre-relay sandbox). Callers need it to address that sandbox's
 *  relay; the label name stays owned by this module. */
export function containerGenerationOf(
  inspect: ContainerInspect | null | undefined,
): string | undefined {
  const generation = inspect?.labels?.[CONTAINER_GENERATION_LABEL];
  return generation === undefined || generation === '' ? undefined : generation;
}

/**
 * What the reconciler should do with a classified container:
 * - `none`        — nothing to do (already migrated, or no container).
 * - `migrate`     — recreate now onto a relay + project network. Covers both a
 *                   legacy sandbox and an orphaned one: the container phase that
 *                   recreates them starts a fresh relay and issues fresh
 *                   capabilities, which is exactly what an orphan is missing.
 * - `defer`       — a legacy or orphaned sandbox with a turn in flight; recreating
 *                   would kill the live docker-exec agent, so surface
 *                   `migration_pending` and retry on the next reconcile tick. For
 *                   an orphan the deferral is BOUNDED (`ORPHAN_DEFER_TICK_LIMIT`),
 *                   because its own breakage is what keeps the project busy.
 * - `skip-foreign`— a non-Verity / other-project container; do not touch it.
 */
export type MigrationAction = 'none' | 'migrate' | 'defer' | 'skip-foreign';

/**
 * How many CONSECUTIVE reconcile ticks an orphaned sandbox may hold off its own
 * repair by being busy. Past this the repair outranks the turn.
 *
 * An orphaned sandbox has no broker, no signing and no egress, so a turn running
 * inside it cannot finish anything that needs them — and an agent that retries a
 * brokered step keeps the project busy for as long as it retries. Deferring on
 * `busy` alone is therefore a livelock, not patience: the retries that make the
 * project busy are caused by the very breakage the deferral is postponing, and
 * the sandbox is never repaired (observed live: a project deferred every tick
 * across a whole server generation while its agent re-attempted a signed commit).
 *
 * The window keeps SBX-1's intent for the case it was written for — a turn that
 * is nearly done should get to finish rather than be killed for a migration —
 * while guaranteeing forward progress. `legacy` sandboxes are excluded: they are
 * fully functional, only on the wrong network, so waiting for idle costs nothing.
 * So is a busy state that was never confirmed (see `busyConfirmed`): the window
 * may only be spent against a turn we know exists.
 */
export const ORPHAN_DEFER_TICK_LIMIT = 5;

/**
 * How many CONSECUTIVE failed automatic recreates make a sandbox's self-repair
 * count as stalled rather than merely in progress.
 *
 * A Server handoff resumes the existing generation so active work is uninterrupted,
 * then ordinary image drift joins the busy-safe automatic repair queue. This
 * threshold separates a transient recreate failure from a genuinely stuck repair.
 *
 * Two is the smallest number that separates the two conditions: one failure can
 * be a registry blip or a daemon hiccup that the next tick (60 s later) clears on
 * its own, while two consecutive ones mean the retry itself is not working.
 * Erring high costs only a minute of delay before the report appears; erring low
 * costs the report its meaning.
 */
export const SANDBOX_SELF_REPAIR_FAILURE_LIMIT = 2;

export interface DecideMigrationActionInput {
  classification: ProjectContainerClass;
  /** True when a session bound to this project is running a turn right now. */
  busy: boolean;
  /** Whether `busy` is an ANSWER rather than a fallback. The busy probe reports
   *  `true` both for a real turn and for "I could not find out" (unattached probe,
   *  probe threw) — a fail-safe that keeps an automated recreate from stopping a
   *  sandbox under a session it cannot prove idle. Only a confirmed `busy` may
   *  spend the orphan grace window; an unproven one defers forever, exactly as it
   *  did before the window existed. Absent reads as UNCONFIRMED, so a caller that
   *  does not distinguish the two can never force a recreate. */
  busyConfirmed?: boolean | undefined;
  /** Consecutive earlier ticks that already deferred THIS project's orphan repair
   *  on a confirmed-busy project. Absent (fresh decision, e.g. the provision path)
   *  reads as zero. */
  orphanDeferrals?: number | undefined;
}

export function decideMigrationAction(input: DecideMigrationActionInput): MigrationAction {
  switch (input.classification) {
    case 'legacy':
      return input.busy ? 'defer' : 'migrate';
    case 'orphaned':
      if (!input.busy) return 'migrate';
      if (input.busyConfirmed !== true) return 'defer';
      return (input.orphanDeferrals ?? 0) < ORPHAN_DEFER_TICK_LIMIT ? 'defer' : 'migrate';
    case 'foreign':
      return 'skip-foreign';
    case 'migrated':
    case 'absent':
      return 'none';
  }
}
