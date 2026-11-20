import { z } from 'zod';

const id = z.string().min(1).max(128);
const message = z.string().trim().min(1).max(20000);
export const sessionCoordinationRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('discover'),
      targetProjectId: id.optional(),
      query: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('link'),
      requestId: id,
      targetProjectId: id,
      targetSessionId: id,
      message: message.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('start'),
      requestId: id,
      targetProjectId: id,
      name: z.string().trim().min(1).max(80),
      message,
    })
    .strict(),
]);
