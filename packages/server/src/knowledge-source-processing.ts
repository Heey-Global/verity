import { Worker } from 'node:worker_threads';
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

/** One bounded worker avoids multiplying native image memory across simultaneous uploads. */
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
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workerUrl = new URL(
      `./knowledge-source-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
      import.meta.url,
    );
    worker = new Worker(fileURLToPath(workerUrl), {
      workerData: { filename, bytes },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    const active = worker;
    const result = await new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Processing time limit exceeded')), 20_000);
      active.once('message', (value: unknown) => {
        const parsed = resultSchema.safeParse(value);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error('Invalid extraction output'));
      });
      active.once('error', reject);
      active.once('exit', () => reject(new Error('Processing worker exited without a result')));
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
    await worker?.terminate();
    processing = false;
  }
}
