import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectChangeFeed, type ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxUpdateChecker, SandboxUpdateStatus } from '../sandbox-updates.js';
import type { ServerContext } from '../server-context.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import { installProjectEvents } from './project-events.js';

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    state: 'cloning',
    provisionError: null,
    provisionWarning: null,
    setupStatus: null,
    imageRef: null,
    toolkitIdentity: null,
    ...overrides,
  } as ProjectRecord;
}

function status(state: SandboxUpdateStatus['state']): SandboxUpdateStatus {
  return { state } as SandboxUpdateStatus;
}

function setup() {
  const projectChanges = new ProjectChangeFeed();
  const rows = new Map<string, ProjectRecord>([['p1', projectRecord()]]);
  const observers = new Set<(projectId: string, status: SandboxUpdateStatus) => void>();
  let nextStatus = status('current');
  const statusCalls = vi.fn(async (project: ProjectRecord) => {
    for (const observer of observers) observer(project.id, nextStatus);
    return nextStatus;
  });
  const sandboxUpdates: SandboxUpdateChecker = {
    status: statusCalls,
    statusAll: async () => new Map(),
    observe: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
  let identity: string | undefined = 'toolkit-a';
  const domainEvents = new DomainEventBus();
  const closers: (() => unknown)[] = [];
  const ctx = {
    deps: {
      eventStore: { projectChanges, getProject: async (id: string) => rows.get(id) },
      sandboxUpdates,
      toolkitIdentity: async () => identity,
    },
    domainEvents,
    lifecycle: { onClose: (stop: () => unknown) => closers.push(stop) },
  } as unknown as ServerContext;
  installProjectEvents({ log: { warn: () => undefined } }, ctx);
  const published: DomainRecord[] = [];
  domainEvents.subscribe('project:p1', undefined, (record) => published.push(record));
  const write = (overrides: Partial<ProjectRecord>) => {
    rows.set('p1', { ...rows.get('p1')!, ...overrides });
    projectChanges.announce('p1');
  };
  const events = () => published.map((record) => record.event);
  return {
    write,
    events,
    statusCalls,
    observers,
    closers,
    setStatus: (next: SandboxUpdateStatus) => (nextStatus = next),
    setIdentity: (next: string | undefined) => (identity = next),
  };
}

describe('installProjectEvents', () => {
  it('publishes each lifecycle change once, with sleep states as the routes show them', async () => {
    const w = setup();
    w.write({ state: 'container_starting' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    // Same state written again (a heartbeat-like rewrite): nothing new.
    w.write({ state: 'container_starting' });
    w.write({ state: 'sleeping' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()).toEqual([
      expect.objectContaining({ t: 'sandbox.lifecycle', state: 'container_starting' }),
      // First sight of the project also states its overview fields.
      expect.objectContaining({ t: 'project.changed', patch: { name: 'P1' } }),
      expect.objectContaining({
        t: 'sandbox.lifecycle',
        state: 'active',
        lifecycleState: 'sleeping',
      }),
    ]);
    const revs = w.events().map((event) => event.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
  });

  it('publishes a failure whose message changed while the state stayed failed', async () => {
    const w = setup();
    w.write({ state: 'failed', provisionError: 'clone failed' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({ state: 'failed', provisionError: 'container stopped' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
  });

  it('publishes renames and setup status as project changes', async () => {
    const w = setup();
    w.write({});
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({ name: 'Renamed' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()[2]).toEqual(
      expect.objectContaining({ t: 'project.changed', patch: { name: 'Renamed' } }),
    );
  });

  it('publishes a new latest release as a project change', async () => {
    const w = setup();
    w.write({});
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({
      latestReleaseTag: 'v2.0.0',
      latestReleaseName: 'Two',
      latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
      latestReleasePublishedAt: '2026-11-26T10:00:00Z',
    });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()[2]).toEqual(
      expect.objectContaining({
        t: 'project.changed',
        patch: {
          latestReleaseTag: 'v2.0.0',
          latestReleaseName: 'Two',
          latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
          latestReleasePublishedAt: '2026-11-26T10:00:00Z',
        },
      }),
    );
  });

  it('publishes toolkit drift when a new image changes the verdict', async () => {
    const w = setup();
    w.write({ state: 'active', imageRef: 'img:1', toolkitIdentity: 'toolkit-a' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    // A project seen for the first time is in every snapshot already.
    expect(w.events().some((event) => 'patch' in event && 'toolkitDrift' in event.patch)).toBe(
      false,
    );
    w.write({ imageRef: 'img:2', toolkitIdentity: 'toolkit-old' });
    await vi.waitFor(() =>
      expect(w.events().at(-1)).toEqual(
        expect.objectContaining({
          t: 'project.changed',
          patch: { toolkitDrift: expect.objectContaining({ verdict: 'drifted' }) },
        }),
      ),
    );
    const count = w.events().length;
    // A sleeping sandbox is not judged; the verdict disappears with it.
    w.write({ state: 'sleeping' });
    await vi.waitFor(() =>
      expect(w.events().slice(count)).toContainEqual(
        expect.objectContaining({ t: 'project.changed', patch: { toolkitDrift: null } }),
      ),
    );
  });

  it('publishes the state a burst of writes ended in', async () => {
    const w = setup();
    w.write({ state: 'cloning' });
    w.write({ state: 'container_starting' });
    w.write({ state: 'failed', provisionError: 'x' });
    await vi.waitFor(() =>
      expect(w.events().at(-1)).toEqual(
        expect.objectContaining({ t: 'sandbox.lifecycle', state: 'failed' }),
      ),
    );
  });

  it('publishes update availability when it flips, from any read of the checker', async () => {
    const w = setup();
    // A sandbox that came up has its update status checked at once.
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.statusCalls).toHaveBeenCalledTimes(1));
    // A read or a reconciler tick later sees a new image.
    for (const observer of w.observers) observer('p1', status('available'));
    for (const observer of w.observers) observer('p1', status('available'));
    // A failed registry read says nothing about the update.
    for (const observer of w.observers) observer('p1', status('unknown'));
    for (const observer of w.observers) observer('p1', status('available'));
    expect(w.events().filter((event) => event.t === 'sandbox.update')).toEqual([
      expect.objectContaining({ t: 'sandbox.update', projectId: 'p1', available: true }),
    ]);
    // The rebuild finished: the new image is recorded and checked again.
    w.setStatus(status('current'));
    w.write({ imageRef: 'image:2' });
    await vi.waitFor(() =>
      expect(w.events().at(-1)).toEqual(
        expect.objectContaining({ t: 'sandbox.update', available: false }),
      ),
    );
  });

  it('stops publishing when the server closes', async () => {
    const w = setup();
    for (const close of w.closers) close();
    w.write({ state: 'active' });
    for (const observer of w.observers) observer('p1', status('available'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.events()).toEqual([]);
  });

  it('installs on a composition whose store has no change feed', () => {
    const ctx = {
      deps: { eventStore: {} },
      domainEvents: new DomainEventBus(),
      lifecycle: { onClose: () => undefined },
    } as unknown as ServerContext;
    expect(() => installProjectEvents({ log: { warn: () => undefined } }, ctx)).not.toThrow();
  });
});

/**
 * Every write of a project's state has to announce the project once it has
 * committed. A writer that does not leaves every live view on the old sandbox
 * state until its next read, and no other test notices.
 */
describe('project state writers', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const sources = ['packages/server/src', 'packages/store/src'].flatMap((dir) =>
    listSources(join(root, dir)).map((file) => ({
      file: relative(root, file),
      text: readFileSync(file, 'utf8'),
    })),
  );

  /** Writers that need no announcement, by file or by file and method, and why. */
  const exempt: Record<string, string> = {
    // Restores a hidden starter project, which views receive as a new entry of
    // the project list rather than as a change of a project they show.
    'packages/store/src/starter-projects.ts ensureReplayStarterProject':
      'restores a hidden project',
    // The in-transaction writer; its callers are checked below.
    'packages/server/src/project-persistence.ts': 'updateProjectStateInTx',
  };

  it('announces every store method that updates a project state', () => {
    const silent: string[] = [];
    for (const { file, text } of sources) {
      for (const method of methodsOf(text)) {
        if (!/updateTable\('projects'\)\s*\.set\(\{[\s\S]*?\bstate\b\s*[,:}]/u.test(method.body)) {
          continue;
        }
        if (`${file} ${method.name}` in exempt || file in exempt) continue;
        if (!/\b(?:changes|projectChanges)\??\.announce\(/u.test(method.body)) {
          silent.push(`${file} ${method.name}`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  // The release and the toolkit identity reach views only as `project.changed`
  // once the read path no longer runs for them; a silent writer would leave a
  // badge or drift banner stale until the next unrelated change.
  it('announces every store method that writes a release or toolkit identity', () => {
    const silent: string[] = [];
    let writers = 0;
    for (const { file, text } of sources) {
      for (const method of methodsOf(text)) {
        if (
          !/updateTable\('projects'\)\s*\.set\(\{[\s\S]*?\b(?:latest_release_tag|toolkit_identity)\s*:/u.test(
            method.body,
          )
        ) {
          continue;
        }
        writers += 1;
        if (!/\b(?:changes|projectChanges)\??\.announce\(/u.test(method.body)) {
          silent.push(`${file} ${method.name}`);
        }
      }
    }
    expect(writers).toBeGreaterThan(1);
    expect(silent).toEqual([]);
  });

  it('writes in-transaction states only under a lock that announces after commit', () => {
    const unannounced: string[] = [];
    let calls = 0;
    for (const { file, text } of sources) {
      if (file.endsWith('project-persistence.ts')) continue;
      for (const call of text.matchAll(/\bupdateProjectStateInTx\(/gu)) {
        calls += 1;
        // The nearest transaction opened before the call must be the lock that
        // announces after commit, not a plain one.
        const before = text.slice(0, call.index);
        const opener = [...before.matchAll(/\bwithProjectWrite\(|\.transaction\(\)/gu)].at(-1);
        if (opener?.[0] !== 'withProjectWrite(') unannounced.push(`${file}:${call.index}`);
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(unannounced).toEqual([]);
  });
});

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Top-level functions and class members, split at their declarations; calls
 * inside a body never start a new part. */
function methodsOf(text: string): { name: string; body: string }[] {
  const starts = [
    ...text.matchAll(
      /^(?:(?:export\s+)?(?:async\s+)?function\s+|\s{2}(?:(?:private|protected|public|static|async)\s+)*)(\w+)(?:<[^>]*>)?\(/gmu,
    ),
  ];
  return starts.map((match, index) => ({
    name: match[1]!,
    body: text.slice(match.index, starts[index + 1]?.index ?? text.length),
  }));
}
