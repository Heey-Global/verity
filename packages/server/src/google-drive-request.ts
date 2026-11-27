import { z } from 'zod';
import { fileOperationRequestSchema } from '@verity/events';

const accountFields = {
  accountId: z.string().min(1).optional(),
  folderLinkId: z.string().min(1).optional(),
};

export const googleDriveRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...accountFields,
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
      ...accountFields,
      action: z.literal('select_workspace_file'),
      fileId: z.string().min(1).max(512).optional(),
      name: z.string().trim().min(1).max(255).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.fileId || value.name), 'fileId or name required'),
  ...fileOperationRequestSchema.options.map((option) => option.safeExtend(accountFields)),
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

export const GOOGLE_DRIVE_TOOL_DESCRIPTION =
  'Call capabilities to list the project folder links and available accounts. Choose folderLinkId for every folder operation when multiple folders exist; read_document_url outside a linked folder needs accountId when multiple accounts exist and explicit approval. Account selection never falls back to another account. Use read_document_url with a Google Docs link supplied by the user to read it through the connected Google account, including shared documents, without a linked project folder. Do not fetch private Google Docs links through unauthenticated web or shell requests. This action only reads the document; it does not select it for editing or import it into project knowledge. Other actions work with files inside the Google Drive folder connected to this project. List or search before reading with the read action. Use select_workspace_file before editing a native Google Docs, Sheets, or Slides file with its dedicated tool. Upload creates a new regular file; create_folder creates a folder. Read a file or folder to obtain expectedVersion before overwrite, rename, move, or trash. Those actions require explicit approval. Trash is recoverable through Google Drive and includes folder contents; the linked root cannot be changed. Overwrite only replaces regular file bytes, never native Workspace contents. Read-only projects cannot mutate files.';
