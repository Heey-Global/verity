import type { EventStore, LiveMeetingSyncRecord } from '@verity/store';

/** Meeting audio creates suggestions; only an explicit app action starts an agent turn. */
export function attendeeResearchHints(options: {
  store: Pick<EventStore, 'liveMeetings'>;
  classify: (
    sessionId: string,
    utterance: string,
    context: string,
  ) => Promise<Array<{ kind: 'research' | 'opinion'; request: string }>>;
}) {
  return async (meeting: LiveMeetingSyncRecord, utterance: string, requestId: string) => {
    const requests = await options.classify(
      meeting.sessionId,
      utterance,
      meeting.transcript.slice(-1500),
    );
    for (const [index, request] of requests.entries()) {
      const accepted = await options.store.liveMeetings.addInsight(meeting.sessionId, {
        id: `${requestId}-${index}`,
        meetingId: meeting.id,
        kind: 'research',
        summary: request.request,
        evidenceA: utterance,
        evidenceB: null,
        sourcePath: null,
        createdAt: Date.now(),
      });
      if (!accepted) throw new Error('Meeting research hint could not be saved');
    }
  };
}
