import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { getAuthToken, getAuthTokenId } from './authToken';
import { getBrowserSession } from './browserSession';
import { createVerityClient, getVerityBaseUrl } from './client';
import { createSessionConfirmingWarnings } from './startSession';

const identity = () =>
  JSON.stringify([
    getVerityBaseUrl(),
    Platform.OS === 'web'
      ? getBrowserSession()?.tokenId
      : getAuthToken(getVerityBaseUrl())
        ? getAuthTokenId(getVerityBaseUrl())
        : null,
  ]);

/** The repository an issue belongs to; without one it is the project's default repository. */
export interface IssueRepository {
  id: string;
  kind: 'github' | 'forgejo';
  owner: string;
  repo: string;
  isDefault: boolean;
}

/** Issue numbers repeat across repositories. The default repository keeps the key
 *  used before projects had several, so a retry pending across an update survives. */
const issueScope = (projectId: string, repository: IssueRepository | undefined) =>
  repository === undefined || repository.isDefault
    ? projectId
    : `${projectId}.repository:${encodeURIComponent(repository.id)}`;

const dispatchKey = (
  scope: string,
  projectId: string,
  repository: IssueRepository | undefined,
  issueNumber: number,
  target?: string,
) =>
  `verity.issues.dispatch.${scope}.${issueScope(projectId, repository)}.${issueNumber}.${target ?? 'new'}`;

const HOST_NAME = { github: 'GitHub', forgejo: 'Forgejo' } as const;

/** A created session does not prove that its initial issue turn was accepted. */
export async function taskIssueRetry(
  projectId: string,
  issueNumber: number,
  repository?: IssueRepository,
): Promise<{ targetSessionId?: string } | null> {
  const scope = identity();
  const prefix = dispatchKey(scope, projectId, repository, issueNumber, '');
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
  for (const key of keys) {
    const saved = await AsyncStorage.getItem(key);
    if (identity() !== scope) return null;
    if (!saved) continue;
    try {
      const value = JSON.parse(saved) as { sent: boolean; sessionId: string };
      if (value.sent === false && typeof value.sessionId === 'string')
        return key === `${prefix}new` ? {} : { targetSessionId: value.sessionId };
    } catch {
      // One damaged record must not hide another pending issue turn.
    }
  }
  return null;
}

const pending = new Map<string, Promise<string>>();
/** Retry the same persisted session/turn after a lost response without starting duplicate work. */
export function dispatchTaskIssue(
  projectId: string,
  issue: { number: number; title: string; url: string },
  targetSessionId?: string,
  repository?: IssueRepository,
): Promise<string> {
  const scope = identity();
  const key = dispatchKey(scope, projectId, repository, issue.number, targetSessionId);
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
      ? (JSON.parse(saved) as {
          sessionId: string;
          replyId: string;
          sent: boolean;
          created?: boolean;
        })
      : { sessionId: targetSessionId ?? randomUUID(), replyId: randomUUID(), sent: false };
    if (!saved) await AsyncStorage.setItem(key, JSON.stringify(dispatch));
    guard();
    if (targetSessionId || dispatch.sent || saved) {
      const session = (await client.listSessions()).find(
        (item) => item.sessionId === (targetSessionId ?? dispatch.sessionId),
      );
      guard();
      const usable = session && session.projectId === projectId && session.resumable !== false;
      if (targetSessionId && !usable) {
        await AsyncStorage.removeItem(key);
        guard();
        throw new Error('Choose a resumable session from this project');
      }
      if (dispatch.sent && usable) return dispatch.sessionId;
      if (!targetSessionId && !usable && (dispatch.sent || dispatch.created === true)) {
        dispatch = { sessionId: randomUUID(), replyId: randomUUID(), sent: false, created: false };
        await AsyncStorage.setItem(key, JSON.stringify(dispatch));
        guard();
      }
    }
    if (!targetSessionId) {
      await createSessionConfirmingWarnings(client, {
        sessionId: dispatch.sessionId,
        projectId,
        // The number names the session's branch, which is cut from the default
        // repository; another repository's number would name it after the wrong issue.
        ...(repository === undefined || repository.isDefault ? { issue: issue.number } : {}),
      });
      guard();
      // A missing list entry is ambiguous until the idempotent create resolves.
      dispatch.created = true;
      await AsyncStorage.setItem(key, JSON.stringify(dispatch));
      guard();
    }
    await client.sendTurn(dispatch.sessionId, {
      prompt:
        repository === undefined
          ? `Work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}`
          : `Work on ${HOST_NAME[repository.kind]} issue ${repository.owner}/${repository.repo}#${issue.number}: ${issue.title}\n${issue.url}`,
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
