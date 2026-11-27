import type { EventStore, ProjectRecord } from '@verity/store';
import type { ContainerEventSource } from './docker-container-events.js';
import type { DockerClient } from './docker.js';
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
  /** Whether Docker's event stream is open: while it is, the store already
   * holds what a read would find by inspecting the containers. */
  following(): boolean;
  /** Follow the event stream and run the periodic comparisons until stopped. */
  start(): () => Promise<void>;
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
  const reconcile = (projects: ProjectRecord[]): Promise<ProjectRecord[]> =>
    reconcileProjectContainerStates(
      projects,
      docker,
      (id, state, provisionError, provisionWarning) =>
        eventStore.updateProjectState(id, state, provisionError, provisionWarning),
      (id) => provisioner?.isProjectProvisioning?.(id) === true,
      provisioner?.recoverInterruptedSleep?.bind(provisioner),
      provisioner?.recoverInterruptedWake?.bind(provisioner),
    );
  let connected = false;

  // One comparison per project at a time, and one more if an event arrived
  // meanwhile: a burst of events ends in the state the container ended in.
  const pending = new Map<string, { again: boolean }>();
  const reconcileProject = (projectId: string): void => {
    const running = pending.get(projectId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const entry = { again: false };
    pending.set(projectId, entry);
    void (async () => {
      try {
        do {
          entry.again = false;
          const project = await eventStore.getProject(projectId);
          if (project !== undefined) await reconcile([project]);
        } while (entry.again);
      } catch (error) {
        log.warn(`verity: could not compare project ${projectId} with its sandbox`, error);
      } finally {
        pending.delete(projectId);
      }
    })();
  };

  let sweeping: Promise<void> | undefined;
  const sweep = (only?: (project: ProjectRecord) => boolean): Promise<void> =>
    (sweeping ??= (async () => {
      try {
        const projects = await eventStore.listProjects();
        await reconcile(only === undefined ? projects : projects.filter(only));
      } catch (error) {
        log.warn('verity: could not compare projects with their sandboxes', error);
      } finally {
        sweeping = undefined;
      }
    })());

  return {
    reconcile,
    following: () => connected,
    start() {
      const stopStream = docker.followContainerEvents?.({
        onEvent: reconcileProject,
        onConnected: () => {
          connected = true;
          void sweep();
        },
        onDisconnected: (error) => {
          if (connected) log.warn('verity: Docker event stream ended; reads compare again', error);
          connected = false;
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
        clearInterval(full);
        clearInterval(transitions);
        connected = false;
        await stopStream?.();
        await sweeping;
      };
    },
  };
}
