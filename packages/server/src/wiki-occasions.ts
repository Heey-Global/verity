// Where the server notes that a project's Wiki may need to reflect something
// new. Noting is best effort: an occasion that cannot be stored never fails the
// import, meeting, decision or deletion that caused it.
import type { EventStore, RecordWikiOccasion } from '@verity/store';

type OccasionStore = Pick<EventStore, 'wikiOccasions'>;
type Log = { warn: (details: object, message: string) => void };

export async function noteWikiOccasion(
  store: OccasionStore | undefined,
  input: RecordWikiOccasion,
  log?: Log,
): Promise<void> {
  if (!store) return;
  try {
    await store.wikiOccasions.record(input);
  } catch (error) {
    log?.warn({ err: error, projectId: input.projectId, kind: input.kind }, 'wiki occasion lost');
  }
}

/** A knowledge path as the Wiki links it: `/knowledge/x` and `x` name the same file. */
export function knowledgeRef(path: string): string {
  return path.replace(/^\/knowledge\//, '');
}

/** A knowledge path's file name as a short title. */
export function occasionTitle(path: string): string {
  return path.split('/').at(-1)?.replace(/\.md$/i, '') ?? path;
}

/** How long a deletion waits for its occasion before it goes ahead without it. */
const DELETED_SESSION_NOTE_TIMEOUT_MS = 5_000;

/**
 * Keeps a session that is deleted as done for the Wiki: its conversation stays
 * with the occasion until a maintenance run read it. Nothing is copied into
 * the project's knowledge. A session deleted without review forgets any
 * occasion it already had.
 */
export async function noteDeletedSession(
  store: OccasionStore,
  session: { sessionId: string; projectId: string | null; name?: string | null },
  keepForWiki: boolean,
  log?: Log,
  timeoutMs = DELETED_SESSION_NOTE_TIMEOUT_MS,
): Promise<void> {
  const projectId = session.projectId;
  if (!projectId) return;
  // The deletion holds the session's exclusive slot while it waits; a slow
  // store must not turn noting into a stalled delete.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      noteSession(store, projectId, session, keepForWiki),
      timeout,
    ]);
    if (outcome === 'timeout')
      log?.warn({ sessionId: session.sessionId }, 'wiki occasion lost: deletion did not wait');
  } catch (error) {
    log?.warn({ err: error, sessionId: session.sessionId }, 'wiki occasion lost');
  } finally {
    clearTimeout(timer);
  }
}

async function noteSession(
  store: OccasionStore,
  projectId: string,
  session: { sessionId: string; name?: string | null },
  keepForWiki: boolean,
): Promise<'done'> {
  if (!keepForWiki) {
    await store.wikiOccasions.forgetSession(projectId, session.sessionId);
    return 'done';
  }
  const body = await store.wikiOccasions.sessionTranscript(session.sessionId);
  if (!body) return 'done';
  await store.wikiOccasions.record({
    projectId,
    kind: 'session',
    ref: session.sessionId,
    title: session.name?.trim() || 'Session',
    body,
    // A session that went quiet earlier has newer messages now.
    reopen: true,
  });
  return 'done';
}
