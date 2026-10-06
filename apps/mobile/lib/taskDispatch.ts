import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AttachmentUpload, type Task } from '@verity/mobile';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { getAuthToken, getAuthTokenId } from './authToken';
import { getBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl } from './client';
import { createSessionConfirmingWarnings } from './startSession';
import { refreshTasks } from './tasksStore';

/** Persist the session and turn keys before network I/O so a retry cannot dispatch twice. */
const inFlight = new Map<string, Promise<string>>();
export function dispatchTasks(tasks: Task[], targetSessionId?: string): Promise<string> {
  const scope = JSON.stringify([
    getVerityBaseUrl(),
    Platform.OS === 'web' ? getBrowserSession()?.tokenId : getAuthTokenId(getVerityBaseUrl()),
  ]);
  const key = `${scope}:${tasks
    .map((task) => task.id)
    .sort()
    .join('.')}:${targetSessionId ?? 'new'}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = performDispatch(tasks, targetSessionId);
  inFlight.set(key, run);
  void run
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    })
    .catch(() => undefined);
  return run;
}
async function performDispatch(tasks: Task[], targetSessionId?: string): Promise<string> {
  if (
    !tasks.length ||
    !tasks[0]?.projectId ||
    tasks.some((t) => t.projectId !== tasks[0]?.projectId)
  )
    throw new Error('Select tasks from one project');
  if (tasks.some((task) => task.status === 'done' || task.status === 'dropped'))
    throw new Error('Reopen completed tasks before starting');
  if (tasks.reduce((total, task) => total + task.attachments.length, 0) > 8)
    throw new Error('Send at most eight attachments in one turn. Select fewer tasks.');
  const url = getVerityBaseUrl();
  const identity = () =>
    JSON.stringify([
      getVerityBaseUrl(),
      Platform.OS === 'web'
        ? getBrowserSession()?.tokenId
        : getAuthToken(getVerityBaseUrl())
          ? getAuthTokenId(getVerityBaseUrl())
          : null,
    ]);
  const tokenId =
    Platform.OS === 'web'
      ? getBrowserSession()?.tokenId
      : getAuthToken(url)
        ? getAuthTokenId(url)
        : null;
  const scope = identity();
  const client = createVerityClient();
  if (!client || !tokenId) throw new Error('Sign in to start a session');
  const guard = () => {
    if (identity() !== scope) throw new Error('Your connection changed; reopen Tasks');
  };
  const key = `verity.tasks.dispatch.${scope}.${tasks
    .map((t) => t.id)
    .sort()
    .join('.')}.${targetSessionId ?? 'new'}`;
  const saved = await AsyncStorage.getItem(key);
  guard();
  let dispatch = saved
    ? (JSON.parse(saved) as {
        sessionId: string;
        replyId: string;
        sent: boolean;
        sending?: boolean;
        tasks: Task[];
      })
    : { sessionId: targetSessionId ?? randomUUID(), replyId: randomUUID(), sent: false, tasks };
  if (!saved) await AsyncStorage.setItem(key, JSON.stringify(dispatch));
  guard();
  if (dispatch.sent) {
    const unchanged = tasks.every((task) =>
      dispatch.tasks.some(
        (original) =>
          original.id === task.id &&
          task.revision === original.revision + 1 &&
          task.status === 'in_progress' &&
          task.sessionId === dispatch.sessionId,
      ),
    );
    if (unchanged) return dispatch.sessionId;
    dispatch = {
      sessionId: targetSessionId ?? randomUUID(),
      replyId: randomUUID(),
      sent: false,
      tasks,
    };
    await AsyncStorage.setItem(key, JSON.stringify(dispatch));
  }
  const stale = async () => {
    if (!dispatch.sending) await AsyncStorage.removeItem(key);
    throw new Error('Task changed; refresh Tasks before starting');
  };
  guard();
  const currentTasks = await client.listTasks();
  guard();
  const submitted = dispatch.tasks;
  const attachments: AttachmentUpload[] = [];
  let totalBytes = 0;
  for (const task of submitted) {
    for (const attachment of task.attachments) {
      guard();
      const bytes = new Uint8Array(await client.readTaskAttachment(task.id, attachment.hash));
      guard();
      totalBytes += bytes.length;
      if (totalBytes > 50_000_000)
        throw new Error('Attachments exceed the 50 MB turn limit. Select fewer tasks.');
      const image = /^image\/(png|jpeg|webp|gif)$/.test(attachment.mimeType);
      if (image ? Math.ceil(bytes.length / 3) * 4 > 10_000_000 : bytes.length > 25_000_000)
        throw new Error('An attachment exceeds the turn size limit.');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const data = btoa(binary);
      const mediaType = attachment.mimeType;
      if (
        mediaType === 'image/png' ||
        mediaType === 'image/jpeg' ||
        mediaType === 'image/webp' ||
        mediaType === 'image/gif'
      )
        attachments.push({ kind: 'image', mediaType, data });
      else attachments.push({ kind: 'file', fileName: attachment.filename, mediaType, data });
    }
  }
  if (!targetSessionId)
    await createSessionConfirmingWarnings(client, {
      sessionId: dispatch.sessionId,
      projectId: tasks[0].projectId,
    });
  guard();
  for (const task of submitted) {
    guard();
    const current = currentTasks.find((item) => item.id === task.id);
    if (!current || current.projectId !== task.projectId) await stale();
    if (!current) throw new Error('Task no longer exists');
    if (dispatch.sending && current.sessionId === dispatch.sessionId) continue;
    // A lost PATCH response can leave the assignment saved but the turn unsent.
    if (
      current.sessionId === dispatch.sessionId &&
      current.status === 'in_progress' &&
      current.revision === task.revision + 1
    )
      continue;
    if (current.revision !== task.revision) await stale();
    await client.updateTask(task.id, {
      expectedRevision: task.revision,
      sessionId: dispatch.sessionId,
      status: 'in_progress',
    });
  }
  guard();
  dispatch.sending = true;
  await AsyncStorage.setItem(key, JSON.stringify(dispatch));
  guard();
  await client.sendTurn(dispatch.sessionId, {
    prompt: submitted
      .map(
        (task) => `Work on task #${task.id}: ${task.title}${task.detail ? `\n${task.detail}` : ''}`,
      )
      .join('\n\n'),
    attachments,
    clientReplyId: dispatch.replyId,
  });
  guard();
  await AsyncStorage.setItem(key, JSON.stringify({ ...dispatch, sent: true }));
  await refreshTasks();
  return dispatch.sessionId;
}
