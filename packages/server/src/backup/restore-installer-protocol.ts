import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';

const path = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      isAbsolute(value) && normalize(value) === value && value !== '/' && !/[\0\r\n,:]/.test(value),
  );
const configuration = z
  .object({
    action: z.enum(['begin', 'advance', 'status', 'devices', 'review', 'abort']),
    root: path,
    hostRoot: path,
    previousManagedRoot: path.optional(),
    previousComposeProject: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
    tufCachePath: path,
    backupDirectory: path,
    jobId: z.string().uuid().optional(),
    selection: z
      .object({
        source: path,
        repository: z.string().regex(/^[a-f0-9-]{36}-r[1-9][0-9]{0,8}$/),
        sequence: z.number().int().positive().safe(),
        kind: z.enum(['manual', 'scheduled', 'pre-update']),
        newIdentity: z.boolean(),
      })
      .strict()
      .optional(),
    keepIds: z.array(z.string().min(1).max(256)).max(10000).optional(),
    addresses: z.array(z.string().max(128)).max(64),
    hostname: z.string().max(253).optional(),
  })
  .strict();
const installerRestoreRequestSchema = z
  .object({
    configuration,
    recoveryKey: z.string().max(256),
    masterPassword: z.string().max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    const config = value.configuration;
    if (config.action === 'begin' && !config.selection)
      context.addIssue({ code: 'custom', message: 'Explicit restore selection required' });
    if (!['begin', 'status'].includes(config.action) && !config.jobId)
      context.addIssue({ code: 'custom', message: 'Restore job ID required' });
    if (config.action === 'review' && !config.keepIds)
      context.addIssue({ code: 'custom', message: 'Explicit device allowlist required' });
  });

/** Only stdin carries secrets. Bound the stream before decoding or reporting a validation error. */
export async function readInstallerRestoreRequest(input: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('Installer restore request exceeds limit');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    try {
      return installerRestoreRequestSchema.parse(JSON.parse(bytes.toString()));
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error('Invalid installer restore request');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
