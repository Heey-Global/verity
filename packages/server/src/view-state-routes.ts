import { INBOX_KEY_MAX_CHARS, type EventStore, type ViewSubject } from '@verity/store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Deployments without the auth gate have one implicit user, as tasks and HTTP
 *  MCP connections assume; their view state belongs to that administrator. */
const legacyAdministratorId = '00000000-0000-4000-8000-000000000001';

/** Whose overview state a request reads and writes. */
export function viewerId(request: { localUserId: string | null | undefined }): string {
  return request.localUserId ?? legacyAdministratorId;
}

const params = z.object({ id: z.string().min(1).max(200) });
const body = z
  .object({ key: z.string().min(1).max(INBOX_KEY_MAX_CHARS), dismissed: z.boolean() })
  .strict();

/** Home item kinds each subject owns. A key is `<kind>:<subject id>[:<detail>]`. */
const subjectKinds: Record<ViewSubject['kind'], ReadonlySet<string>> = {
  session: new Set(['permission', 'question', 'crashed', 'merge']),
  project: new Set(['health']),
};

/**
 * Whether `key` names a Home item of this subject. Refusing other keys keeps one
 * row from collecting keys for items it can never show, which would otherwise
 * push out the ones it can within the bounded list.
 */
export function inboxKeyBelongsTo(subject: ViewSubject, key: string): boolean {
  const [kind, id] = key.split(':');
  return kind !== undefined && subjectKinds[subject.kind].has(kind) && id === subject.id;
}

export interface ViewStateRouteDeps {
  store: Pick<EventStore, 'viewState'>;
}

/** Registers the per-person "dismiss from Home" routes for sessions and projects. */
export function registerViewStateRoutes(app: FastifyInstance, deps: ViewStateRouteDeps): void {
  const handle =
    (kind: ViewSubject['kind']) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const { id } = params.parse(request.params);
      const { key, dismissed } = body.parse(request.body);
      const subject: ViewSubject = { kind, id };
      if (!inboxKeyBelongsTo(subject, key)) {
        reply.code(400);
        return { error: `key does not name a Home item of ${kind} ${id}` };
      }
      const inboxDismissed = await deps.store.viewState.setInboxDismissed(
        viewerId(request),
        subject,
        key,
        dismissed,
      );
      if (inboxDismissed === undefined) {
        reply.code(404);
        return { error: `${kind} ${id} not found` };
      }
      // The lists every device reloads carry the result; this echo only confirms it.
      return { id, inboxDismissed };
    };
  app.patch('/sessions/:id/inbox-dismissed', handle('session'));
  app.patch('/projects/:id/inbox-dismissed', handle('project'));
}
