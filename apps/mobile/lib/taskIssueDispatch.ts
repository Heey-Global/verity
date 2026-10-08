import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { getAuthToken, getAuthTokenId } from './authToken';
import { getBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl } from './client';
import { createSessionConfirmingWarnings } from './startSession';

const pending = new Map<string, Promise<string>>();
/** Retry the same persisted session/turn after a lost response without starting duplicate work. */
export function dispatchTaskIssue(
  projectId: string,
  issue: { number: number; title: string; url: string },
  targetSessionId?: string,
): Promise<string> {
  const identity = () =>
    JSON.stringify([
      getVerityBaseUrl(),
      Platform.OS === 'web'
        ? getBrowserSession()?.tokenId
        : getAuthToken(getVerityBaseUrl())
          ? getAuthTokenId(getVerityBaseUrl())
          : null,
    ]);
  const scope = identity();
  const key = `verity.issues.dispatch.${scope}.${projectId}.${issue.number}.${targetSessionId ?? 'new'}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const run = (async () => {
    const client = createVerityClient();
    if (!client) throw new Error('Sign in to start a session');
    const guard = () => {
      if (identity() !== scope) throw new Error('Your connection changed; reopen Tasks');
    };
    const saved = await AsyncStorage.getItem(key);
    guard();
    let dispatch = saved
      ? (JSON.parse(saved) as { sessionId: string; replyId: string; sent: boolean })
      : { sessionId: targetSessionId ?? randomUUID(), replyId: randomUUID(), sent: false };
    if (!saved) await AsyncStorage.setItem(key, JSON.stringify(dispatch));
    guard();
    if (targetSessionId || dispatch.sent) {
      const session = (await client.listSessions()).find(
        (item) => item.sessionId === (targetSessionId ?? dispatch.sessionId),
      );
      guard();
      const usable = session && session.projectId === projectId && session.resumable !== false;
      if (targetSessionId && !usable)
        throw new Error('Choose a resumable session from this project');
      if (dispatch.sent && usable) return dispatch.sessionId;
      if (!targetSessionId && !usable) {
        dispatch = { sessionId: randomUUID(), replyId: randomUUID(), sent: false };
        await AsyncStorage.setItem(key, JSON.stringify(dispatch));
        guard();
      }
    }
    if (!targetSessionId) {
      await createSessionConfirmingWarnings(client, {
        sessionId: dispatch.sessionId,
        projectId,
        issue: issue.number,
      });
      guard();
    }
    await client.sendTurn(dispatch.sessionId, {
      prompt: `Work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}`,
      clientReplyId: dispatch.replyId,
    });
    guard();
    await AsyncStorage.setItem(key, JSON.stringify({ ...dispatch, sent: true }));
    return dispatch.sessionId;
  })();
  pending.set(key, run);
  void run
    .finally(() => {
      if (pending.get(key) === run) pending.delete(key);
    })
    .catch(() => undefined);
  return run;
}
