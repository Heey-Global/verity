import { LIST_SESSIONS_FIELDS, LIST_SESSIONS_MAX_ENTRIES } from '@verity/events';
import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneSessionAuthorityError,
  createControlPlaneSessionTools,
  SESSION_HANDOFF_ENVELOPE,
  SESSION_HANDOFF_TRANSCRIPT_LABEL,
  type ControlPlaneSessionEntry,
  type ControlPlaneSessionFacts,
  type ControlPlaneSessionToolDeps,
} from './session-handoff-tool.js';

const CONTROL_PROJECT_ID = 'verity-control';

function project(overrides: Partial<ProjectRecord> & Pick<ProjectRecord, 'id'>): ProjectRecord {
  return {
    owner: 'acme',
    repo: overrides.id,
    containerName: `verity-${overrides.id}`,
    kind: 'github',
    imageRef: null,
    state: 'active',
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
    ...overrides,
  };
}

function facts(
  overrides: Partial<ControlPlaneSessionFacts> & Pick<ControlPlaneSessionFacts, 'sessionId'>,
): ControlPlaneSessionFacts {
  return {
    projectId: 'k8s',
    model: 'claude-opus-5',
    status: 'idle',
    resumable: true,
    eventCount: 3,
    lastActivityAt: 1_700_000_000_000,
    ...overrides,
  };
}

const PROJECTS: ProjectRecord[] = [
  project({ id: 'k8s' }),
  project({ id: 'website' }),
  project({ id: 'stopped', state: 'container_starting' }),
  project({ id: 'archived', archived: true }),
  project({ id: 'hidden', hiddenAt: new Date(0) }),
  project({ id: CONTROL_PROJECT_ID, kind: 'control_plane' }),
];

const SESSIONS: ControlPlaneSessionFacts[] = [
  facts({ sessionId: 'sess-k8s', projectId: 'k8s', status: 'running' }),
  facts({ sessionId: 'sess-web', projectId: 'website' }),
  facts({ sessionId: 'sess-gone', projectId: 'website', resumable: false }),
  facts({ sessionId: 'sess-stopped', projectId: 'stopped' }),
  facts({ sessionId: 'sess-archived', projectId: 'archived' }),
  facts({ sessionId: 'sess-hidden', projectId: 'hidden' }),
  facts({ sessionId: 'sess-control', projectId: CONTROL_PROJECT_ID }),
  facts({ sessionId: 'sess-legacy-control', projectId: null }),
  facts({ sessionId: 'sess-orphan', projectId: 'deleted-project' }),
];

function harness(
  overrides: {
    sessions?: ControlPlaneSessionFacts[];
    omitted?: number;
    projects?: ProjectRecord[];
    // Taken from the deps type rather than restated, so a new field on the dispatch input
    // reaches these assertions instead of being silently dropped by a narrower stub.
    dispatchTurn?: ControlPlaneSessionToolDeps['dispatchTurn'];
    createSession?: ControlPlaneSessionToolDeps['createSession'];
    readProgress?: ControlPlaneSessionToolDeps['readProgress'];
    readRecentMessages?: ControlPlaneSessionToolDeps['readRecentMessages'];
  } = {},
) {
  const dispatchTurn = vi.fn(overrides.dispatchTurn ?? (async () => ({ queued: false })));
  // Deliberately ignores `keep`: the prefilter is a cost optimisation the route may implement
  // badly or not at all, so every assertion below is really about the module's own re-check.
  // `keep` itself is asserted separately.
  const keeps: ((candidate: { sessionId: string; projectId: string | null }) => boolean)[] = [];
  // Recorded next to `keeps` and asserted by index: the two arguments are one prefilter, and a
  // predicate that narrows correctly while the resumable flag is wrong still costs the caller
  // an event-log read per dead session.
  const requireResumables: boolean[] = [];
  const limits: (number | undefined)[] = [];
  const tools = createControlPlaneSessionTools({
    controlProjectId: CONTROL_PROJECT_ID,
    getSession: async (sessionId) => {
      if (sessionId === 'control-session') return { projectId: CONTROL_PROJECT_ID };
      // A Control session from before sessions carried a project id.
      if (sessionId === 'legacy-control-session') return { projectId: null };
      // A session that exists but belongs to a project of its own.
      if (sessionId === 'moved-session') return { projectId: 'website' };
      return undefined;
    },
    listProjects: async () => overrides.projects ?? PROJECTS,
    listSessionFacts: async (keep, requireResumable, limit) => {
      keeps.push(keep);
      requireResumables.push(requireResumable);
      limits.push(limit);
      return { sessions: overrides.sessions ?? SESSIONS, omitted: overrides.omitted ?? 0 };
    },
    dispatchTurn,
    ...(overrides.createSession === undefined ? {} : { createSession: overrides.createSession }),
    ...(overrides.readProgress === undefined ? {} : { readProgress: overrides.readProgress }),
    ...(overrides.readRecentMessages === undefined
      ? {}
      : { readRecentMessages: overrides.readRecentMessages }),
  });
  const call = (request: unknown) => ({
    projectId: CONTROL_PROJECT_ID,
    sessionId: 'control-session',
    turnId: 'turn-1',
    callId: 'call-1',
    invocationId: 'invocation-1',
    request,
  });
  return { tools, dispatchTurn, call, keeps, requireResumables, limits };
}

describe('control-plane session tools — authority', () => {
  it('refuses a caller that is not in the Control project', async () => {
    const { tools } = harness();
    const fromProject = {
      projectId: 'k8s',
      sessionId: 'control-session',
      turnId: 'turn-1',
      callId: 'call-1',
      invocationId: 'invocation-1',
      request: {},
    };
    await expect(tools.listSessions(fromProject)).rejects.toThrow(
      'restricted to Verity Control sessions',
    );
    await expect(
      tools.handoff({
        ...fromProject,
        request: { target: { sessionId: 'sess-k8s' }, title: 't', briefing: 'b' },
      }),
    ).rejects.toThrow('restricted to Verity Control sessions');
  });

  it('refuses a caller whose session the store no longer knows', async () => {
    const { tools, call } = harness();
    await expect(tools.listSessions({ ...call({}), sessionId: 'vanished' })).rejects.toThrow(
      'originating Verity Control session no longer exists',
    );
  });

  it('marks every authority refusal as such, so the audit trail does not read it as an outage', async () => {
    const { tools, call } = harness();
    const refusals = [
      tools.listSessions({ ...call({}), projectId: 'k8s' }),
      tools.listSessions({ ...call({}), sessionId: 'vanished' }),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toBeInstanceOf(ControlPlaneSessionAuthorityError);
    }
    // A refusal about the TARGET is not an authority failure: the caller was allowed to ask.
    await expect(
      tools.handoff(call({ target: { sessionId: 'sess-gone' }, title: 't', briefing: 'b' })),
    ).rejects.not.toBeInstanceOf(ControlPlaneSessionAuthorityError);
  });

  it('refuses a session that has moved to another project, but not one with no project row', async () => {
    const { tools, call } = harness();
    // The gateway connection already proved the Control project; a session row that names a
    // DIFFERENT project contradicts it, and is refused. A row that names none — a Control
    // session predating project binding — contradicts nothing, so it still works.
    await expect(tools.listSessions({ ...call({}), sessionId: 'moved-session' })).rejects.toThrow(
      'originating session is not a Verity Control session',
    );
    await expect(
      tools.listSessions({ ...call({}), sessionId: 'legacy-control-session' }),
    ).resolves.toMatchObject({ sessions: expect.any(Array) });
  });
});

describe('verity_list_sessions', () => {
  it('lists only sessions a handoff could reach, and never a Control session', async () => {
    const { tools, call } = harness();
    const { sessions } = await tools.listSessions(call({}));
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-k8s', 'sess-web']);
    expect(sessions.every((s) => s.handoffEligible)).toBe(true);
  });

  it('keeps ineligible sessions visible with a reason under activeOnly:false, still without Control sessions', async () => {
    const { tools, call } = harness();
    const { sessions } = await tools.listSessions(call({ activeOnly: false }));
    // `sess-control` (Control project), `sess-legacy-control` (no project), `sess-orphan`
    // (project left the registry) and `sess-hidden` (project soft-deleted) are not merely
    // ineligible — they are unaddressable, so they are absent rather than listed with a
    // reason.
    expect(sessions.map((s) => s.sessionId)).toEqual([
      'sess-k8s',
      'sess-web',
      'sess-gone',
      'sess-stopped',
      'sess-archived',
    ]);
    expect(sessions.find((s) => s.sessionId === 'sess-gone')).toMatchObject({
      handoffEligible: false,
      handoffBlockedBy: expect.stringContaining('cannot be resumed'),
    });
    expect(sessions.find((s) => s.sessionId === 'sess-stopped')).toMatchObject({
      handoffEligible: false,
      handoffBlockedBy: expect.stringContaining('sandbox is not active (container_starting)'),
    });
    expect(sessions.find((s) => s.sessionId === 'sess-archived')).toMatchObject({
      handoffEligible: false,
      handoffBlockedBy: 'project archived is archived',
    });
  });

  it('refuses a Control project reference outright rather than reporting it empty', async () => {
    // The handoff refuses this reference by name. The listing has to say the same thing:
    // "no sessions here" would be a different — and false — statement about a project that
    // is simply not this tool's to describe.
    const { tools, call } = harness();
    await expect(tools.listSessions(call({ project: CONTROL_PROJECT_ID }))).rejects.toThrow(
      'Verity Control sessions are not listed',
    );
    await expect(
      tools.handoff(call({ target: { project: CONTROL_PROJECT_ID }, title: 't', briefing: 'b' })),
    ).rejects.toThrow('cannot target a Verity Control session');
  });

  it('names why a blocked project is empty rather than answering that it is', async () => {
    // The prefilter drops every session in an archived or non-active project, so the default
    // listing narrowed to one would come back `{ sessions: [], omitted: 0 }` — the same answer
    // as a live project nobody is working in. The caller reads that as "those sessions do not
    // exist", which is the conclusion this tool is built to prevent.
    const { tools, call } = harness();
    await expect(tools.listSessions(call({ project: 'archived' }))).rejects.toThrow(
      'project archived is archived',
    );
    await expect(tools.listSessions(call({ project: 'stopped' }))).rejects.toThrow(
      'project stopped sandbox is not active (container_starting) — repair it and retry',
    );
    // The handoff refuses by name too, instead of searching and reporting "has no session that
    // can receive a handoff — open one", which would be false advice: a new session in an
    // archived project is just as blocked.
    await expect(
      tools.handoff(call({ target: { project: 'archived' }, title: 't', briefing: 'b' })),
    ).rejects.toThrow('project archived is archived');

    // `activeOnly: false` asked for the ineligible ones deliberately, so it still gets them —
    // each carrying the reason the two calls above refuse with.
    const { sessions } = await tools.listSessions(call({ project: 'archived', activeOnly: false }));
    expect(sessions).toMatchObject([
      {
        sessionId: 'sess-archived',
        handoffEligible: false,
        handoffBlockedBy: 'project archived is archived',
      },
    ]);
  });

  it('asks the route to skip unaddressable sessions before it pays to project them', async () => {
    // Building a session's facts costs a full event-log read, so the module tells the route
    // which rows it will drop anyway. Advisory only — the drop itself is re-decided from the
    // facts that come back.
    const { tools, call, keeps } = harness();
    await tools.listSessions(call({ activeOnly: false }));
    const keep = keeps[0]!;
    expect(keep({ sessionId: 'sess-k8s', projectId: 'k8s' })).toBe(true);
    for (const projectId of [null, 'deleted-project', 'hidden', CONTROL_PROJECT_ID]) {
      expect(keep({ sessionId: 'sess-x', projectId })).toBe(false);
    }
  });

  it('skips a project whose sessions the default listing would drop anyway', async () => {
    // The no-argument listing is the common call, and every session in an archived or
    // non-active project is ineligible by the project row alone — so none of them is worth an
    // event-log read. Still advisory: `entryFor` recomputes the blocker from the facts.
    const { tools, call, keeps, requireResumables } = harness();
    await tools.listSessions(call({}));
    const keep = keeps[0]!;
    expect(keep({ sessionId: 'sess-k8s', projectId: 'k8s' })).toBe(true);
    expect(keep({ sessionId: 'sess-archived', projectId: 'archived' })).toBe(false);
    expect(keep({ sessionId: 'sess-stopped', projectId: 'stopped' })).toBe(false);
    // A session whose worktree is gone is ineligible for good, and there is one for every
    // session the install ever finished. Dropping those is what keeps the cost of the listing
    // proportional to the sessions still alive — but it is a flag rather than part of `keep`,
    // because answering it costs a stat and `keep` is what decides whether to pay for one.
    expect(requireResumables[0]).toBe(true);

    // Under `activeOnly: false` those sessions are the point of the call, so they are kept.
    await tools.listSessions(call({ activeOnly: false }));
    expect(keeps[1]!({ sessionId: 'sess-archived', projectId: 'archived' })).toBe(true);
    expect(keeps[1]!({ sessionId: 'sess-stopped', projectId: 'stopped' })).toBe(true);
    expect(requireResumables[1]).toBe(false);

    // And a handoff never narrows on eligibility: an unresumable target has to be found so
    // the caller is told why it cannot receive a briefing, not that it does not exist.
    await tools
      .handoff(call({ target: { sessionId: 'sess-gone' }, title: 't', briefing: 'b' }))
      .catch(() => undefined);
    expect(keeps[2]!({ sessionId: 'sess-gone', projectId: 'website' })).toBe(true);
    expect(requireResumables[2]).toBe(false);
  });

  it('caps the listing and reports what it left out, but never caps a handoff', async () => {
    // The cap is the only bound on the listing's total cost and total size — everything else
    // in the prefilter bounds how fast those grow. It is passed down rather than applied to
    // the answer, because the point is to not project the sessions it drops.
    const { tools, call, limits } = harness({ omitted: 7 });
    const listed = await tools.listSessions(call({}));
    expect(limits[0]).toBe(LIST_SESSIONS_MAX_ENTRIES);
    // Relayed, so the caller can tell a nine-session fleet from a truncated view of a large
    // one and narrow with `project` instead of concluding the session is gone.
    expect(listed.omitted).toBe(7);

    // Uncapped both ways round. A cap on the project path could hide the second eligible
    // session in a project, which is exactly the case the handoff refuses rather than guesses
    // — it would turn that refusal into a confident delivery to the wrong session.
    await tools.handoff(call({ target: { sessionId: 'sess-web' }, title: 't', briefing: 'b' }));
    await tools.handoff(call({ target: { project: 'k8s' }, title: 't', briefing: 'b' }));
    expect(limits.slice(1)).toEqual([undefined, undefined]);
  });

  it('narrows the prefilter to what the call already asked for', async () => {
    // Without this a handoff at one session would still project the whole fleet — one event
    // log per session — to find it.
    const { tools, call, keeps } = harness();
    await tools.listSessions(call({ project: 'k8s' }));
    expect(keeps[0]!({ sessionId: 'sess-k8s', projectId: 'k8s' })).toBe(true);
    expect(keeps[0]!({ sessionId: 'sess-web', projectId: 'website' })).toBe(false);

    await tools.handoff(call({ target: { sessionId: 'sess-web' }, title: 't', briefing: 'b' }));
    expect(keeps[1]!({ sessionId: 'sess-web', projectId: 'website' })).toBe(true);
    expect(keeps[1]!({ sessionId: 'sess-k8s', projectId: 'k8s' })).toBe(false);

    await tools.handoff(call({ target: { project: 'k8s' }, title: 't', briefing: 'b' }));
    expect(keeps[2]!({ sessionId: 'sess-k8s', projectId: 'k8s' })).toBe(true);
    expect(keeps[2]!({ sessionId: 'sess-web', projectId: 'website' })).toBe(false);
  });

  it('carries metadata only — no transcript, prompt or file field can reach the caller', async () => {
    // A summary that has grown extra fields must not leak them: the entry is built field by
    // field, so anything not named in `ControlPlaneSessionEntry` is dropped at the boundary.
    const leaky = {
      ...facts({ sessionId: 'sess-k8s' }),
      // `name` is on the summary the route reads from, and is left off deliberately: an
      // unnamed session is auto-titled by its own model from the first prompt.
      name: 'fix the checkout crash for ACME',
      lastMessage: 'the operator said something private',
      worktree: '/work/.verity-sessions/agent-1',
      events: [{ type: 'text', text: 'secret' }],
    } as ControlPlaneSessionFacts;
    // A blocked session alongside it, because `handoffBlockedBy` is only present on one:
    // the union over both entries is the full set of fields the listing can ever carry.
    const blocked = facts({ sessionId: 'sess-blocked', resumable: false });
    const { tools, call } = harness({ sessions: [leaky, blocked] });
    const { sessions } = await tools.listSessions(call({ activeOnly: false }));
    // Asserted against `LIST_SESSIONS_FIELDS` rather than a list written out here. That array
    // is what the tool description tells the calling model it will get and what the approval
    // card tells the operator is being read; a field added to the entry but not to it would
    // leave both of those statements quietly understating what the listing carries.
    //
    // Twice, because the two directions fail differently. The runtime union catches a key the
    // entry emits that the type does not admit. It cannot catch the opposite: a new OPTIONAL
    // field, declared and populated by `entryFor`, is simply absent from a fixture that does
    // not set it, so the union would not see it and this would pass. The record below is what
    // closes that — `Record<keyof ControlPlaneSessionEntry, true>` stops compiling the moment
    // a field is added to the type, which forces it into this list, which then has to appear
    // in `LIST_SESSIONS_FIELDS` for the assertion to hold.
    const declared: Record<keyof ControlPlaneSessionEntry, true> = {
      sessionId: true,
      projectId: true,
      project: true,
      model: true,
      status: true,
      eventCount: true,
      lastActivityAt: true,
      resumable: true,
      handoffEligible: true,
      handoffBlockedBy: true,
    };
    const promised = LIST_SESSIONS_FIELDS.map((field) => field.key)
      .slice()
      .sort();
    expect(Object.keys(declared).sort()).toEqual(promised);
    expect([...new Set(sessions.flatMap((entry) => Object.keys(entry)))].sort()).toEqual(promised);
    expect(JSON.stringify(sessions)).not.toContain('private');
    expect(JSON.stringify(sessions)).not.toContain('ACME');
    expect(JSON.stringify(sessions)).not.toContain('.verity-sessions');
  });

  it('narrows to one project and resolves the reference by id, repo or owner/repo', async () => {
    const { tools, call } = harness();
    for (const reference of ['website', 'acme/website']) {
      const { sessions } = await tools.listSessions(call({ project: reference }));
      expect(sessions.map((s) => s.sessionId)).toEqual(['sess-web']);
    }
    await expect(tools.listSessions(call({ project: 'nope' }))).rejects.toThrow(
      'project reference nope does not resolve to one Verity project',
    );
  });

  it('refuses an ambiguous reference rather than preferring one of the matches', async () => {
    // The half of the card's promise that the no-match case cannot check. `sessionHandoffCaveats`
    // tells the operator the name "must match exactly one project … or the call fails rather than
    // choosing", and a resolver that broke the tie by owner order, or by preferring an id match
    // over a repo match, would still satisfy every no-match assertion while delivering a briefing
    // to a fleet the operator never named. Both tools are asserted because both make the promise.
    const shared = [
      project({ id: 'acme-site', owner: 'acme', repo: 'website' }),
      project({ id: 'globex-site', owner: 'globex', repo: 'website' }),
      project({ id: CONTROL_PROJECT_ID, kind: 'control_plane' }),
    ];
    const { tools, call } = harness({
      projects: shared,
      sessions: [facts({ sessionId: 'a', projectId: 'acme-site' })],
    });
    await expect(tools.listSessions(call({ project: 'website' }))).rejects.toThrow(
      'project reference website does not resolve to one Verity project',
    );
    await expect(
      tools.handoff(call({ target: { project: 'website' }, title: 't', briefing: 'b' })),
    ).rejects.toThrow('project reference website does not resolve to one Verity project');
    // The disambiguated form still resolves, so the refusal above is about the ambiguity and
    // not about either project being unreachable.
    await expect(tools.listSessions(call({ project: 'acme/website' }))).resolves.toMatchObject({
      sessions: [{ sessionId: 'a' }],
    });
  });
});

describe('verity_session_handoff', () => {
  it('delivers the briefing wrapped as agent material and reports it ran immediately', async () => {
    const { tools, dispatchTurn, call } = harness();
    await expect(
      tools.handoff(
        call({
          target: { sessionId: 'sess-web' },
          title: 'Overlay for the new site',
          briefing: 'Digest sha256:abc, port 8080, read-only rootfs.',
        }),
      ),
    ).resolves.toEqual({
      sessionId: 'sess-web',
      project: 'acme/website',
      queued: false,
      briefingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const prompt = dispatchTurn.mock.calls[0]![0].prompt;
    // Nothing the caller wrote precedes the envelope — not the briefing and not the title,
    // which is caller-controlled text too and would otherwise get to frame the framing.
    expect(prompt.startsWith(SESSION_HANDOFF_ENVELOPE)).toBe(true);
    expect(prompt).toContain('Title: Overlay for the new site');
    expect(prompt).toContain('Digest sha256:abc, port 8080, read-only rootfs.');
    expect(prompt.indexOf('Title: Overlay')).toBeLessThan(prompt.indexOf('Digest'));

    // The transcript gets the same three parts under a label a person reads, so the target
    // session's history does not show this as a turn the operator typed.
    const displayPrompt = dispatchTurn.mock.calls[0]![0].displayPrompt;
    expect(displayPrompt.startsWith(SESSION_HANDOFF_TRANSCRIPT_LABEL)).toBe(true);
    expect(displayPrompt).not.toContain(SESSION_HANDOFF_ENVELOPE);
    expect(displayPrompt).toContain('Title: Overlay for the new site');
    expect(displayPrompt).toContain('Digest sha256:abc, port 8080, read-only rootfs.');

    // The gateway's per-invocation key, namespaced by the calling turn, is handed to the
    // conductor as the idempotency key: a retried gateway call — same JSON-RPC id, same
    // request MAC, fresh callId — is memoized into the first delivery rather than dispatched
    // a second time, while a deliberate repeat from a later turn still gets through.
    expect(dispatchTurn.mock.calls[0]![0].idempotencyKey).toBe('handoff:turn-1:invocation-1');
  });

  it('queues behind an in-flight turn instead of failing, and says so', async () => {
    const { tools, call } = harness({ dispatchTurn: async () => ({ queued: true }) });
    await expect(
      tools.handoff(call({ target: { sessionId: 'sess-k8s' }, title: 't', briefing: 'b' })),
    ).resolves.toMatchObject({ sessionId: 'sess-k8s', queued: true });
  });

  it('creates the explicitly selected new session and delivers the briefing as its first turn', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'sess-created' }));
    const { tools, dispatchTurn, call } = harness({ createSession });
    await expect(
      tools.handoff(
        call({
          target: { newSession: { project: 'acme/website' } },
          title: 'Investigate worker failure',
          briefing: 'Reproduce EACCES and add a bounded repair.',
        }),
      ),
    ).resolves.toMatchObject({ sessionId: 'sess-created', project: 'acme/website' });
    expect(createSession).toHaveBeenCalledWith({
      projectId: 'website',
      name: 'Investigate worker failure',
      idempotencyKey: 'handoff-session:turn-1:invocation-1',
    });
    expect(dispatchTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-created' }),
    );
  });

  it('rejects an unknown, Control, unresumable or not-active target with distinct messages', async () => {
    const { tools, dispatchTurn, call } = harness();
    const handoff = (sessionId: string) =>
      tools.handoff(call({ target: { sessionId }, title: 't', briefing: 'b' }));

    await expect(handoff('sess-nope')).rejects.toThrow(
      'does not exist or is not a Verity project session',
    );
    await expect(handoff('sess-control')).rejects.toThrow(
      'does not exist or is not a Verity project session',
    );
    await expect(handoff('sess-hidden')).rejects.toThrow(
      'does not exist or is not a Verity project session',
    );
    await expect(handoff('sess-archived')).rejects.toThrow('project archived is archived');
    await expect(handoff('sess-gone')).rejects.toThrow('cannot be resumed');
    await expect(handoff('sess-stopped')).rejects.toThrow(
      'project stopped sandbox is not active (container_starting) — repair it and retry',
    );
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('resolves a project target to its single eligible session, and errors otherwise', async () => {
    const { tools, call } = harness();
    await expect(
      tools.handoff(call({ target: { project: 'website' }, title: 't', briefing: 'b' })),
    ).resolves.toMatchObject({ sessionId: 'sess-web' });

    await expect(
      tools.handoff(call({ target: { project: CONTROL_PROJECT_ID }, title: 't', briefing: 'b' })),
    ).rejects.toThrow('cannot target a Verity Control session');

    // A live project whose only session lost its worktree. This is the case the "open one,
    // then target it by sessionId" advice is actually true of — a blocked project is refused
    // by name before the search, because opening a session there would not help either.
    const deadSessions = harness({
      sessions: [facts({ sessionId: 'only', projectId: 'k8s', resumable: false })],
    });
    await expect(
      deadSessions.tools.handoff(
        deadSessions.call({ target: { project: 'k8s' }, title: 't', briefing: 'b' }),
      ),
    ).rejects.toThrow('has no session that can receive a handoff');

    const twoSessions = harness({
      sessions: [facts({ sessionId: 'a' }), facts({ sessionId: 'b' })],
    });
    await expect(
      twoSessions.tools.handoff(
        twoSessions.call({ target: { project: 'k8s' }, title: 't', briefing: 'b' }),
      ),
    ).rejects.toThrow('call verity_list_sessions and target one by sessionId');
  });

  it('accepts exactly the sessions the listing reports as eligible', async () => {
    // The one invariant that keeps the two tools from drifting apart: drive both against the
    // same fixture and require the accepted set to equal the advertised set.
    const { tools, call } = harness();
    const { sessions } = await tools.listSessions(call({ activeOnly: false }));
    const accepted: string[] = [];
    for (const session of sessions) {
      const attempt = await tools
        .handoff(call({ target: { sessionId: session.sessionId }, title: 't', briefing: 'b' }))
        .then(() => true)
        .catch(() => false);
      if (attempt) accepted.push(session.sessionId);
    }
    expect(accepted).toEqual(sessions.filter((s) => s.handoffEligible).map((s) => s.sessionId));
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('rejects a briefing that is empty or beyond the card-readable limit', async () => {
    const { tools, call } = harness();
    await expect(
      tools.handoff(call({ target: { sessionId: 'sess-web' }, title: 't', briefing: '   ' })),
    ).rejects.toThrow();
    await expect(
      tools.handoff(
        call({ target: { sessionId: 'sess-web' }, title: 't', briefing: 'x'.repeat(20_001) }),
      ),
    ).rejects.toThrow();
  });
});

describe('Control Plane session observation', () => {
  it('reads structured progress for one exact authorized target', async () => {
    const readProgress = vi.fn(async () => ({ lifecycle: 'running', publishedSummary: null }));
    const { tools, call } = harness({ readProgress });
    await expect(tools.progress(call({ sessionId: 'sess-web' }))).resolves.toMatchObject({
      sessionId: 'sess-web',
      projectId: 'website',
      lifecycle: 'running',
    });
    expect(readProgress).toHaveBeenCalledWith('sess-web');
  });

  it('requires purpose and enforces the bounded default for recent messages', async () => {
    const readRecentMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
    const { tools, call } = harness({ readRecentMessages });
    await expect(
      tools.recentMessages(call({ sessionId: 'sess-web', purpose: 'Check handoff status' })),
    ).resolves.toMatchObject({ sessionId: 'sess-web', count: 20, purpose: 'Check handoff status' });
    expect(readRecentMessages).toHaveBeenCalledWith({ sessionId: 'sess-web', count: 20 });
    await expect(tools.recentMessages(call({ sessionId: 'sess-web' }))).rejects.toThrow();
    await expect(
      tools.recentMessages(call({ sessionId: 'sess-web', purpose: 'Too broad', count: 51 })),
    ).rejects.toThrow();
  });
});
