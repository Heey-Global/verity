import type { EventStore, ProjectRecord } from '@verity/store';
import type { ContainerEventSource } from './docker-container-events.js';
import { DockerError, type DockerClient } from './docker.js';
import type { ProvisionerImpl } from './provisioner.js';
import { reconcileProjectContainerStates } from './project-state.js';

/** All projects are compared with their containers this often, for whatever
 * the event stream missed. */
const FULL_RECONCILE_MS = 5 * 60_000;
/** Projects in a transition are compared this often: a provisioning that hangs
 * or a sleep or wake that was interrupted produces no Docker event. */
const TRANSITION_RECONCILE_MS = 60_000;
const TRANSITIONS = new Set(['cloning', 'container_starting', 'sleeping_starting', 'waking']);

export interface ContainerLiveness {
  /** Compare the projects with their containers now, writing what changed. */
  reconcile(projects: ProjectRecord[]): Promise<ProjectRecord[]>;
  /** Whether Docker's event stream is open and a full comparison after it
   * opened has succeeded: only then does the store hold what a read would
   * find by inspecting the containers. */
  following(): boolean;
  /** Follow the event stream and run the periodic comparisons until every
   * caller that started it has stopped. */
  start(): () => Promise<void>;
  /** Called after a comparison wrote a project's state, for caches of rows;
   * returns the call that removes the listener. */
  onStateWritten(listener: () => void): () => void;
}

/**
 * Keeps each project's state in step with its sandbox container (ADR 0033).
 *
 * A container that stops, dies, restarts or is paused outside Verity used to
 * be noticed only by a read, which inspected every project's container on
 * every overview and detail request. Docker's event stream now reports it at
 * once: the affected project is compared with its container through the same
 * reconciliation the reads used, which writes the new state and so publishes
 * `sandbox.lifecycle`. Reads skip their inspection while the stream is open.
 *
 * After each (re)connect every project is compared, since events from before
 * the stream opened are not replayed. Every five minutes all projects are
 * compared again, and every minute those in a transition, which a timeout
 * rather than an event ends.
 */
export function createContainerLiveness(options: {
  eventStore: Pick<EventStore, 'getProject' | 'listProjects' | 'updateProjectState'>;
  docker: DockerClient & Partial<ContainerEventSource>;
  provisioner:
    | Partial<
        Pick<
          ProvisionerImpl,
          'isProjectProvisioning' | 'recoverInterruptedSleep' | 'recoverInterruptedWake'
        >
      >
    | undefined;
  log: { warn(message: string, error?: unknown): void };
  intervals?: { full: number; transitions: number };
}): ContainerLiveness {
  const { eventStore, docker, provisioner, log } = options;
  const written = new Set<() => void>();
  /** The client, noting each container it could not inspect: the comparison
   * keeps the row then, which reads may only rely on while it is current. */
  const noting = (unreadable: Set<string>): DockerClient => ({
    ...docker,
    inspectContainer: async (name: string) => {
      try {
        return await docker.inspectContainer(name);
      } catch (error) {
        if (!(error instanceof DockerError && error.kind === 'container_not_found')) {
          unreadable.add(name);
        }
        throw error;
      }
    },
  });
  /** `unreadable` marks the follower's own comparisons: they note containers
   * Docker could not inspect, and their writes are announced. A read's
   * comparison is its own business, and its caller already holds the rows. */
  const reconcile = (
    projects: ProjectRecord[],
    unreadable?: Set<string>,
  ): Promise<ProjectRecord[]> =>
    reconcileProjectContainerStates(
      projects,
      unreadable === undefined ? docker : noting(unreadable),
      async (id, state, provisionError, provisionWarning) => {
        const row = await eventStore.updateProjectState(
          id,
          state,
          provisionError,
          provisionWarning,
        );
        if (unreadable === undefined) {
          // A read's comparison is not serialized with the follower's: its
          // write may land after a catch-up that did not see it. The rows are
          // no longer known to be current until a full pass after it.
          lose();
          if (open) void sweep();
          return row;
        }
        for (const listener of written) {
          try {
            listener();
          } catch (error) {
            log.warn('verity: a project state listener failed', error);
          }
        }
        return row;
      },
      (id) => provisioner?.isProjectProvisioning?.(id) === true,
      provisioner?.recoverInterruptedSleep?.bind(provisioner),
      provisioner?.recoverInterruptedWake?.bind(provisioner),
    );

  /** The stream is open, though its catch-up comparison may still run. */
  let open = false;
  /** Open and caught up: reads may rely on the rows. */
  let connected = false;
  /** Moves on whenever the rows may have missed something: a (re)connect, a
   * disconnect, an event that could not be compared. Only a full pass that
   * began in the current epoch and succeeded catches up. */
  let epoch = 0;
  let stopped = true;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  };
  const lose = (): void => {
    epoch += 1;
    connected = false;
  };

  // One comparison per project at a time, whether an event or a sweep asked
  // for it, and one more if asked meanwhile: an older inspect never lands
  // after a newer one, and a burst ends in the state the container ended in.
  const pending = new Map<string, { again: boolean; done: Promise<boolean> }>();
  const compare = (projectId: string, row?: ProjectRecord): Promise<boolean> => {
    const running = pending.get(projectId);
    if (running !== undefined) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve(true) };
    pending.set(projectId, entry);
    entry.done = track(
      (async () => {
        let held = row;
        let ok: boolean;
        try {
          do {
            entry.again = false;
            try {
              const project = held ?? (await eventStore.getProject(projectId));
              held = undefined;
              const unreadable = new Set<string>();
              if (project !== undefined && !stopped) await reconcile([project], unreadable);
              ok = unreadable.size === 0;
            } catch (error) {
              log.warn(`verity: could not compare project ${projectId} with its sandbox`, error);
              ok = false;
            }
          } while (entry.again && !stopped);
        } finally {
          pending.delete(projectId);
        }
        return ok;
      })(),
    );
    return entry.done;
  };
  const onEvent = (projectId: string): void => {
    if (stopped) return;
    void compare(projectId).then((ok) => {
      if (ok || stopped) return;
      // The rows no longer hold everything the stream reported: reads compare
      // again until a full pass has caught up.
      lose();
      void sweep();
    });
  };

  // One sweep at a time. A full comparison asked for while another sweep runs
  // is not folded into it, which may be filtered or have read the projects
  // before what it must catch up on: one more full pass follows it.
  let sweeping: Promise<void> | undefined;
  let fullQueued = false;
  const sweep = (only?: (project: ProjectRecord) => boolean): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (sweeping !== undefined) {
      if (only === undefined) fullQueued = true;
      return sweeping;
    }
    sweeping = (async () => {
      let filter = only;
      try {
        do {
          fullQueued = false;
          // A full pass that began in the current epoch with the stream open
          // has caught up on everything before it; only then may reads rely
          // on the rows. A failed one leaves them comparing.
          const catchesUp = filter === undefined && open ? epoch : undefined;
          try {
            const projects = await eventStore.listProjects();
            if (stopped) return;
            const chosen = filter === undefined ? projects : projects.filter(filter);
            const results = await Promise.all(
              chosen.map((project) => compare(project.id, project)),
            );
            if (
              results.every(Boolean) &&
              catchesUp !== undefined &&
              catchesUp === epoch &&
              open &&
              !stopped
            ) {
              connected = true;
            }
          } catch (error) {
            log.warn('verity: could not compare projects with their sandboxes', error);
          }
          filter = undefined;
        } while (fullQueued && !stopped);
      } finally {
        sweeping = undefined;
      }
    })();
    return sweeping;
  };

  /** Start the stream and the periodic comparisons; returns their stop. */
  const run = (): (() => Promise<void>) => {
    stopped = false;
    open = false;
    connected = false;
    epoch += 1;
    const stopStream = docker.followContainerEvents?.({
      onEvent,
      onConnected: () => {
        if (stopped) return;
        open = true;
        lose();
        // Events from before the stream opened are not replayed: reads keep
        // comparing until a full pass after it has compared every project.
        void sweep();
      },
      onDisconnected: (error) => {
        if (stopped) return;
        if (connected) log.warn('verity: Docker event stream ended; reads compare again', error);
        open = false;
        lose();
      },
    });
    const full = setInterval(() => void sweep(), options.intervals?.full ?? FULL_RECONCILE_MS);
    const transitions = setInterval(
      () => void sweep((project) => TRANSITIONS.has(project.state)),
      options.intervals?.transitions ?? TRANSITION_RECONCILE_MS,
    );
    full.unref?.();
    transitions.unref?.();
    return async () => {
      stopped = true;
      clearInterval(full);
      clearInterval(transitions);
      open = false;
      lose();
      await stopStream?.();
      await Promise.all([sweeping, ...inFlight]);
    };
  };

  // Every server that starts the follower holds it until it stops; the stream
  // ends with the last. A start while a stop winds down follows it afresh once
  // the stop is done, rather than reviving or inheriting it.
  let users = 0;
  let running: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;
  const begin = (): void => {
    if (users > 0 && running === undefined && stopping === undefined) running = run();
  };
  return {
    reconcile: (projects) => reconcile(projects),
    following: () => connected,
    onStateWritten: (listener) => {
      written.add(listener);
      return () => {
        written.delete(listener);
      };
    },
    start() {
      users += 1;
      begin();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        users -= 1;
        if (users > 0) return;
        const current = running;
        running = undefined;
        if (current === undefined) {
          await stopping;
          return;
        }
        stopping = current().finally(() => {
          stopping = undefined;
          begin();
        });
        await stopping;
      };
    },
  };
}
