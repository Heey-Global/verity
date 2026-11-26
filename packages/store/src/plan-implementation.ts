import { parsePlanningProposal, type AgentEvent } from '@verity/events';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { SequencedEvent } from './event-history.js';
import type { EventWriteStore } from './event-writes.js';
import type { MessageProjectionStore } from './message-projection.js';
import type { Database } from './schema.js';
import { sessionEventAppendLock } from './session-event-lock.js';
import { TaskStore } from './tasks.js';
import type { QueuedTurnInput } from './turn-records.js';

export interface PlanningConsent {
  turnId: string;
  promptSeq: number;
  runningPromptSeq: number;
}

export class PlanImplementationStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly getCipher: () => SecretCipher,
    private readonly getEventWrites: () => Pick<EventWriteStore, 'prepareEventRow'>,
    private readonly getMessageProjection: () => Pick<
      MessageProjectionStore,
      'enqueuePersistedMessageEvent'
    >,
  ) {}

  /** Accept a plan and its implementation backlog entry together. A restart
   * between acceptance and the live queue update must still recover the work. */
  async enqueuePlanImplementation(
    input: QueuedTurnInput,
    revision: number,
    onPersisted?: (event: SequencedEvent) => void,
    consent?: PlanningConsent,
  ): Promise<boolean> {
    const persisted: { seq: number; createdAt: Date; event: AgentEvent }[] = [];
    const accepted = await this.getDb()
      .transaction()
      .execute(async (tx) => {
        // A newer user prompt revokes chat consent before any tasks or work commit.
        await sessionEventAppendLock(tx, input.sessionId);
        if (consent !== undefined) {
          const running = await tx
            .selectFrom('running_turns')
            .select(['turn_id', 'prompt_seq'])
            .where('session_id', '=', input.sessionId)
            .forUpdate()
            .executeTakeFirst();
          const queuedPrompt = await tx
            .selectFrom('queued_turns')
            .select('id')
            .where('session_id', '=', input.sessionId)
            .limit(1)
            .executeTakeFirst();
          if (queuedPrompt !== undefined) return false;
          const latest = await tx
            .selectFrom('events')
            .select('id')
            .where('session_id', '=', input.sessionId)
            .where('type', '=', 'prompt')
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
          if (
            running?.turn_id !== consent.turnId ||
            Number(running.prompt_seq) !== consent.runningPromptSeq ||
            Number(latest?.id) !== consent.promptSeq
          )
            return false;
        }

        const result = await tx
          .updateTable('sessions')
          .set({ planning: 'implemented' })
          .where('session_id', '=', input.sessionId)
          .where('planning', '=', 'active')
          .where('planning_revision', '=', revision)
          .where('planning_plan', 'is not', null)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) return false;
        const session = await tx
          .selectFrom('sessions')
          .select(['project_id', 'planning_plan'])
          .where('session_id', '=', input.sessionId)
          .executeTakeFirstOrThrow();
        const tasks = new TaskStore(tx, this.getCipher());
        const ownerUserId = await tasks.agentTaskOwner(input.sessionId, session.project_id);
        if (ownerUserId !== undefined) {
          const steps = parsePlanningProposal(session.planning_plan!).steps;
          const taskIds: string[] = [];
          for (const [index, step] of steps.entries()) {
            const id = randomUUID();
            const title = step
              .replace(/\*\*/g, '')
              .split(/\s+[—–]\s+|\n/)[0]!
              .slice(0, 2_000);
            await tasks.upsert({
              id,
              ownerUserId,
              projectId: session.project_id,
              sessionId: input.sessionId,
              sourceSessionId: input.sessionId,
              origin: 'agent',
              title,
              detail: step.slice(0, 20_000),
              sort: index,
            });
            taskIds.push(id);
          }
          // The event and tasks commit with acceptance: recovery never loses the link
          // to the accepted steps, and concurrent decisions cannot duplicate them.
          for (let offset = 0; offset < taskIds.length; offset += 100) {
            const event: AgentEvent = {
              t: 'tasks_updated',
              origin: 'agent',
              change: 'added',
              taskIds: taskIds.slice(offset, offset + 100),
            };
            const eventRow = await this.getEventWrites().prepareEventRow(event);
            await sessionEventAppendLock(tx, input.sessionId);
            const row = await tx
              .insertInto('events')
              .values({
                session_id: input.sessionId,
                type: eventRow.type,
                payload: eventRow.payload,
              })
              .returning(['id', 'created_at'])
              .executeTakeFirstOrThrow();
            persisted.push({ seq: Number(row.id), createdAt: row.created_at, event });
          }
        }
        await tx
          .insertInto('queued_turns')
          .values({
            id: input.id,
            session_id: input.sessionId,
            prompt: input.prompt,
            opts: JSON.stringify(input.opts),
          })
          .execute();
        return true;
      });
    for (const row of persisted) {
      this.getMessageProjection().enqueuePersistedMessageEvent(
        input.sessionId,
        row.seq,
        row.createdAt,
        row.event,
      );
      onPersisted?.({ seq: row.seq, ts: row.createdAt.getTime(), event: row.event });
    }
    return accepted;
  }
}
