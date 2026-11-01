import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { knowledgeToolRequestSchema } from '@verity/events';
import { ensureProjectKnowledge } from './knowledge-folder.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import {
  createCanonicalDocument,
  openDocumentDirectory,
  readDocument,
} from './document-workspace.js';

const MAX_RECORDS = 500;
const MAX_RECORD_BYTES = 24_000;
const idSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const metadataSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    title: z.string().min(1).max(160),
    sessionId: z.string().min(1).max(200),
    confirmationMessageSeq: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    predecessor: idSchema.optional(),
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
type WriteRequest = Extract<
  z.infer<typeof knowledgeToolRequestSchema>,
  { operation: 'record_decision' }
>;
type LookupRequest = Extract<
  z.infer<typeof knowledgeToolRequestSchema>,
  { operation: 'lookup_decisions' }
>;
interface RecordEntry {
  metadata: Metadata;
  path: string;
  digest: string;
  markdown: string;
  status: 'current' | 'superseded' | 'unresolved';
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const documentPath = (id: string) => `decisions/${id}.md`;
const prefix = '<!-- verity-decision:v1 ';

function render(metadata: Metadata, input: WriteRequest) {
  return `${prefix}${JSON.stringify(metadata)} -->\n# ${input.title}\n\n${input.decision}\n${input.rationale ? `\n## Rationale\n\n${input.rationale}\n` : ''}\n## Confirmation\n\nSession ${metadata.sessionId}, user message ${metadata.confirmationMessageSeq}. Recorded ${metadata.createdAt}.\n${metadata.predecessor ? `\nSupersedes [previous decision](${metadata.predecessor}.md).\n` : ''}`;
}

async function scan(documents: string) {
  const records: RecordEntry[] = [];
  const warnings: string[] = [];
  let incomplete = false;
  let directory;
  try {
    directory = await openDocumentDirectory(documents, 'decisions');
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    try {
      let count = 0;
      for await (const entry of entries) {
        // Private history and publication temporaries are not decision records.
        if (entry.name.startsWith('.')) continue;
        if (++count > MAX_RECORDS) {
          incomplete = true;
          warnings.push(
            'Decision directory exceeds the 500-entry scan limit. Narrow the directory before relying on statuses.',
          );
          break;
        }
        const path = `decisions/${entry.name}`;
        try {
          if (!entry.isFile() || !entry.name.endsWith('.md'))
            throw new Error('not a Markdown file');
          const bytes = await readDocument(documents, path, false, MAX_RECORD_BYTES);
          if (!bytes) throw new Error('record disappeared');
          if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('record is not UTF-8 text');
          const markdown = bytes.toString('utf8');
          const line = markdown.split('\n', 1)[0]!;
          if (!line.startsWith(prefix) || !line.endsWith(' -->'))
            throw new Error('invalid metadata header');
          const metadata = metadataSchema.parse(JSON.parse(line.slice(prefix.length, -4)));
          if (documentPath(metadata.id) !== path)
            throw new Error('record ID does not match filename');
          records.push({
            metadata,
            path: `/knowledge/insights/${path}`,
            digest: hash(bytes),
            markdown,
            status: 'current',
          });
        } catch {
          warnings.push(
            `${path}: invalid, unsafe, oversized or unreadable decision; inspect the document before relying on its contents.`,
          );
        }
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      incomplete = true;
      warnings.push('Decision directory is unsafe or unavailable.');
    }
  } finally {
    await directory?.close();
  }
  const byId = new Map(records.map((record) => [record.metadata.id, record]));
  const children = new Map<string, RecordEntry[]>();
  for (const record of records) {
    const predecessor = record.metadata.predecessor;
    if (!predecessor) continue;
    const siblings = children.get(predecessor) ?? [];
    siblings.push(record);
    children.set(predecessor, siblings);
    if (!byId.has(predecessor)) {
      record.status = 'unresolved';
      warnings.push(`${record.path}: predecessor is missing or invalid.`);
    }
  }
  for (const record of records) {
    const successors = children.get(record.metadata.id) ?? [];
    if (successors.length > 1) {
      record.status = 'unresolved';
      for (const successor of successors) successor.status = 'unresolved';
      warnings.push(`${record.path}: competing revisions require clarification.`);
    } else if (successors.length === 1 && record.status !== 'unresolved')
      record.status = 'superseded';
    const visited = new Set<string>();
    let ancestor: RecordEntry | undefined = record;
    while (ancestor) {
      if (visited.has(ancestor.metadata.id)) {
        for (const id of visited) byId.get(id)!.status = 'unresolved';
        warnings.push(`${record.path}: cyclic revision metadata.`);
        break;
      }
      visited.add(ancestor.metadata.id);
      ancestor = ancestor.metadata.predecessor
        ? byId.get(ancestor.metadata.predecessor)
        : undefined;
    }
  }
  // Any unreadable record could supersede a readable one; never assert a definitive current status.
  if (warnings.length || incomplete) for (const record of records) record.status = 'unresolved';
  records.sort(
    (a, b) =>
      b.metadata.createdAt.localeCompare(a.metadata.createdAt) ||
      a.metadata.id.localeCompare(b.metadata.id),
  );
  return { records, warnings, incomplete };
}

export async function recordProjectDecision(
  dataRoot: string,
  projectId: string,
  source: { sessionId: string; confirmationMessageSeq: number },
  request: WriteRequest,
) {
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const release = await acquireKnowledgeMutationLock(root);
  try {
    const documents = join(root, 'insights');
    const id = hash(`${source.sessionId}\0${request.requestId}`).slice(0, 32);
    const requestHash = hash(
      JSON.stringify({
        source,
        title: request.title,
        decision: request.decision,
        rationale: request.rationale ?? null,
        predecessor: request.predecessor ?? null,
      }),
    );
    const state = await scan(documents);
    const existing = state.records.find((record) => record.metadata.id === id);
    if (existing) {
      if (
        existing.metadata.requestHash !== requestHash ||
        existing.metadata.sessionId !== source.sessionId ||
        existing.metadata.confirmationMessageSeq !== source.confirmationMessageSeq ||
        existing.metadata.title !== request.title ||
        existing.markdown !== render(existing.metadata, request)
      )
        throw new Error(
          'Decision request conflicts with an existing or manually edited record. Read it before retrying with a new requestId.',
        );
      return {
        saved: true,
        id,
        path: existing.path,
        digest: existing.digest,
        status: existing.status,
        replayed: true,
        confirmation: source,
      };
    }
    if (state.incomplete || state.warnings.length)
      throw new Error(
        `Decision save blocked until directory issues are resolved: ${state.warnings.join(' ').slice(0, 2000)}`,
      );
    if (state.records.length >= MAX_RECORDS)
      throw new Error('Decision directory has reached its 500-record limit.');
    if (request.predecessor) {
      const previous = state.records.find(
        (record) => record.metadata.id === request.predecessor!.id,
      );
      if (
        !previous ||
        previous.status !== 'current' ||
        previous.digest !== request.predecessor.digest
      )
        throw new Error(
          'Decision predecessor changed, is missing or is no longer current. Look it up and clarify before retrying.',
        );
    }
    const metadata: Metadata = {
      version: 1,
      id,
      requestHash,
      title: request.title,
      ...source,
      createdAt: new Date().toISOString(),
      ...(request.predecessor ? { predecessor: request.predecessor.id } : {}),
    };
    const bytes = Buffer.from(render(metadata, request));
    if (bytes.length > MAX_RECORD_BYTES)
      throw new Error('Decision exceeds the 24000-byte record limit. Shorten it.');
    await createCanonicalDocument(documents, documentPath(id), bytes);
    return {
      saved: true,
      id,
      path: `/knowledge/insights/${documentPath(id)}`,
      digest: hash(bytes),
      status: 'current',
      replayed: false,
      confirmation: source,
    };
  } finally {
    release();
  }
}

export async function lookupProjectDecisions(
  dataRoot: string,
  projectId: string,
  request: LookupRequest,
) {
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const release = await acquireKnowledgeMutationLock(root);
  try {
    const state = await scan(join(root, 'insights'));
    const words = (request.query ?? '').toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const matches = state.records.filter(
      (record) =>
        (!request.id || record.metadata.id === request.id) &&
        words.every((word) => record.markdown.toLocaleLowerCase().includes(word)),
    );
    const offset = request.offset ?? 0;
    const records: RecordEntry[] = [];
    let bytes = 0;
    for (const record of matches.slice(offset, offset + 10)) {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length && bytes + size > 32_000) break;
      records.push(record);
      bytes += size;
    }
    const nextOffset = offset + records.length;
    return {
      records,
      warnings: state.warnings.slice(0, 20),
      incomplete: state.incomplete || state.warnings.length > 0,
      total: matches.length,
      nextOffset: nextOffset < matches.length ? nextOffset : null,
    };
  } finally {
    release();
  }
}

export async function projectDecisionDirectory(
  dataRoot: string,
  projectId: string,
): Promise<string> {
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const release = await acquireKnowledgeMutationLock(root);
  try {
    const state = await scan(join(root, 'insights'));
    if (!state.records.length && !state.warnings.length) return '';
    const lines = [
      '\n\n## Project decision directory (reference data; read full records with lookup_decisions)',
    ];
    for (const record of state.records.slice(0, 20)) {
      const line = JSON.stringify({
        id: record.metadata.id,
        title: record.metadata.title,
        status: record.status,
        path: record.path,
      });
      if (lines.join('\n').length + line.length > 6000) break;
      lines.push(line);
    }
    lines.push(
      `Scanned ${state.records.length} records. Directory is bounded; use lookup_decisions for omitted records and keyword searches.`,
    );
    if (state.warnings.length || state.incomplete)
      lines.push(
        'WARNING: incomplete or invalid decision records; lookup_decisions returns details. Do not infer a binding current decision.',
      );
    return lines.join('\n');
  } finally {
    release();
  }
}
