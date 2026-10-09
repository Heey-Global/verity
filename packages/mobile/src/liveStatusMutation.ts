import type {
  DevServer,
  ProjectRecord,
  ServerUpdateStatus,
  SessionAutomation,
  SessionStatus,
} from './api.js';

type ProjectListener = (project: ProjectRecord) => void;
type ServerUpdateListener = (status: ServerUpdateStatus) => void;
type SessionAutomationListener = (sessionId: string, automation: SessionAutomation | null) => void;
export type DevServerStatusMutation = Pick<DevServer, 'id' | 'projectId'> &
  Partial<Pick<DevServer, 'previewSessionId' | 'running'>> & { devServer?: DevServer };
type DevServerListener = (mutation: DevServerStatusMutation) => void;
type SessionStatusListener = (sessionId: string, status: SessionStatus) => void;

const projectListeners = new Set<ProjectListener>();
const serverUpdateListeners = new Set<ServerUpdateListener>();
const sessionAutomationListeners = new Set<SessionAutomationListener>();
const devServerListeners = new Set<DevServerListener>();
const sessionStatusListeners = new Set<SessionStatusListener>();

export function publishProjectStatusMutation(project: ProjectRecord): void {
  for (const listener of projectListeners) listener(project);
}

export function subscribeProjectStatusMutations(listener: ProjectListener): () => void {
  projectListeners.add(listener);
  return () => projectListeners.delete(listener);
}

export function publishServerUpdateStatusMutation(status: ServerUpdateStatus): void {
  for (const listener of serverUpdateListeners) listener(status);
}

export function subscribeServerUpdateStatusMutations(listener: ServerUpdateListener): () => void {
  serverUpdateListeners.add(listener);
  return () => serverUpdateListeners.delete(listener);
}

/** A session's automation changed locally (`null` once deleted), so the
 * overview can update its marker before the next list poll. */
export function publishSessionAutomationMutation(
  sessionId: string,
  automation: SessionAutomation | null,
): void {
  for (const listener of sessionAutomationListeners) listener(sessionId, automation);
}

export function subscribeSessionAutomationMutations(
  listener: SessionAutomationListener,
): () => void {
  sessionAutomationListeners.add(listener);
  return () => sessionAutomationListeners.delete(listener);
}

export function publishDevServerStatusMutation(mutation: DevServerStatusMutation): void {
  for (const listener of devServerListeners) listener(mutation);
}

export function subscribeDevServerStatusMutations(listener: DevServerListener): () => void {
  devServerListeners.add(listener);
  return () => devServerListeners.delete(listener);
}

export function publishSessionStatusMutation(sessionId: string, status: SessionStatus): void {
  for (const listener of sessionStatusListeners) listener(sessionId, status);
}

export function subscribeSessionStatusMutations(listener: SessionStatusListener): () => void {
  sessionStatusListeners.add(listener);
  return () => sessionStatusListeners.delete(listener);
}
