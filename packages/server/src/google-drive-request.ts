import { z } from 'zod';
import { fileOperationRequestSchema } from '@verity/events';

export const googleDriveRequestSchema = z.discriminatedUnion('action', [
  ...fileOperationRequestSchema.options,
  z
    .object({
      action: z.literal('read_document_url'),
      url: z
        .string()
        .max(2048)
        .refine((value) => {
          try {
            const url = new URL(value);
            const match = /^\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname);
            if (
              url.protocol === 'https:' &&
              url.hostname === 'docs.google.com' &&
              !url.port &&
              !url.username &&
              !url.password &&
              match
            )
              return true;
          } catch {
            /* Invalid URLs are rejected below. */
          }
          return false;
        }, 'Expected an HTTPS Google Docs document URL'),
    })
    .strict(),
  z
    .object({
      action: z.literal('select_workspace_file'),
      fileId: z.string().min(1).max(512).optional(),
      name: z.string().trim().min(1).max(255).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.fileId || value.name), 'fileId or name required'),
]);
type GoogleDriveRequest = z.infer<typeof googleDriveRequestSchema>;
export function googleDriveIsMutation(request: GoogleDriveRequest): boolean {
  return ![
    'capabilities',
    'list',
    'search',
    'read',
    'read_document_url',
    'select_workspace_file',
  ].includes(request.action);
}
export function googleDriveNeedsApproval(request: GoogleDriveRequest): boolean {
  return ['overwrite', 'rename', 'move', 'trash'].includes(request.action);
}
export function googleDriveHasStandingAuthorization(value: unknown): boolean {
  const request = googleDriveRequestSchema.safeParse(value);
  return request.success && !googleDriveNeedsApproval(request.data);
}
