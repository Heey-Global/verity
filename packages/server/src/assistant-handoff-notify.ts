import type { EventBus } from '@verity/session';
import { ASSISTANT_HANDOFF_SUMMARY_MAX, type EventStore } from '@verity/store';

import { readDelegatedOutcome, type AssistantToolDeps } from './assistant-tool.js';
import type { PushRouter } from './push-router.js';
import { emitNotice } from './session-event-writer.js';
import { redactSessionObservationText } from './session-observation.js';

/** The longest push text: status word, then the session's summary cut to fit. */
export const ASSISTANT_HANDOFF_PUSH_MAX = 150;

export interface AssistantHandoffNoticeDeps {
  eventStore: EventStore;
  bus: EventBus;
  /** Absent without push; the card and the notice still carry the result. */
  pushRouter?: Pick<PushRouter, 'notify'> | undefined;
  permitted: AssistantToolDeps['permitted'];
  log: { warn(details: object, message: string): void };
}

/** `Done: …` or `Open: …`, cut to {@link ASSISTANT_HANDOFF_PUSH_MAX} characters. */
export function assistantHandoffPushBody(delivered: boolean, summary: string): string {
  const text = `${delivered ? 'Done' : 'Open'}: ${summary.replace(/\s+/gu, ' ').trim()}`;
  return text.length <= ASSISTANT_HANDOFF_PUSH_MAX
    ? text
    : `${text.slice(0, ASSISTANT_HANDOFF_PUSH_MAX - 1).trimEnd()}…`;
}

/**
 * Announces the result `targetSessionId` just published, when it answers a handoff of the
 * enabled assistant into a project still granted and readable. It records the result for the
 * handoff card, writes a notice into the assistant session and pushes the summary to the user.
 *
 * Nothing here starts an assistant turn, and the summary never enters a prompt: the notice
 * names only project and title, so session output cannot steer the assistant. Each publication
 * is announced once (`claimResult`), however often this runs. Returns whether it announced.
 */
export async function announceAssistantHandoffResult(
  deps: AssistantHandoffNoticeDeps,
  targetSessionId: string,
): Promise<boolean> {
  const settings = await deps.eventStore.assistant.settings();
  const assistantSessionId = settings.session_id;
  if (!settings.enabled || assistantSessionId === null || assistantSessionId === targetSessionId)
    return false;
  const handoff = await deps.eventStore.assistant.handoff(targetSessionId);
  if (handoff?.assistant_session_id !== assistantSessionId) return false;
  const grant = await deps.eventStore.assistant.grant(handoff.project_id);
  const project = await deps.eventStore.getProject(handoff.project_id);
  const target = await deps.eventStore.getSession(targetSessionId);
  if (
    grant === undefined ||
    grant.mode === 'off' ||
    project === undefined ||
    project.hiddenAt !== null ||
    project.archived === true ||
    target?.projectId !== handoff.project_id
  )
    return false;
  // The user the work was delegated for; without one (auth off), who switched the assistant on.
  const userId = handoff.user_id ?? settings.sponsor_user_id ?? undefined;
  if (!(await deps.permitted(userId, handoff.project_id, 'read'))) return false;

  const published = await readDelegatedOutcome(deps, handoff);
  if (published === undefined) return false;
  const summary = redactSessionObservationText(published.event.summary).slice(
    0,
    ASSISTANT_HANDOFF_SUMMARY_MAX,
  );
  const delivered = published.event.outcomeDelivered;
  // A decision the session needs is what holds the work when it named no blocker.
  const reason = published.event.blocker ?? published.event.requiredDecision;
  const blocker = reason === undefined ? undefined : redactSessionObservationText(reason);
  const claimed = await deps.eventStore.assistant.claimResult({
    assistantSessionId,
    targetSessionId,
    handedOffAt: handoff.handed_off_at,
    seq: published.seq,
    delivered,
    summary,
    blocker,
    at: new Date(published.ts),
  });
  if (!claimed) return false;

  const name = `${project.owner}/${project.repo}`;
  const title = handoff.title || 'Handoff';
  // The claim is taken, so nothing retries: a failed notice must not also cost the push.
  await emitNotice({
    eventStore: deps.eventStore,
    bus: deps.bus,
    sessionId: assistantSessionId,
    text: `${name}: the result for “${title}” is in. It is shown on the handoff card.`,
  }).catch((err: unknown) => {
    deps.log.warn({ err, sessionId: assistantSessionId }, 'assistant handoff notice failed');
  });
  await deps.pushRouter?.notify({
    key: `assistant-handoff:${targetSessionId}:${String(published.seq)}`,
    sessionId: assistantSessionId,
    initiatorUserId: userId,
    notification: {
      title: `${name} · ${title}`,
      body: assistantHandoffPushBody(delivered, summary),
      categoryId: 'SESSION_STATUS',
      data: { sessionId: assistantSessionId, kind: 'assistant_handoff' },
      sound: 'default',
    },
  });
  return true;
}

/** Announces handoff results as sessions publish them. Returns the unsubscribe function. */
export function installAssistantHandoffNotices(deps: AssistantHandoffNoticeDeps): () => void {
  return deps.bus.subscribeAll((sessionId, { event }) => {
    if (event.t !== 'session_progress') return;
    void announceAssistantHandoffResult(deps, sessionId).catch((err: unknown) => {
      deps.log.warn({ err, sessionId }, 'assistant handoff result not announced');
    });
  });
}
