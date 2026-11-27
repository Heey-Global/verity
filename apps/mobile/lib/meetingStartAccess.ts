import { connectionFailureKind, VerityApiError } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

import { getAuthToken, subscribeAuthToken } from './authToken';
import { getBrowserSession, subscribeBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl, subscribeVerityBaseUrl } from './client';
import { isDemoMode } from './demoMode';
import { readMeetingExecuteProject, rememberMeetingExecuteGrant } from './meetingExecuteCache';
import { taskAccountScope } from './tasksStore';

export async function requireMeetingStartAccess(sessionId: string, signal?: AbortSignal) {
  const currentAttempt = () => !signal?.aborted;
  if (isDemoMode()) return;
  const client = createVerityClient();
  if (!client) throw new Error('Connect to Core to check recording permission.');

  const url = getVerityBaseUrl();
  const token = getAuthToken(url);
  const browser = getBrowserSession()?.tokenId;
  const account = taskAccountScope();
  const key = account === null ? undefined : JSON.stringify([account, sessionId]);
  const sameAccount = () =>
    getVerityBaseUrl() === url &&
    getAuthToken(url) === token &&
    getBrowserSession()?.tokenId === browser &&
    taskAccountScope() === account;
  const current = () => currentAttempt() && sameAccount();
  const assertAccount = () => {
    if (!currentAttempt()) throw new Error('The recording start was canceled.');
    if (!sameAccount()) throw new Error('The active account changed. Try again.');
  };
  const forget = () => {
    if (key) rememberMeetingExecuteGrant(key, undefined);
  };
  const denied = () =>
    new Error('You need Execute permission to start a recording in this session.');

  let project: string | undefined;
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  signal?.addEventListener('abort', abortRequest);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outstanding = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Recording permission check timed out. Try again.'));
      controller.abort();
    }, 10_000);
  });
  const check = async () => {
    const { projectId } = await client.getSession(sessionId, {
      trace: undefined,
      signal: controller.signal,
    });
    if (controller.signal.aborted || !current()) return false;
    project = projectId ?? '*';
    if (key) {
      const previous = await readMeetingExecuteProject(key).catch(() => undefined);
      if (previous !== undefined && previous !== project) forget();
    }
    if (controller.signal.aborted || !current()) return false;
    if (projectId === null || projectId === undefined) {
      await client.getVeritySettings();
      return true;
    }
    const { viewer } = await client.getProject(projectId);
    if (viewer?.canExecute === false) forget();
    if (viewer?.canExecute !== undefined) return viewer.canExecute;
    if (controller.signal.aborted || !current()) return false;
    await client.doppler.personalTokens(projectId);
    return true;
  };

  let allowed: boolean;
  try {
    const result = check().catch((error: unknown) => {
      if (error instanceof VerityApiError && [401, 403, 404].includes(error.status)) forget();
      throw error;
    });
    allowed = await Promise.race([result, outstanding]);
  } catch (error) {
    if (!current()) throw new Error('The active account changed. Try again.');
    if (error instanceof VerityApiError && [401, 403, 404].includes(error.status)) {
      throw denied();
    }
    if (key && connectionFailureKind(error)) {
      const previous = await readMeetingExecuteProject(key).catch(() => undefined);
      if (current() && previous !== undefined && (project === undefined || project === previous))
        return assertAccount;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortRequest);
  }

  if (!current()) throw new Error('The active account changed. Try again.');
  if (!allowed) throw denied();
  if (key) rememberMeetingExecuteGrant(key, project);
  return assertAccount;
}

export function usePendingMeetingStart(
  sessionId: string | undefined,
  setBusy: (busy: boolean) => void,
) {
  const pendingPermission = useRef<AbortController | null>(null);
  const finishPendingStart = () => {
    pendingPermission.current = null;
    setBusy(false);
  };
  const cancelPendingStart = useCallback(() => {
    const pending = pendingPermission.current;
    if (!pending) return;
    pendingPermission.current = null;
    pending.abort();
    setBusy(false);
  }, [setBusy]);
  useFocusEffect(
    useCallback(() => {
      if (!sessionId) return;
      const stops = [subscribeAuthToken, subscribeBrowserSession, subscribeVerityBaseUrl].map(
        (subscribe) => subscribe(cancelPendingStart),
      );
      return () => {
        for (const stop of stops) stop();
        cancelPendingStart();
      };
    }, [cancelPendingStart, sessionId]),
  );
  return { pendingPermission, cancelPendingStart, finishPendingStart };
}
