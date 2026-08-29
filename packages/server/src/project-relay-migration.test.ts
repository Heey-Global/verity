import { describe, expect, it } from 'vitest';

import type { ContainerInspect } from './docker.js';
import {
  CONTAINER_GENERATION_LABEL,
  ENV_DRIFT_RECREATE_LIMIT,
  ORPHAN_DEFER_TICK_LIMIT,
  PROJECT_ID_LABEL,
  SANDBOX_ENV_COHORTS,
  classifyProjectContainer,
  containerGenerationOf,
  decideMigrationAction,
  envDriftIsSoleReason,
  type ProjectContainerClass,
} from './project-relay-migration.js';

const PROJECT_ID = 'heey-global-verity';
const PROJECT_NETWORK = 'verity-proj-heey-global-verity';

function inspect(overrides: Partial<ContainerInspect>): ContainerInspect {
  return {
    id: 'container-1',
    running: true,
    ...overrides,
  };
}

function classify(
  overrides: Partial<ContainerInspect> | null,
  relayHealthy?: boolean,
): ProjectContainerClass {
  return classifyProjectContainer({
    inspect: overrides === null ? null : inspect(overrides),
    projectId: PROJECT_ID,
    projectNetwork: PROJECT_NETWORK,
    relayHealthy,
  });
}

/** A structurally correct relay-era sandbox — the shape whose classification then
 *  turns purely on whether its relay is still there. */
const MIGRATED_SANDBOX: Partial<ContainerInspect> = {
  labels: {
    [PROJECT_ID_LABEL]: PROJECT_ID,
    [CONTAINER_GENERATION_LABEL]: 'gen-abc',
  },
  networks: { [PROJECT_NETWORK]: { ipAddress: '172.20.0.2' } },
};

/** A sandbox built before the Codex egress leg existed: Claude's vars, none of
 *  Codex's. This is the shape running in the fleet that serves 502s. */
const CLAUDE_ERA_ENV: readonly string[] = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'VERITY_CLAUDE_EGRESS_URL=https://verity:9443',
  'VERITY_CLAUDE_EGRESS_AUTHORITY=verity-agent-gateway:9443',
];

/** The same sandbox as the provisioner builds it today. */
const CURRENT_ERA_ENV: readonly string[] = [
  ...CLAUDE_ERA_ENV,
  'VERITY_CODEX_EGRESS_URL=https://verity:9444',
  'VERITY_CODEX_EGRESS_AUTHORITY=verity-agent-gateway:9444',
];

describe('classifyProjectContainer', () => {
  it('reports absent when there is no container', () => {
    expect(classify(null)).toBe('absent');
    expect(
      classifyProjectContainer({
        inspect: undefined,
        projectId: PROJECT_ID,
        projectNetwork: PROJECT_NETWORK,
      }),
    ).toBe('absent');
  });

  it('reports foreign when the project-id label is missing', () => {
    expect(classify({ networks: { [PROJECT_NETWORK]: {} } })).toBe('foreign');
    expect(classify({ labels: {}, networks: { [PROJECT_NETWORK]: {} } })).toBe('foreign');
  });

  it('reports foreign when the project-id label belongs to another project', () => {
    expect(
      classify({
        labels: { [PROJECT_ID_LABEL]: 'some-other-project' },
        networks: { [PROJECT_NETWORK]: {} },
      }),
    ).toBe('foreign');
  });

  it('reports migrated for a generation-stamped sandbox single-homed on its network', () => {
    expect(
      classify({
        labels: {
          [PROJECT_ID_LABEL]: PROJECT_ID,
          [CONTAINER_GENERATION_LABEL]: 'gen-abc',
        },
        networks: { [PROJECT_NETWORK]: { ipAddress: '172.20.0.2' } },
      }),
    ).toBe('migrated');
  });

  it('reports legacy for our sandbox on the shared network with no generation', () => {
    expect(
      classify({
        labels: { [PROJECT_ID_LABEL]: PROJECT_ID },
        networks: { verity: { ipAddress: '172.19.0.5' } },
      }),
    ).toBe('legacy');
  });

  it('reports legacy for our sandbox on no network at all', () => {
    expect(classify({ labels: { [PROJECT_ID_LABEL]: PROJECT_ID } })).toBe('legacy');
    expect(classify({ labels: { [PROJECT_ID_LABEL]: PROJECT_ID }, networks: {} })).toBe('legacy');
  });

  it('treats an empty generation label as legacy', () => {
    expect(
      classify({
        labels: { [PROJECT_ID_LABEL]: PROJECT_ID, [CONTAINER_GENERATION_LABEL]: '' },
        networks: { [PROJECT_NETWORK]: {} },
      }),
    ).toBe('legacy');
  });

  it('reports legacy when a generation-stamped sandbox is multi-homed (anomaly)', () => {
    // On its project network AND still on the shared network — a partial/stale
    // migration the reconciler must resolve by recreating, never accept as done.
    expect(
      classify({
        labels: {
          [PROJECT_ID_LABEL]: PROJECT_ID,
          [CONTAINER_GENERATION_LABEL]: 'gen-abc',
        },
        networks: { [PROJECT_NETWORK]: {}, verity: {} },
      }),
    ).toBe('legacy');
  });

  it('reports legacy when a generation-stamped sandbox sits on the wrong network', () => {
    expect(
      classify({
        labels: {
          [PROJECT_ID_LABEL]: PROJECT_ID,
          [CONTAINER_GENERATION_LABEL]: 'gen-abc',
        },
        networks: { 'verity-proj-someone-else': {} },
      }),
    ).toBe('legacy');
  });

  it('reports orphaned when a migrated sandbox has lost its relay', () => {
    // The sandbox itself is intact and correctly wired; the relay it points at is
    // gone (server restart, relay container exit), so it can reach neither the
    // GitHub-token broker nor signing nor egress.
    expect(classify(MIGRATED_SANDBOX, false)).toBe('orphaned');
  });

  it('keeps a migrated sandbox migrated while its relay is live', () => {
    expect(classify(MIGRATED_SANDBOX, true)).toBe('migrated');
  });

  it('treats unprobed relay health as healthy, never as orphaned', () => {
    // An absent probe (relay control that cannot answer, or a check that threw)
    // must never be readable as "relay gone" — that would recreate a working
    // sandbox on nothing more than a missing signal.
    expect(classify(MIGRATED_SANDBOX, undefined)).toBe('migrated');
    expect(
      classifyProjectContainer({
        inspect: inspect(MIGRATED_SANDBOX),
        projectId: PROJECT_ID,
        projectNetwork: PROJECT_NETWORK,
      }),
    ).toBe('migrated');
  });

  it('keeps a dead relay from reclassifying containers that are not ours', () => {
    // `foreign` and `legacy` outrank relay health: a lost relay must not become a
    // second route to touching someone else's container.
    expect(classify({ networks: { [PROJECT_NETWORK]: {} } }, false)).toBe('foreign');
    expect(classify({ labels: { [PROJECT_ID_LABEL]: PROJECT_ID } }, false)).toBe('legacy');
    expect(classify(null, false)).toBe('absent');
  });

  it('reports legacy when a migrated sandbox predates env it now needs', () => {
    // Observed live: sandboxes built before the Codex egress leg existed carry the
    // Claude egress vars and not the Codex ones, so the in-sandbox connector answers
    // every Codex request with `502 … provisioned without a Codex gateway`. Labels,
    // networks and relay health all still look perfect, so before this the container
    // classified `migrated` — "leave it" — and nothing ever revisited it.
    expect(classify({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }, true)).toBe('legacy');
  });

  it('keeps a migrated sandbox migrated once it carries the required env', () => {
    // One of the two shapes the container phase can produce, and so half of the
    // termination argument for the recreate this classification triggers (the other
    // half is the cohort-less sandbox further down). That these are the ONLY two
    // shapes — that the cohort is emitted whole or not at all — is a property of the
    // provisioner, pinned there ("writes every env cohort whole or not at all",
    // `provisioner.test.ts`), because nothing in this pure module can observe it.
    expect(classify({ ...MIGRATED_SANDBOX, env: [...CURRENT_ERA_ENV] }, true)).toBe('migrated');
  });

  it('treats env the inspect never read as no drift, never as a recreate', () => {
    // Same principle as an unprobed relay: a fact we did not gather must not be what
    // condemns a working sandbox. An older Docker shim or a partial inspect reports
    // no env at all, and that must read as "nothing known", not "nothing set".
    expect(classify(MIGRATED_SANDBOX, true)).toBe('migrated');
  });

  it('treats an empty env list as unread rather than as a sandbox with no env', () => {
    // Every real container carries at least PATH, so an empty list is far likelier
    // to be a shim that dropped the field than a container that genuinely has none —
    // and being wrong about it costs a fleet-wide recreate.
    expect(classify({ ...MIGRATED_SANDBOX, env: [] }, true)).toBe('migrated');
  });

  it('treats a non-array env as unread rather than as a sandbox with no env', () => {
    // The input is a parsed Docker reply, so the declared type is a claim about it.
    // A `null` must land on the same safe side as an absent field.
    const nulled = { ...MIGRATED_SANDBOX, env: null } as unknown as Partial<ContainerInspect>;
    expect(classify(nulled, true)).toBe('migrated');
  });

  it('ignores a separator-less env entry instead of letting it shadow a real one', () => {
    // Docker writes `KEY=value`; a bare word is not a variable. Recorded as
    // `entry -> ''` it would mask a real assignment made EARLIER in the list — the
    // map is last-write-wins, so the bare entry has to come last to shadow anything —
    // and condemn a sandbox that is entirely current.
    expect(
      classify({ ...MIGRATED_SANDBOX, env: [...CURRENT_ERA_ENV, 'VERITY_CODEX_EGRESS_URL'] }, true),
    ).toBe('migrated');
  });

  it('ignores an env entry that is not a string at all', () => {
    // A classification whose job is to decide whether to destroy a container must
    // not throw on a malformed reply.
    const malformed = {
      ...MIGRATED_SANDBOX,
      env: [...CURRENT_ERA_ENV, 42, null],
    } as unknown as Partial<ContainerInspect>;
    expect(classify(malformed, true)).toBe('migrated');
  });

  it('counts a required var that is present but empty as missing', () => {
    // The connector tests `=== undefined`, so an empty value slips past it and is
    // then used as a URL — a worse failure than the 502 this check exists to end.
    expect(
      classify(
        {
          ...MIGRATED_SANDBOX,
          env: CURRENT_ERA_ENV.map((entry) =>
            entry.startsWith('VERITY_CODEX_EGRESS_URL=') ? 'VERITY_CODEX_EGRESS_URL=' : entry,
          ),
        },
        true,
      ),
    ).toBe('legacy');
  });

  it('lets a lost relay outrank env drift', () => {
    // Both are true of the same container; `orphaned` is the more urgent repair and
    // the one with a bounded defer window, so it must win.
    expect(classify({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }, false)).toBe('orphaned');
  });

  it('never lets env drift reach a container that is not ours', () => {
    expect(classify({ networks: { [PROJECT_NETWORK]: {} }, env: [...CLAUDE_ERA_ENV] }, true)).toBe(
      'foreign',
    );
  });

  it('leaves a sandbox alone when it carries NONE of a cohort', () => {
    // The one that makes this safe to ship. The provisioner writes the egress block
    // behind an all-or-nothing gate, so a deployment that has not opted in gives every
    // sandbox none of these vars. Read as "must have", that would be a fleet-wide
    // drift recreated on every reconcile tick forever — `legacy` has no attempt
    // ceiling. Absence of the whole cohort must therefore be silence, not a verdict.
    expect(
      classify({ ...MIGRATED_SANDBOX, env: ['PATH=/usr/local/bin:/usr/bin:/bin'] }, true),
    ).toBe('migrated');
  });

  it('still calls a cohort drifted when every member of it is present but empty', () => {
    // The gap between the two halves of the test. "Is any of this here" has to read
    // presence, or an all-empty cohort would look like a sandbox the block does not
    // apply to and be blessed — while the connector, which tests `=== undefined`,
    // would happily use those empty strings as URLs.
    expect(
      classify(
        {
          ...MIGRATED_SANDBOX,
          env: [
            'PATH=/usr/local/bin:/usr/bin:/bin',
            ...SANDBOX_ENV_COHORTS[0]!.map((key) => `${key}=`),
          ],
        },
        true,
      ),
    ).toBe('legacy');
  });

  it('blesses a drifted sandbox when the caller switched drift off', () => {
    // The kill switch, pinned where it lives. It used to be applied by one caller
    // withholding `inspect.env` before asking, which meant a second caller — an
    // orphan sweep, a diagnostic added later — would keep condemning drifted
    // sandboxes with the deployment's emergency switch flipped. On the input, the
    // switch travels with the question and there is no way to ask without it.
    const drifted = { ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] };
    expect(classify(drifted, true)).toBe('legacy');
    expect(
      classifyProjectContainer({
        inspect: inspect(drifted),
        projectId: PROJECT_ID,
        projectNetwork: PROJECT_NETWORK,
        relayHealthy: true,
        considerEnvDrift: false,
      }),
    ).toBe('migrated');
  });

  it('still condemns a structurally legacy sandbox with drift switched off', () => {
    // The switch suppresses one reason, not the classifier. A pre-relay container has
    // no broker, signing or egress at all, and must be recreated whatever an operator
    // has decided about env drift.
    expect(
      classifyProjectContainer({
        // Ours by label, but pre-relay: no generation stamp, not on its own network.
        inspect: inspect({ labels: { [PROJECT_ID_LABEL]: PROJECT_ID }, env: [...CLAUDE_ERA_ENV] }),
        projectId: PROJECT_ID,
        projectNetwork: PROJECT_NETWORK,
        relayHealthy: true,
        considerEnvDrift: false,
      }),
    ).toBe('legacy');
  });

  it('names only env blocks the provisioner writes whole', () => {
    // A cohort must be exactly one call site under one condition; two vars that merely
    // tend to appear together would recreate a fleet in a loop the first time a
    // deployment set one without the other. Pinned so that stays a deliberate edit.
    expect(SANDBOX_ENV_COHORTS).toEqual([
      [
        'VERITY_CLAUDE_EGRESS_URL',
        'VERITY_CLAUDE_EGRESS_AUTHORITY',
        'VERITY_CODEX_EGRESS_URL',
        'VERITY_CODEX_EGRESS_AUTHORITY',
      ],
    ]);
  });
});

describe('envDriftIsSoleReason', () => {
  function soleReason(
    overrides: Partial<ContainerInspect> | null,
    relayHealthy?: boolean,
  ): boolean {
    return envDriftIsSoleReason({
      inspect: overrides === null ? null : inspect(overrides),
      projectId: PROJECT_ID,
      projectNetwork: PROJECT_NETWORK,
      relayHealthy,
    });
  }

  it('is true for a sandbox that is current in every way except its env', () => {
    expect(soleReason({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }, true)).toBe(true);
  });

  it('is false for a pre-relay sandbox that happens to carry Claude-era env', () => {
    // The attribution that matters on the first deploy of a new cohort: this sandbox
    // is legacy because it has no generation stamp and is not on its project network,
    // and it would be recreated for that alone. Blaming the recreate on the cohort
    // would point whoever reads the log at the wrong change — and, because the drift
    // budget is keyed on this answer, would let a spent budget strand a container on
    // the shared network.
    expect(soleReason({ env: [...CLAUDE_ERA_ENV] }, true)).toBe(false);
  });

  it('is false when the relay is gone as well', () => {
    // `orphaned` outranks drift, and its repair is the unbounded one. Reporting this
    // as drift-only would let the bounded budget suppress it.
    expect(soleReason({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }, false)).toBe(false);
  });

  it('is false for a sandbox whose env is whole, and for one with no container', () => {
    expect(soleReason({ ...MIGRATED_SANDBOX, env: [...CURRENT_ERA_ENV] }, true)).toBe(false);
    expect(soleReason(null, true)).toBe(false);
  });

  it('reports no drift reason at all when the caller switched drift off', () => {
    // Attribution has to agree with the classifier, or the kill switch produces a
    // sandbox that is `migrated` — nothing to repair — while the recreate that did
    // not happen would still have been logged as an env-drift repair.
    expect(
      envDriftIsSoleReason({
        inspect: inspect({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }),
        projectId: PROJECT_ID,
        projectNetwork: PROJECT_NETWORK,
        relayHealthy: true,
        considerEnvDrift: false,
      }),
    ).toBe(false);
  });

  it('bounds how often the same drift may be recreated', () => {
    // Every other recreate proves it fixed what it repaired — a recreate sets the
    // network and the generation. This one cannot: the env a sandbox comes back with
    // is decided by the deployment's config, so a wrongly declared cohort would
    // rebuild the fleet every tick forever. More than one, because a recreate can
    // fail for reasons of its own and one bad attempt should not disqualify a project
    // from a repair that would have worked; small, because every attempt past the
    // first is only there to absorb that.
    expect(ENV_DRIFT_RECREATE_LIMIT).toBe(3);
  });
});

describe('containerGenerationOf', () => {
  it('returns the generation stamp a relay-era sandbox carries', () => {
    expect(containerGenerationOf(inspect(MIGRATED_SANDBOX))).toBe('gen-abc');
  });

  it('returns undefined when there is no usable stamp', () => {
    expect(containerGenerationOf(null)).toBeUndefined();
    expect(containerGenerationOf(undefined)).toBeUndefined();
    expect(containerGenerationOf(inspect({}))).toBeUndefined();
    expect(
      containerGenerationOf(inspect({ labels: { [CONTAINER_GENERATION_LABEL]: '' } })),
    ).toBeUndefined();
  });
});

describe('decideMigrationAction', () => {
  it('migrates an idle legacy container', () => {
    expect(decideMigrationAction({ classification: 'legacy', busy: false })).toBe('migrate');
  });

  it('defers a busy legacy container', () => {
    expect(decideMigrationAction({ classification: 'legacy', busy: true })).toBe('defer');
  });

  it('recreates an idle orphaned container and defers a busy one', () => {
    // Same handling as legacy: recreating is what re-establishes the relay, and a
    // live turn still outranks it — a broker-less sandbox is broken, but killing a
    // running agent to fix it is worse than waiting for the next tick.
    expect(decideMigrationAction({ classification: 'orphaned', busy: false })).toBe('migrate');
    expect(decideMigrationAction({ classification: 'orphaned', busy: true })).toBe('defer');
  });

  it('stops deferring a busy orphan once the tick limit is reached', () => {
    // The livelock this bounds: the turn keeping the project busy is running in a
    // sandbox with no broker, so every brokered step it retries fails, and each
    // retry renews the busy flag that postpones the repair. Waiting for idle never
    // ends. Up to the limit we still wait; past it the repair takes the turn.
    for (let deferrals = 0; deferrals < ORPHAN_DEFER_TICK_LIMIT; deferrals += 1) {
      expect(
        decideMigrationAction({
          classification: 'orphaned',
          busy: true,
          busyConfirmed: true,
          orphanDeferrals: deferrals,
        }),
      ).toBe('defer');
    }
    expect(
      decideMigrationAction({
        classification: 'orphaned',
        busy: true,
        busyConfirmed: true,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT,
      }),
    ).toBe('migrate');
  });

  it('never spends the window on a busy state that was not confirmed', () => {
    // `busy` is also what the probe reports when it is unattached or threw. That
    // fallback must keep deferring forever: burning the window on it would let a
    // wedged probe hand a real, working turn to a recreate.
    expect(
      decideMigrationAction({
        classification: 'orphaned',
        busy: true,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT * 10,
      }),
    ).toBe('defer');
    expect(
      decideMigrationAction({
        classification: 'orphaned',
        busy: true,
        busyConfirmed: false,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT * 10,
      }),
    ).toBe('defer');
  });

  it('never lets the deferral count force a legacy or foreign container', () => {
    // A legacy sandbox is fully functional — only on the wrong network — so there
    // is no breakage driving the retries and no reason to ever kill its turn. And
    // no counter may promote a foreign container into a stop/remove target.
    expect(
      decideMigrationAction({
        classification: 'legacy',
        busy: true,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT * 10,
      }),
    ).toBe('defer');
    expect(
      decideMigrationAction({
        classification: 'foreign',
        busy: true,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT * 10,
      }),
    ).toBe('skip-foreign');
  });

  it('never touches a foreign container regardless of busy state', () => {
    expect(decideMigrationAction({ classification: 'foreign', busy: false })).toBe('skip-foreign');
    expect(decideMigrationAction({ classification: 'foreign', busy: true })).toBe('skip-foreign');
  });

  it('does nothing for already-migrated or absent containers', () => {
    expect(decideMigrationAction({ classification: 'migrated', busy: false })).toBe('none');
    expect(decideMigrationAction({ classification: 'migrated', busy: true })).toBe('none');
    expect(decideMigrationAction({ classification: 'absent', busy: false })).toBe('none');
  });

  it('recreates an idle env-drifted sandbox and waits out a busy one', () => {
    // End-to-end over the two halves the reconciler actually composes: an env-drifted
    // sandbox classifies `legacy`, and `legacy` is the path that waits for idle
    // unconditionally. That is the intended pairing — such a sandbox still reaches its
    // broker and still signs commits, so it is only PARTLY broken and has no livelock
    // to break out of; it can afford to wait however long the turn takes.
    const drifted = classify({ ...MIGRATED_SANDBOX, env: [...CLAUDE_ERA_ENV] }, true);
    expect(drifted).toBe('legacy');
    expect(decideMigrationAction({ classification: drifted, busy: false })).toBe('migrate');
    expect(decideMigrationAction({ classification: drifted, busy: true })).toBe('defer');
    // And no orphan grace window applies, however many ticks it has already deferred.
    expect(
      decideMigrationAction({
        classification: drifted,
        busy: true,
        busyConfirmed: true,
        orphanDeferrals: ORPHAN_DEFER_TICK_LIMIT + 10,
      }),
    ).toBe('defer');
  });
});
