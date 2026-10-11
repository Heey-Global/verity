import type { ProjectRecord, SessionSummary, VerityClient } from '@verity/mobile';
import { useSyncExternalStore } from 'react';
import { subscribeAuthToken } from './authToken';
import { subscribeBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl, subscribeVerityBaseUrl } from './client';
import { loadTaskContextData, saveTaskContextData, taskAccountScope } from './tasksStore';

type Overview = Awaited<ReturnType<VerityClient['listSessionOverview']>>;
type Context = { projects: ProjectRecord[]; sessions: SessionSummary[] };
const empty: Context = { projects: [], sessions: [] };
const listeners = new Set<() => void>();
function publish(): void {
  for (const listener of listeners) listener();
}
function createEntry(scope: string | null) {
  return {
    scope,
    snapshot: empty,
    projects: undefined as Promise<ProjectRecord[]> | undefined,
    sessions: undefined as Promise<Overview> | undefined,
    projectsLoaded: false,
    sessionsLoaded: false,
    restored: false,
    persisted: '',
    writes: Promise.resolve(),
  };
}
let entry = createEntry(null);
function current() {
  const scope = taskAccountScope();
  if (scope !== entry.scope) {
    entry = createEntry(scope);
    publish();
  }
  return entry;
}
function currentClient(client: VerityClient): boolean {
  return typeof client.liveBaseUrl !== 'function' || client.liveBaseUrl() === getVerityBaseUrl();
}
function retain<T>(previous: T[], next: T[]): T[] {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
function install(target: typeof entry, patch: Partial<Context>): void {
  if (current() !== target || target.scope === null) return;
  const projects = patch.projects
    ? retain(target.snapshot.projects, patch.projects)
    : target.snapshot.projects;
  const sessions = patch.sessions
    ? retain(target.snapshot.sessions, patch.sessions)
    : target.snapshot.sessions;
  if (projects !== target.snapshot.projects || sessions !== target.snapshot.sessions) {
    target.snapshot = { projects, sessions };
    publish();
  }
  if (!target.projectsLoaded || !target.sessionsLoaded) return;
  const snapshot = target.snapshot;
  const serialized = JSON.stringify(snapshot);
  target.writes = target.writes
    .then(async () => {
      if (current() !== target || serialized === target.persisted) return;
      await saveTaskContextData(snapshot, target.scope!);
      target.persisted = serialized;
    })
    .catch(() => undefined);
}

/** Capture joins pending overview reads. Overview refreshes must supersede reads
 * that may predate a mutation, rather than accepting their stale result. */
export function readContextProjects(client: VerityClient, fresh = false): Promise<ProjectRecord[]> {
  const target = current();
  if (target.scope === null || !currentClient(client)) return client.listProjects();
  if (target.projects && !fresh) return target.projects;
  const request = client
    .listProjects()
    .then((projects) => {
      if (target.projects === request) {
        target.projectsLoaded = true;
        install(target, { projects });
      }
      return projects;
    })
    .finally(() => {
      if (target.projects === request) target.projects = undefined;
    });
  target.projects = request;
  return request;
}
function readContextOverview(client: VerityClient, fresh = false): Promise<Overview> {
  const read = () =>
    typeof client.listSessionOverview === 'function'
      ? client.listSessionOverview()
      : client
          .listSessions()
          .then((sessions) => ({ sessions, attention: [], sessionReordering: false }));
  const target = current();
  if (target.scope === null || !currentClient(client)) return read();
  if (target.sessions && !fresh) return target.sessions;
  const request = read()
    .then((overview) => {
      if (target.sessions === request) {
        target.sessionsLoaded = true;
        install(target, { sessions: overview.sessions });
      }
      return overview;
    })
    .finally(() => {
      if (target.sessions === request) target.sessions = undefined;
    });
  target.sessions = request;
  return request;
}

/** The overview's model keeps all writes; only its context reads are shared. */
export function contextOverviewClient(client: VerityClient): VerityClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'listSessionOverview') return () => readContextOverview(client, true);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export async function refreshTaskContext(): Promise<void> {
  if (!taskAccountScope()) return;
  const client = createVerityClient();
  if (!client) return;
  await Promise.all([readContextProjects(client), readContextOverview(client)]);
}
export function startTaskContext(): () => void {
  const restore = () => {
    const target = current();
    if (!target.scope || target.restored) return;
    target.restored = true;
    void loadTaskContextData()
      .then((cached) => {
        if (!cached || current() !== target) return;
        // Network results can beat storage on startup; never replace them with disk data.
        target.persisted = JSON.stringify(cached);
        install(target, {
          ...(!target.projectsLoaded ? { projects: cached.projects } : {}),
          ...(!target.sessionsLoaded ? { sessions: cached.sessions } : {}),
        });
      })
      .catch(() => undefined);
  };
  const detach = [
    subscribeVerityBaseUrl(restore),
    subscribeAuthToken(restore),
    subscribeBrowserSession(restore),
  ];
  restore();
  return () => detach.forEach((stop) => stop());
}
export function useTaskContext(): Context {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => (taskAccountScope() === entry.scope ? entry.snapshot : empty),
    () => empty,
  );
}
