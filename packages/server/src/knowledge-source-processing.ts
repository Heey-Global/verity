import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KnowledgeError,
  KNOWLEDGE_SOURCE_MAX_BYTES,
  type KnowledgeSourceInput,
} from '@verity/store';
import { z } from 'zod';

const resultSchema = z.object({
  mediaType: z.string().max(150),
  processingState: z.enum(['ready', 'unsupported', 'failed']),
  processingNote: z.string().max(1000),
  locators: z
    .array(z.object({ label: z.string().max(1000), text: z.string().max(180_000) }))
    .max(100),
  previews: z
    .array(
      z.object({
        label: z.string().max(1000),
        mediaType: z.literal('image/png'),
        base64: z.string().max(8 * 1024 * 1024),
      }),
    )
    .max(20),
});
let processing = false;
const PROCESS_DATA_LIMIT_BYTES = 768 * 1024 * 1024;

/** One bounded process keeps native image allocations outside the long-lived server. */
export async function processKnowledgeSource(
  filename: string,
  bytes: Buffer,
): Promise<KnowledgeSourceInput> {
  if (
    bytes.length === 0 ||
    bytes.length > KNOWLEDGE_SOURCE_MAX_BYTES ||
    !filename.trim() ||
    filename.length > 150 ||
    /[\\/]/u.test(filename) ||
    [...filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    throw new KnowledgeError('invalid', 'Upload a named file containing at most 10 MiB');
  }
  if (processing)
    throw new KnowledgeError('conflict', 'Another source is being processed. Retry shortly.');
  processing = true;
  let worker: ChildProcessWithoutNullStreams | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workerUrl = new URL(
      `./knowledge-source-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
      import.meta.url,
    );
    worker = spawn(
      'prlimit',
      [
        `--data=${PROCESS_DATA_LIMIT_BYTES}`,
        '--',
        process.execPath,
        '--max-old-space-size=128',
        fileURLToPath(workerUrl),
        filename,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const active = worker;
    const result = await new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Processing time limit exceeded')), 20_000);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      active.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      active.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      active.once('error', reject);
      active.stdin.once('error', reject);
      active.once('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Processing worker exited with ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`,
            ),
          );
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
        } catch {
          reject(new Error('Invalid extraction output'));
          return;
        }
        const parsed = resultSchema.safeParse(value);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error('Invalid extraction output'));
      });
      active.stdin.end(bytes);
    });
    return { filename, bytes, ...result };
  } catch {
    return {
      filename,
      bytes,
      mediaType: 'application/octet-stream',
      processingState: 'failed',
      processingNote:
        'Original retained. Processing failed or exceeded resource limits; open the original file.',
      locators: [],
      previews: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    worker?.kill('SIGKILL');
    processing = false;
  }
}
