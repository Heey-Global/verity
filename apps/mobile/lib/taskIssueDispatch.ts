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

/** What this device recorded about handing one issue to Verity. */
export interface TaskIssueRecord {
  /** A turn not yet accepted: retry it (into `targetSessionId` when it went to one). */
  retry: { targetSessionId?: string } | null;
  /** Sessions whose turn for the issue was accepted. */
  sessions: string[];
}

/**
 * The hand-over records of many issues at once, with one key listing for all of
 * them: a list of several repositories asks for every issue on each refresh.
 */
export async function taskIssueRecords(
  projectId: string,
  items: readonly { number: number; repository?: IssueRepository | undefined }[],
): Promise<TaskIssueRecord[]> {
  const scope = identity();
  const empty = () => items.map((): TaskIssueRecord => ({ retry: null, sessions: [] }));
  const all = await AsyncStorage.getAllKeys();
  if (identity() !== scope) return empty();
  const prefixes = items.map((item) =>
    dispatchKey(scope, projectId, item.repository, item.number, ''),
  );
  const keys = prefixes.map((prefix) => all.filter((key) => key.startsWith(prefix)));
  const values = new Map(await AsyncStorage.multiGet([...new Set(keys.flat())]));
  if (identity() !== scope) return empty();
  return items.map((_, index): TaskIssueRecord => {
    const record: TaskIssueRecord = { retry: null, sessions: [] };
    for (const key of keys[index]!) {
      const saved = values.get(key);
      if (!saved) continue;
      try {
        const value = JSON.parse(saved) as { sent?: unknown; sessionId?: unknown };
        if (typeof value.sessionId !== 'string') continue;
        if (value.sent === true) record.sessions.push(value.sessionId);
        else if (value.sent === false && record.retry === null)
          record.retry =
            key === `${prefixes[index]!}new` ? {} : { targetSessionId: value.sessionId };
      } catch {
        // One damaged record must not hide another hand-over.
      }
    }
    return record;
  });
}

/** A created session does not prove that its initial issue turn was accepted. */
export async function taskIssueRetry(
  projectId: string,
  issueNumber: number,
  repository?: IssueRepository,
): Promise<{ targetSessionId?: string } | null> {
  return (await taskIssueRecords(projectId, [{ number: issueNumber, repository }]))[0]!.retry;
}

/**
 * The sessions this device handed an issue to — a new one or an existing one —
 * once the turn was accepted. Only the default repository's issues name their
 * session's branch; for another repository's issue these records are the only
 * link back to its sessions.
 */
export async function taskIssueSessions(
  projectId: string,
  issueNumber: number,
  repository?: IssueRepository,
): Promise<string[]> {
  return (await taskIssueRecords(projectId, [{ number: issueNumber, repository }]))[0]!.sessions;
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
          : // Without owner and repository (an older server's answer read before the
            // project record arrived) the host is a guess too; the URL names both.
            !repository.owner || !repository.repo
            ? `Work on issue #${issue.number}: ${issue.title}\n${issue.url}`
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
