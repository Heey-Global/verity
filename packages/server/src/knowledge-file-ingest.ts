import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { KNOWLEDGE_SOURCE_MAX_BYTES } from '@verity/store';

import { EXTRACTED_TEXT_DIR } from './knowledge-folder.js';
import { processKnowledgeSource } from './knowledge-source-processing.js';
import { normalizeSessionRelativePath, sessionFilePath } from './session-files.js';

const extractionQueues = new Map<string, Promise<void>>();

async function withExtractionLock<T>(keys: string[], action: () => Promise<T>): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  const previous = uniqueKeys.map((key) => extractionQueues.get(key) ?? Promise.resolve());
  let result: T;
  const pending = Promise.all(previous.map((operation) => operation.catch(() => undefined))).then(
    async () => {
      result = await action();
    },
  );
  for (const key of uniqueKeys) extractionQueues.set(key, pending);
  try {
    await pending;
    return result!;
  } finally {
    for (const key of uniqueKeys) {
      if (extractionQueues.get(key) === pending) extractionQueues.delete(key);
    }
  }
}

export function knowledgeExtractionPath(root: string, relativePath: string): string {
  const rel = normalizeSessionRelativePath(relativePath);
  const leaf = basename(rel);
  // Leave enough room for the metadata and atomic-write suffixes on filesystems
  // with the usual 255-byte component limit. Long source names use a stable key.
  const artifactLeaf =
    Buffer.byteLength(`${leaf}.md.meta.json.${'0'.repeat(36)}.tmp`) <= 255
      ? `${leaf}.md`
      : `${createHash('sha256').update(leaf).digest('hex')}.md`;
  return sessionFilePath(root, join(EXTRACTED_TEXT_DIR, dirname(rel), artifactLeaf)).abs;
}

function extractionMetaPath(root: string, relativePath: string): string {
  return `${knowledgeExtractionPath(root, relativePath)}.meta.json`;
}

/** Write a trusted derived transcript for a binary whose extractor is external. */
export async function writeKnowledgeExtraction(
  root: string,
  relativePath: string,
  markdown: string,
): Promise<void> {
  const output = knowledgeExtractionPath(root, relativePath);
  await withExtractionLock([output], async () => {
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, markdown, { mode: 0o644 });
  });
}

/**
 * Append a derived section to an existing artifact, once. Returns false when the
 * section is already there or the original or its artifact is gone: a redaction
 * that landed while the section was being produced must not be resurrected.
 */
export async function appendKnowledgeExtractionSection(
  root: string,
  relativePath: string,
  heading: string,
  body: string,
): Promise<boolean> {
  const source = sessionFilePath(root, relativePath);
  const output = knowledgeExtractionPath(root, source.rel);
  return withExtractionLock([output], async () => {
    const present = await stat(source.abs).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!present) return false;
    const markdown = await readFile(output, 'utf8').catch(() => undefined);
    if (markdown === undefined || markdown.includes(`\n## ${heading}\n`)) return false;
    const separator = markdown.endsWith('\n') ? '\n' : '\n\n';
    await writeFile(output, `${markdown}${separator}## ${heading}\n\n${body.trim()}\n`, {
      mode: 0o644,
    });
    return true;
  });
}

function extractedMarkdown(
  relativePath: string,
  result: Awaited<ReturnType<typeof processKnowledgeSource>>,
): string {
  const sections = result.locators.map(({ label, text }) => `## ${label}\n\n${text.trim()}\n`);
  return [
    `# ${basename(relativePath)}`,
    '',
    `Source: ${relativePath}`,
    `Media type: ${result.mediaType}`,
    `Processing: ${result.processingState} — ${result.processingNote}`,
    '',
    ...sections,
  ].join('\n');
}

/** Extract a knowledge file into its hidden, path-mirrored Markdown artifact. */
async function extractKnowledgeFileUnlocked(root: string, relativePath: string): Promise<void> {
  const source = sessionFilePath(root, relativePath);
  const sourceStats = await stat(source.abs);
  if (!sourceStats.isFile()) return;
  const output = knowledgeExtractionPath(root, source.rel);
  const meta = extractionMetaPath(root, source.rel);
  await mkdir(dirname(output), { recursive: true, mode: 0o755 });

  if (sourceStats.size > KNOWLEDGE_SOURCE_MAX_BYTES) {
    await writeFile(
      output,
      `# ${basename(source.rel)}\n\nSource: ${source.rel}\n\nExtraction skipped: file exceeds the ${String(KNOWLEDGE_SOURCE_MAX_BYTES)} byte processing limit.\n`,
      { mode: 0o644 },
    );
    await writeFile(
      meta,
      JSON.stringify({ path: source.rel, size: sourceStats.size, mtimeMs: sourceStats.mtimeMs }),
      { mode: 0o644 },
    );
    return;
  }

  const bytes = await readFile(source.abs);
  const identity = {
    path: source.rel,
    size: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const previous = await readFile(meta, 'utf8').catch(() => '');
  if (previous === JSON.stringify(identity)) return;
  const result = await processKnowledgeSource(basename(source.rel), bytes);
  const nonce = randomUUID();
  const outputTmp = `${output}.${nonce}.tmp`;
  const metaTmp = `${meta}.${nonce}.tmp`;
  await writeFile(outputTmp, extractedMarkdown(source.rel, result), { mode: 0o644 });
  await writeFile(metaTmp, JSON.stringify(identity), { mode: 0o644 });
  await rename(outputTmp, output);
  await rename(metaTmp, meta);
}

export async function extractKnowledgeFile(root: string, relativePath: string): Promise<void> {
  const key = knowledgeExtractionPath(root, relativePath);
  await withExtractionLock([key], () => extractKnowledgeFileUnlocked(root, relativePath));
}

/** Remove the derived artifacts belonging to an original file. */
export async function removeKnowledgeExtraction(root: string, relativePath: string): Promise<void> {
  const key = knowledgeExtractionPath(root, relativePath);
  await withExtractionLock([key], async () => {
    await Promise.all([
      unlink(key).catch(() => undefined),
      unlink(extractionMetaPath(root, relativePath)).catch(() => undefined),
    ]);
  });
}

/** Move an existing derived artifact with its source instead of re-extracting it. */
export async function moveKnowledgeExtraction(
  fromRoot: string,
  fromRelativePath: string,
  toRoot: string,
  toRelativePath: string,
): Promise<boolean> {
  const from = knowledgeExtractionPath(fromRoot, fromRelativePath);
  const to = knowledgeExtractionPath(toRoot, toRelativePath);
  return withExtractionLock([from, to], () =>
    moveKnowledgeExtractionUnlocked(fromRoot, fromRelativePath, toRoot, toRelativePath, from, to),
  );
}

async function moveKnowledgeExtractionUnlocked(
  fromRoot: string,
  fromRelativePath: string,
  toRoot: string,
  toRelativePath: string,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    await stat(from);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
  await mkdir(dirname(to), { recursive: true, mode: 0o755 });
  await rename(from, to);
  const fromMeta = extractionMetaPath(fromRoot, fromRelativePath);
  const toMeta = extractionMetaPath(toRoot, toRelativePath);
  await rename(fromMeta, toMeta).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  });
  const markdown = await readFile(to, 'utf8');
  const updatedMarkdown = markdown
    .replace(/^# .*$/mu, `# ${basename(toRelativePath)}`)
    .replace(/^Source: .*$/mu, `Source: ${toRelativePath}`);
  if (updatedMarkdown !== markdown) await writeFile(to, updatedMarkdown, { mode: 0o644 });
  const metadata = await readFile(toMeta, 'utf8').catch(() => '');
  if (metadata) {
    const identity = JSON.parse(metadata) as Record<string, unknown>;
    identity.path = normalizeSessionRelativePath(toRelativePath);
    await writeFile(toMeta, JSON.stringify(identity), { mode: 0o644 });
  }
  return true;
}

/** Store bytes without overwriting, then synchronously derive readable text. */
export async function ingestKnowledgeBytes(
  root: string,
  relativePath: string,
  bytes: Buffer,
): Promise<string> {
  const target = sessionFilePath(root, relativePath);
  await mkdir(dirname(target.abs), { recursive: true, mode: 0o755 });
  const handle = await open(
    target.abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  ).catch(async (error: unknown) => {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const existingHandle = await open(target.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const existing = await existingHandle.readFile();
      if (existing.equals(bytes)) return undefined;
      throw error;
    } finally {
      await existingHandle.close();
    }
  });
  if (handle === undefined) {
    await extractKnowledgeFile(root, target.rel);
    return target.rel;
  }
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await unlink(target.abs).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await extractKnowledgeFile(root, target.rel);
  return target.rel;
}
