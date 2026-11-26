import type { DomainEvent } from '@verity/events';
import type { ProjectRecord, SessionSummary } from '../api.js';
import { sameSnapshotValue } from '../snapshotIdentity.js';
import { applyOverviewEvent, keptWithout, RevisionGate } from './overviewEvents.js';
import { projectEventUpdate } from './projectEvents.js';

/** A list read the store was told about before it started. */
export interface OverviewRead {
  readonly seq: number;
}

/**
 * Which entities a list read speaks for: entities it covers and does not
 * return are gone. Reads may overlap (all sessions, one project's sessions);
 * for every entity the newest read that spoke for it wins.
 */
export interface OverviewReadScope<T> {
  covers(entity: T): boolean;
}

/** What an event asks of the views that hold its entity. */
export interface OverviewEventOutcome {
  /** The event was new and the store holds its result. */
  readonly applied: boolean;
  /** The event announced something only a read carries; views showing the
   * session or project named here should read again. */
  readonly reload?: { readonly sessionId?: string; readonly projectId?: string };
}

/** Events kept for reads still on their way; bounded like the lists before. */
const MAX_KEPT_EVENTS = 256;

/**
 * One copy of the sessions and projects the app shows (ADR 0033), shared by
 * Home, the project page with its settings routes and the session screen, so
 * an event or an action changes every view in the same render.
 *
 * Reads carry no revisions. A read the store was told about with
 * {@link beginRead} replaces the entities it covers; every event that arrived
 * after the read started is then applied again on top, so a read that answers
 * late never brings back a state an event already replaced. Events pass one
 * revision gate, which a topic resync resets: after it the next read decides.
 *
 * Entities keep their identity until their content changes, so memoized rows
 * do not render again for an unchanged read.
 */
export class OverviewStore {
  private readonly sessionMap = new Map<string, SessionSummary>();
  private readonly projectMap = new Map<string, ProjectRecord>();
  /** Absent when the caller gates events itself (one gate per topic). */
  private readonly gate: RevisionGate | undefined;
  private clock = 0;
  private readonly openReads = new Set<number>();
  private kept: { event: DomainEvent; at: number }[] = [];
  /** The newest kept event dropped past the bound; reads started before it
   * cannot be completed and are ignored. */
  private lostAt = 0;
  /** The newest read that spoke for each entity, gone ones included, while
   * any read is open. */
  private readonly readAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private sessionList: SessionSummary[] | undefined;
  private projectList: ProjectRecord[] | undefined;
  /** Which kinds changed since listeners were last told, so the other list
   * keeps its identity. */
  private readonly dirty = { s: false, p: false };

  /** `gated: false` leaves revision checks to the caller, which must then
   * pass each event once per revision between its own resyncs. */
  constructor(options: { readonly gated?: boolean } = {}) {
    this.gate = options.gated === false ? undefined : new RevisionGate();
  }

  /** Note a list read about to start; pass the result to its `apply…`. */
  beginRead(): OverviewRead {
    const seq = ++this.clock;
    this.openReads.add(seq);
    return { seq };
  }

  /** A read that failed or was abandoned no longer needs kept events. */
  endRead(read: OverviewRead): void {
    this.openReads.delete(read.seq);
    this.prune();
  }

  /** Apply a session list read. Entities a newer read already spoke for keep
   * that read's state. False when the read cannot be applied any more (it
   * ended, or events it would need replayed were dropped): read again. */
  applySessions(
    read: OverviewRead,
    sessions: readonly SessionSummary[],
    scope: OverviewReadScope<SessionSummary>,
  ): boolean {
    return this.applySnapshot(read, () =>
      this.replaceCovered(read, 's', this.sessionMap, sessions, (s) => s.sessionId, scope),
    );
  }

  /** Apply a project read, of the list or of one project; returns like
   * {@link applySessions}. */
  applyProjects(
    read: OverviewRead,
    projects: readonly ProjectRecord[],
    scope: OverviewReadScope<ProjectRecord>,
  ): boolean {
    return this.applySnapshot(read, () =>
      this.replaceCovered(read, 'p', this.projectMap, projects, (p) => p.id, scope),
    );
  }

  /** Apply a domain event from the live connection. */
  applyEvent(event: DomainEvent): OverviewEventOutcome {
    if (this.gate !== undefined && !this.gate.accept(event)) return { applied: false };
    const at = ++this.clock;
    const { changed, reload } = this.applyToEntities(event);
    // Only a read already on its way can still answer with an older state.
    if (this.openReads.size > 0) {
      const kept = [...keptWithout(this.kept, event), { event, at }];
      if (kept.length > MAX_KEPT_EVENTS) this.lostAt = kept[kept.length - MAX_KEPT_EVENTS - 1]!.at;
      this.kept = kept.slice(-MAX_KEPT_EVENTS);
    }
    if (changed) this.changed();
    return reload === undefined ? { applied: true } : { applied: true, reload };
  }

  /** Events were missed: every later revision applies again, and views read
   * their snapshots. */
  resync(): void {
    this.gate?.reset();
  }

  session(sessionId: string): SessionSummary | undefined {
    return this.sessionMap.get(sessionId);
  }

  project(projectId: string): ProjectRecord | undefined {
    return this.projectMap.get(projectId);
  }

  /** Every session held, the same array until one changes. */
  sessions(): readonly SessionSummary[] {
    this.sessionList ??= [...this.sessionMap.values()];
    return this.sessionList;
  }

  /** Every project held, the same array until one changes. */
  projects(): readonly ProjectRecord[] {
    this.projectList ??= [...this.projectMap.values()];
    return this.projectList;
  }

  /** For `useSyncExternalStore`: changes whenever an entity does. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** False when the read was ignored and the caller should read again. */
  private applySnapshot(read: OverviewRead, replace: () => boolean): boolean {
    // A read that ended (failed, abandoned or already applied) has no kept
    // events any more; its answer could only bring back an older state.
    if (!this.openReads.delete(read.seq)) return false;
    // Events this read missed were dropped, so its answer cannot be brought
    // up to date; the next read speaks instead.
    if (read.seq < this.lostAt) {
      this.prune();
      return false;
    }
    let changed = replace();
    for (const { event, at } of this.kept) {
      // A newer read that started after the event already shows it, and
      // possibly a later state no event announced.
      const key = readKey(event);
      const spokenAt = key === undefined ? 0 : (this.readAt.get(key) ?? 0);
      if (at > Math.max(read.seq, spokenAt) && this.applyToEntities(event).changed) changed = true;
    }
    this.prune();
    if (changed) this.changed();
    return true;
  }

  /** Replace what `scope` covers with `next`, keeping unchanged entities and
   * those a newer read already spoke for. */
  private replaceCovered<T>(
    read: OverviewRead,
    kind: 's' | 'p',
    map: Map<string, T>,
    next: readonly T[],
    id: (entity: T) => string,
    scope: OverviewReadScope<T>,
  ): boolean {
    const newer = (key: string) => (this.readAt.get(`${kind}:${key}`) ?? 0) > read.seq;
    const spokeFor = (key: string) => this.readAt.set(`${kind}:${key}`, read.seq);
    let changed = false;
    const returned = new Set<string>();
    for (const entity of next) {
      const key = id(entity);
      returned.add(key);
      if (newer(key)) continue;
      spokeFor(key);
      const held = map.get(key);
      if (held !== undefined && sameSnapshotValue(held, entity)) continue;
      map.set(key, entity);
      this.dirty[kind] = true;
      changed = true;
    }
    for (const [key, held] of map) {
      if (returned.has(key) || !scope.covers(held) || newer(key)) continue;
      spokeFor(key);
      map.delete(key);
      this.dirty[kind] = true;
      changed = true;
    }
    return changed;
  }

  private applyToEntities(event: DomainEvent): {
    changed: boolean;
    reload?: OverviewEventOutcome['reload'];
  } {
    const update = projectEventUpdate(event);
    if (update !== undefined) {
      const project = this.projectMap.get(update.projectId);
      const next = project === undefined ? undefined : update.patch(project);
      const changed = next !== undefined && next !== project;
      if (changed) {
        this.projectMap.set(update.projectId, next);
        this.dirty.p = true;
      }
      return update.reload ? { changed, reload: { projectId: update.projectId } } : { changed };
    }
    if (!('sessionId' in event)) return { changed: false };
    const session = this.sessionMap.get(event.sessionId);
    const effect = applyOverviewEvent(session === undefined ? [] : [session], event);
    if (effect.kind === 'local') {
      const next = effect.sessions[0];
      if (next === undefined || (session !== undefined && sameSnapshotValue(session, next)))
        return { changed: false };
      this.sessionMap.set(event.sessionId, next);
      this.dirty.s = true;
      return { changed: true };
    }
    // A new request or question is announced for any session, held or not:
    // only the read shows it.
    if (effect.kind === 'reload') {
      return { changed: false, reload: { sessionId: event.sessionId } };
    }
    return { changed: false };
  }

  private prune(): void {
    if (this.openReads.size === 0) {
      // Every later read is newer than anything recorded, so neither the kept
      // events nor which read spoke for an entity can matter any more.
      this.kept = [];
      this.readAt.clear();
      this.lostAt = 0;
      return;
    }
    const oldest = Math.min(...this.openReads);
    this.kept = this.kept.filter(({ at }) => at > oldest);
  }

  private changed(): void {
    this.version += 1;
    if (this.dirty.s) this.sessionList = undefined;
    if (this.dirty.p) this.projectList = undefined;
    this.dirty.s = false;
    this.dirty.p = false;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The `readAt` key of the entity an event changes. */
function readKey(event: DomainEvent): string | undefined {
  const update = projectEventUpdate(event);
  if (update !== undefined) return `p:${update.projectId}`;
  return 'sessionId' in event ? `s:${event.sessionId}` : undefined;
}
