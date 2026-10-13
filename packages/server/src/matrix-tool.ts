import { z } from 'zod';
import type { IntegrationStore } from '@verity/store';

const matrixId = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/\s/u.test(value) &&
      [...value].every(
        (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ),
  );
const snapshotFields = {
  accountId: matrixId.startsWith('@'),
  endpoint: z.url().startsWith('https://'),
  roomId: matrixId.startsWith('!'),
  roomName: z.string().min(1).max(160),
  bindingVersion: z.number().int().positive(),
  body: z
    .string()
    .min(1)
    .max(8_000)
    .refine((value) => value.trim().length > 0 && !value.includes('\0')),
};
export const matrixRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_rooms') }).strict(),
  z
    .object({
      action: z.literal('prepare_send'),
      accountId: snapshotFields.accountId,
      roomId: snapshotFields.roomId,
      body: snapshotFields.body,
    })
    .strict(),
  z.object({ action: z.literal('send'), ...snapshotFields }).strict(),
  z.object({ action: z.literal('status'), invocationId: z.uuid() }).strict(),
]);

export interface MatrixInvocationInput {
  projectId: string;
  sessionId: string;
  invocationId: string;
  request: unknown;
  approvedByCard?: boolean;
}

export function createMatrixTool(deps: {
  eventStore: {
    integrations: IntegrationStore;
    getSession(id: string): Promise<{ projectId: string | null } | undefined>;
  };
}) {
  const authorize = async (
    input: Pick<MatrixInvocationInput, 'projectId' | 'sessionId' | 'request'>,
  ) => {
    if ((await deps.eventStore.getSession(input.sessionId))?.projectId !== input.projectId) {
      throw new Error('Matrix access requires a session in the calling project');
    }
    const request = matrixRequestSchema.parse(input.request);
    if (request.action === 'send') {
      const snapshot = {
        accountId: request.accountId,
        endpoint: request.endpoint,
        roomId: request.roomId,
        roomName: request.roomName,
        bindingVersion: request.bindingVersion,
        body: request.body,
      };
      await deps.eventStore.integrations.outbound.validate(input.projectId, snapshot);
    }
    return request;
  };
  return {
    authorize,
    async invoke(input: MatrixInvocationInput): Promise<unknown> {
      const request = await authorize(input);
      const store = deps.eventStore.integrations;
      if (request.action === 'list_rooms') {
        const config = await store.matrixConfigSummary();
        const accounts = await store.listAccounts();
        return {
          rooms: (await store.listSources(input.projectId))
            .filter(
              (source) =>
                source.status === 'active' &&
                source.accountId === config?.username &&
                accounts.some(
                  (account) =>
                    account.id === source.accountId && account.endpoint === config.endpoint,
                ),
            )
            .map((source) => ({
              accountId: source.accountId,
              roomId: source.sourceId,
              roomName: source.displayName,
            })),
        };
      }
      if (request.action === 'prepare_send') {
        return store.outbound.prepare(
          input.projectId,
          request.accountId,
          request.roomId,
          request.body,
        );
      }
      if (request.action === 'status') {
        const result = await store.outbound.status(
          input.projectId,
          input.sessionId,
          request.invocationId,
        );
        if (!result) throw new Error('Matrix delivery was not found for this session');
        return result;
      }
      const snapshot = {
        accountId: request.accountId,
        endpoint: request.endpoint,
        roomId: request.roomId,
        roomName: request.roomName,
        bindingVersion: request.bindingVersion,
        body: request.body,
      };
      return store.outbound.enqueue({ ...input, snapshot });
    },
  };
}
