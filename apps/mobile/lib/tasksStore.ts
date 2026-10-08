import Storage from 'expo-sqlite/kv-store';
import {
  TaskQueue,
  projectRecordSchema,
  sessionSummarySchema,
  type ProjectRecord,
  type SessionSummary,
  type Task,
  type TaskCapture,
  type TaskPatch,
  type TaskQueueState,
} from '@verity/mobile';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { getAuthToken, getAuthTokenId, subscribeAuthToken } from './authToken';
import { getBrowserSession, subscribeBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl, subscribeVerityBaseUrl } from './client';

const empty: TaskQueueState = { tasks: [], pending: [], conflicts: [] };
let state = empty;
let scope: string | null = null;
let queue: TaskQueue | null = null;
let ready: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
function publish(next: TaskQueueState): void {
  state = next;
  for (const listener of listeners) listener();
}
export function taskAccountScope(): string | null {
  const url = getVerityBaseUrl();
  const token =
    Platform.OS === 'web'
      ? getBrowserSession()?.tokenId
      : getAuthToken(url)
        ? getAuthTokenId(url)
        : null;
  return url && token ? JSON.stringify([url, token]) : null;
}
function switchScope(): void {
  const next = taskAccountScope();
  if (next === scope) return;
  scope = next;
  queue = null;
  publish(empty);
  const api = createVerityClient();
  if (!next || !api) return;
  const instance: TaskQueue = new TaskQueue({
    api,
    active: () => taskAccountScope() === next && queue === instance,
    load: () => Storage.getItem(`verity.tasks.v1.${next}`),
    persist: (data) => Storage.setItem(`verity.tasks.v1.${next}`, data),
    changed: publish,
  });
  queue = instance;
  ready = instance.restore();
  void ready.then(() => instance.sync()).catch(() => undefined);
}
export function startTasksStore(): () => void {
  const unsub = [
    subscribeVerityBaseUrl(switchScope),
    subscribeAuthToken(switchScope),
    subscribeBrowserSession(switchScope),
  ];
  switchScope();
  return () => {
    for (const stop of unsub) stop();
  };
}
export function useTasks(): TaskQueueState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => empty,
  );
}
export async function refreshTasks(force = false): Promise<void> {
  switchScope();
  await ready;
  await queue?.sync(force);
}
/** `id` and `createdAt` come from captures made elsewhere (the Apple Watch). The
 *  stable id makes a repeated hand-over a no-op while the task is still in the
 *  local queue, and the server answers a PUT for an existing id with that task.
 *  In that case the returned task is the one built here, not the stored row. */
export async function captureTask(
  body: TaskCapture,
  origin: { id?: string; createdAt?: string } = {},
): Promise<Task> {
  switchScope();
  const startedScope = scope;
  await ready;
  if (scope !== startedScope) throw new Error('Your connection changed; reopen Tasks');
  if (!queue) throw new Error('Sign in to save tasks');
  const now = new Date().toISOString();
  const task: Task = {
    id: origin.id ?? randomUUID(),
    title: body.title,
    projectId: body.projectId,
    sourceSessionId: body.sourceSessionId ?? null,
    detail: body.detail ?? null,
    sessionId: null,
    origin: 'user',
    attachments: (body.uploads ?? []).map((upload, index) => ({
      hash: `local-${index}`,
      filename: upload.kind === 'file' ? upload.fileName : `image-${index + 1}`,
      mimeType: upload.mediaType,
    })),
    status: 'open',
    result: null,
    sort: 0,
    revision: 0,
    createdAt: origin.createdAt ?? now,
    updatedAt: now,
    completedAt: null,
  };
  await queue.create(task, body);
  void queue.sync().catch(() => undefined);
  return task;
}
export async function patchTask(
  task: Task,
  patch: Omit<TaskPatch, 'expectedRevision'>,
): Promise<void> {
  const startedScope = scope;
  await ready;
  if (scope !== startedScope) throw new Error('Your connection changed; reopen Tasks');
  if (!queue) throw new Error('Sign in to edit tasks');
  await queue.patch(task.id, { ...patch, expectedRevision: task.revision });
  void queue.sync().catch(() => undefined);
}
export async function removeTask(id: string): Promise<void> {
  const startedScope = scope;
  await ready;
  if (scope !== startedScope) throw new Error('Your connection changed; reopen Tasks');
  if (!queue) throw new Error('Sign in to delete tasks');
  await queue.delete(id);
  void queue.sync().catch(() => undefined);
}

export async function resolveTaskConflict(id: string, keepLocal: boolean): Promise<void> {
  await queue?.resolve(id, keepLocal);
  await queue?.sync();
}

export async function loadTaskContextData(): Promise<{
  projects: ProjectRecord[];
  sessions: SessionSummary[];
} | null> {
  const started = taskAccountScope();
  if (!started) return null;
  const data = await Storage.getItem(`verity.tasks.context.${started}`);
  if (!data || taskAccountScope() !== started) return null;
  const parsed = JSON.parse(data) as { projects: unknown[]; sessions: unknown[] };
  return {
    projects: parsed.projects.map((value) => projectRecordSchema.parse(value)),
    sessions: parsed.sessions.map((value) => sessionSummarySchema.parse(value)),
  };
}
export async function saveTaskContextData(
  data: { projects: ProjectRecord[]; sessions: SessionSummary[] },
  expectedScope: string,
): Promise<void> {
  if (taskAccountScope() !== expectedScope) return;
  await Storage.setItem(`verity.tasks.context.${expectedScope}`, JSON.stringify(data));
}
