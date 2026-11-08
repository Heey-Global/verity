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
): Promise<void> {
  const projectId = session.projectId;
  if (!projectId) return;
  try {
    if (!keepForWiki) {
      await store.wikiOccasions.forgetSession(projectId, session.sessionId);
      return;
    }
    const body = await store.wikiOccasions.sessionTranscript(session.sessionId);
    if (!body) return;
    await store.wikiOccasions.record({
      projectId,
      kind: 'session',
      ref: session.sessionId,
      title: session.name?.trim() || 'Session',
      body,
      // A session that went quiet earlier has newer messages now.
      reopen: true,
    });
  } catch (error) {
    log?.warn({ err: error, sessionId: session.sessionId }, 'wiki occasion lost');
  }
}
