import type {
  AgentLoop,
  DevServer,
  ProjectRecord,
  ServerUpdateStatus,
  SessionStatus,
} from './api.js';

type ProjectListener = (project: ProjectRecord) => void;
type ServerUpdateListener = (status: ServerUpdateStatus) => void;
type AgentLoopListener = (loop: AgentLoop) => void;
export type DevServerStatusMutation = Pick<DevServer, 'id' | 'projectId'> &
  Partial<Pick<DevServer, 'previewSessionId' | 'running'>> & { devServer?: DevServer };
type DevServerListener = (mutation: DevServerStatusMutation) => void;
type IssuesListener = () => void;
type SessionStatusListener = (sessionId: string, status: SessionStatus) => void;

const projectListeners = new Set<ProjectListener>();
const serverUpdateListeners = new Set<ServerUpdateListener>();
const agentLoopListeners = new Set<AgentLoopListener>();
const devServerListeners = new Set<DevServerListener>();
const issuesListeners = new Set<IssuesListener>();
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

export function publishAgentLoopMutation(loop: AgentLoop): void {
  for (const listener of agentLoopListeners) listener(loop);
}

export function subscribeAgentLoopMutations(listener: AgentLoopListener): () => void {
  agentLoopListeners.add(listener);
  return () => agentLoopListeners.delete(listener);
}

export function publishDevServerStatusMutation(mutation: DevServerStatusMutation): void {
  for (const listener of devServerListeners) listener(mutation);
}

export function subscribeDevServerStatusMutations(listener: DevServerListener): () => void {
  devServerListeners.add(listener);
  return () => devServerListeners.delete(listener);
}

export function publishIssuesChanged(): void {
  for (const listener of issuesListeners) listener();
}

export function subscribeIssuesChanged(listener: IssuesListener): () => void {
  issuesListeners.add(listener);
  return () => issuesListeners.delete(listener);
}

export function publishSessionStatusMutation(sessionId: string, status: SessionStatus): void {
  for (const listener of sessionStatusListeners) listener(sessionId, status);
}

export function subscribeSessionStatusMutations(listener: SessionStatusListener): () => void {
  sessionStatusListeners.add(listener);
  return () => sessionStatusListeners.delete(listener);
}
