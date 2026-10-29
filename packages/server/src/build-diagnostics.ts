import { stripVTControlCharacters } from 'node:util';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactProcessStderr } from '@verity/store';
import { z } from 'zod';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ENTRY_BYTES = 1024 * 1024;
const TOTAL_BYTES = 100 * ENTRY_BYTES;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const storedSchema = z.object({
  operationId: z.string().uuid(),
  recordedAt: z.string().datetime(),
  phase: z.literal('image_build'),
  code: z.literal('build_failed'),
  text: z.string(),
  truncated: z.boolean(),
});

interface BuildDiagnostic {
  operationId: string;
  recordedAt: string;
  phase: 'image_build';
  code: 'build_failed';
  text: string;
  truncated: boolean;
}

/** Redact complete input before bounding it: a cut must not expose a credential prefix. */
export function sanitizeDiagnostic(text: string, secrets: string[] = []): string {
  let safe = stripVTControlCharacters(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[REDACTED]');
    safe = safe
      .split(Buffer.from(`x-access-token:${secret}`).toString('base64'))
      .join('[REDACTED]');
  }
  return redactProcessStderr(safe, process.env);
}

export interface BuildDiagnosticStore {
  save(operationId: string, cause: unknown, secrets?: string[]): Promise<void>;
  read(operationId: string): Promise<BuildDiagnostic | null>;
  prune(): Promise<void>;
}

/** Private files on the persistent data volume, independent of the audit database.
 * All mutations are serialized so concurrent builds cannot overrun the total cap. */
export function createBuildDiagnosticStore(
  root: string,
  options: {
    now?: () => number;
    entryBytes?: number;
    totalBytes?: number;
    retentionMs?: number;
  } = {},
): BuildDiagnosticStore {
  const now = options.now ?? Date.now;
  const entryBytes = options.entryBytes ?? ENTRY_BYTES;
  const totalBytes = options.totalBytes ?? TOTAL_BYTES;
  const retention = options.retentionMs ?? RETENTION_MS;
  let queue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const path = (id: string) => {
    if (!validId.test(id)) throw new Error('Invalid diagnostic operation ID');
    return join(root, `${id}.json`);
  };
  async function prune() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await Promise.all(
      (await readdir(root))
        .filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
        .map(async (name) => {
          const file = join(root, name);
          const info = await stat(file);
          return { file, size: info.size, time: info.mtimeMs };
        }),
    );
    entries.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (entry.time <= now() - retention || bytes > totalBytes) {
        await unlink(entry.file);
        bytes -= entry.size;
      }
    }
  }
  return {
    prune: () => serialize(prune),
    save: (operationId, cause, secrets = []) =>
      serialize(async () => {
        const file = path(operationId);
        await prune();
        const error = cause as { stdout?: unknown; stderr?: unknown; code?: unknown } | null;
        const output = [error?.stdout, error?.stderr]
          .filter((value): value is string => typeof value === 'string')
          .join('\n');
        const raw =
          output ||
          (cause instanceof Error ? cause.message : 'Build failed without captured output');
        const safe = sanitizeDiagnostic(raw, secrets);
        const diagnostic: BuildDiagnostic = {
          operationId,
          recordedAt: new Date(now()).toISOString(),
          phase: 'image_build',
          code: 'build_failed',
          text: safe,
          truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        };
        // The cap covers the encoded record, including JSON escaping and metadata.
        while (
          Buffer.byteLength(JSON.stringify(diagnostic)) > entryBytes &&
          diagnostic.text.length > 0
        ) {
          diagnostic.truncated = true;
          const keep = Math.floor(diagnostic.text.length * 0.8);
          diagnostic.text = keep === 0 ? '' : diagnostic.text.slice(-keep);
        }
        if (Buffer.byteLength(JSON.stringify(diagnostic)) > entryBytes)
          throw new Error('Diagnostic metadata exceeds limit');
        const temporary = `${file}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(diagnostic), { mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        await prune();
      }),
    read: (operationId) =>
      serialize(async () => {
        const file = path(operationId);
        await prune();
        try {
          const info = await stat(file);
          if (info.size > entryBytes) throw new Error('Diagnostic file exceeds limit');
          const record = storedSchema.parse(JSON.parse(await readFile(file, 'utf8')));
          if (record.operationId !== operationId) throw new Error('Diagnostic operation mismatch');
          return { ...record, text: sanitizeDiagnostic(record.text) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }),
  };
}
