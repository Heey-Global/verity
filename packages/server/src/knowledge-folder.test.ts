import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureProjectKnowledge,
  ensureSharedKnowledge,
  knowledgeSandboxBinds,
  KNOWLEDGE_MOUNT_TARGET,
  KNOWLEDGE_DOCUMENTS_DIR,
  KNOWLEDGE_INSIGHTS_DIR,
  knowledgeRootDir,
  PROJECT_KNOWLEDGE_SUBDIRS,
  projectKnowledgeDir,
  sharedKnowledgeDir,
} from './knowledge-folder.js';

/** Split a `host:target[:mode]` bind the way the provisioner's partitioner does. */
function parseBind(bind: string): { host: string; target: string; mode: string | undefined } {
  const [host = '', target = '', mode] = bind.split(':');
  return { host, target, mode };
}

describe('knowledge folder layout (ADR 0022 D1/D2)', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'verity-knowledge-'));
  });
  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('gives every bind a mount point that already exists on disk', async () => {
    // The silent failure this catches is not in any assertion about names: a
    // read-only bind onto a path that does not exist fails at CONTAINER CREATE,
    // long after any test here, and the project simply stops provisioning. So
    // the expectation is derived from the binds themselves — whatever
    // `knowledgeSandboxBinds` decides to mount must be a directory `ensure…`
    // has made, including the nested `/knowledge/<name>` mount point that lives
    // INSIDE the read-only mount and therefore cannot be created at run time.
    await ensureSharedKnowledge(dataRoot);
    const projectDir = await ensureProjectKnowledge(dataRoot, 'p-1');

    for (const bind of knowledgeSandboxBinds(dataRoot, 'p-1')) {
      const { host, target, mode } = parseBind(bind);
      expect(statSync(host).isDirectory()).toBe(true);
      // Nested targets need their mount point inside the parent mount's source.
      if (target !== KNOWLEDGE_MOUNT_TARGET) {
        const nested = relative(KNOWLEDGE_MOUNT_TARGET, target);
        expect(statSync(join(projectDir, nested)).isDirectory()).toBe(true);
      }
      expect(mode).toBe(
        target === `${KNOWLEDGE_MOUNT_TARGET}/${KNOWLEDGE_INSIGHTS_DIR}` ? undefined : 'ro',
      );
    }
  });

  it('keeps every mount source under the data root the volume is resolved from', () => {
    // Both paths are handed to the provisioner's mount partitioner, which turns a
    // path under the data volume root into a named-volume subpath and leaves
    // anything else a host bind. A source that drifts out of the data root stops
    // being a subpath, silently becomes a host bind, and resolves to nothing on
    // the host daemon of a volume-based deployment.
    for (const bind of knowledgeSandboxBinds(dataRoot, 'p-1')) {
      const { host } = parseBind(bind);
      const rel = relative(knowledgeRootDir(dataRoot), host);
      expect(rel).not.toBe('');
      expect(rel.startsWith('..')).toBe(false);
    }
  });

  it('creates the folder an entry point writes into, and is idempotent', async () => {
    const dir = await ensureProjectKnowledge(dataRoot, 'p-1');
    writeFileSync(join(dir, KNOWLEDGE_DOCUMENTS_DIR, 'Angebot.pdf'), 'kept');
    const afterFirst = readdirSync(dir).sort();

    // Provisioning calls this on every pass, including passes over a folder that
    // already holds material. A non-idempotent `ensure` would take the operator's
    // files with it and leave nothing behind to notice.
    await ensureProjectKnowledge(dataRoot, 'p-1');

    for (const sub of PROJECT_KNOWLEDGE_SUBDIRS) {
      expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
    }
    expect(readdirSync(dir).sort()).toEqual(afterFirst);
    expect(readFileSync(join(dir, KNOWLEDGE_DOCUMENTS_DIR, 'Angebot.pdf'), 'utf8')).toBe('kept');
    expect(dir).toBe(projectKnowledgeDir(dataRoot, 'p-1'));
  });

  it('migrates the legacy folders without losing their files', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    mkdirSync(join(dir, 'imports'), { recursive: true });
    mkdirSync(join(dir, 'meetings'), { recursive: true });
    mkdirSync(join(dir, 'notes/wiki'), { recursive: true });
    writeFileSync(join(dir, 'imports', 'source.pdf'), 'source');
    writeFileSync(join(dir, 'meetings', 'sync.md'), 'meeting');
    writeFileSync(join(dir, 'notes/wiki', 'decision.md'), 'insight');

    await ensureProjectKnowledge(dataRoot, 'p-1');

    expect(readFileSync(join(dir, 'sources/documents/source.pdf'), 'utf8')).toBe('source');
    expect(readFileSync(join(dir, 'sources/meetings/sync.md'), 'utf8')).toBe('meeting');
    expect(readFileSync(join(dir, 'insights/wiki/decision.md'), 'utf8')).toBe('insight');
    expect(statSync(join(dir, 'insights')).mode & 0o777).toBe(0o777);
    expect(statSync(join(dir, 'insights/wiki')).mode & 0o777).toBe(0o777);
    expect(statSync(join(dir, 'insights/wiki/decision.md')).mode & 0o666).toBe(0o666);
  });

  it('tolerates concurrent ensures while legacy folders are migrated', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    mkdirSync(join(dir, 'imports'), { recursive: true });
    writeFileSync(join(dir, 'imports/source.pdf'), 'source');

    await Promise.all(Array.from({ length: 8 }, () => ensureProjectKnowledge(dataRoot, 'p-1')));

    expect(readFileSync(join(dir, 'sources/documents/source.pdf'), 'utf8')).toBe('source');
  });

  it('merges legacy folders into an existing layout without losing collisions', async () => {
    const dir = projectKnowledgeDir(dataRoot, 'p-1');
    mkdirSync(join(dir, 'imports/nested'), { recursive: true });
    mkdirSync(join(dir, 'sources/documents/nested'), { recursive: true });
    mkdirSync(join(dir, '.text/imports/nested'), { recursive: true });
    mkdirSync(join(dir, '.text/sources/documents/nested'), { recursive: true });
    writeFileSync(join(dir, 'imports/nested/reference.md'), 'legacy');
    writeFileSync(join(dir, 'sources/documents/nested/reference.md'), 'current');
    writeFileSync(join(dir, '.text/imports/nested/reference.md.md'), 'legacy extracted');
    writeFileSync(join(dir, '.text/sources/documents/nested/reference.md.md'), 'current extracted');
    writeFileSync(join(dir, 'imports/other.md'), 'other');

    await ensureProjectKnowledge(dataRoot, 'p-1');

    expect(readFileSync(join(dir, 'sources/documents/nested/reference.md'), 'utf8')).toBe(
      'current',
    );
    expect(readFileSync(join(dir, 'sources/documents/nested/reference.md.legacy-1'), 'utf8')).toBe(
      'legacy',
    );
    expect(
      readFileSync(join(dir, '.text/sources/documents/nested/reference.md.legacy-1.md'), 'utf8'),
    ).toBe('legacy extracted');
    expect(readFileSync(join(dir, '.text/sources/documents/nested/reference.md.md'), 'utf8')).toBe(
      'current extracted',
    );
    expect(readFileSync(join(dir, 'sources/documents/other.md'), 'utf8')).toBe('other');
  });

  it('classifies legacy flat Shared entries as source documents', async () => {
    const shared = sharedKnowledgeDir(dataRoot);
    mkdirSync(join(shared, '.text'), { recursive: true });
    writeFileSync(join(shared, 'reference.pdf'), 'source');
    writeFileSync(join(shared, '.text/reference.pdf.md'), 'extracted');

    await ensureSharedKnowledge(dataRoot);

    expect(readFileSync(join(shared, 'sources/documents/reference.pdf'), 'utf8')).toBe('source');
    expect(readFileSync(join(shared, '.text/sources/documents/reference.pdf.md'), 'utf8')).toBe(
      'extracted',
    );
  });

  it('does not reclassify new Shared root files after the legacy migration', async () => {
    const shared = await ensureSharedKnowledge(dataRoot);
    writeFileSync(join(shared, 'new-upload.md'), 'new');

    await ensureSharedKnowledge(dataRoot);

    expect(readFileSync(join(shared, 'new-upload.md'), 'utf8')).toBe('new');
  });

  it('migrates Shared legacy folders and their extracted text together', async () => {
    const shared = sharedKnowledgeDir(dataRoot);
    mkdirSync(join(shared, 'imports'), { recursive: true });
    mkdirSync(join(shared, '.text/imports'), { recursive: true });
    writeFileSync(join(shared, 'imports/reference.pdf'), 'source');
    writeFileSync(join(shared, '.text/imports/reference.pdf.md'), 'extracted');

    await ensureSharedKnowledge(dataRoot);

    expect(readFileSync(join(shared, 'sources/documents/reference.pdf'), 'utf8')).toBe('source');
    expect(readFileSync(join(shared, '.text/sources/documents/reference.pdf.md'), 'utf8')).toBe(
      'extracted',
    );
  });

  it('refuses a project id that would leave the knowledge root', () => {
    // `join` would resolve these quietly into some other directory — the
    // secrets root, a sibling project's folder — and the mount would work.
    for (const id of ['../secrets', 'p-1/../../etc', '/etc', '..', '']) {
      expect(() => projectKnowledgeDir(dataRoot, id)).toThrow(/invalid project id/);
    }
  });

  it('refuses a project id that would collide with the shared folder', () => {
    // A project whose id was the shared folder's name would mount the whole
    // shared folder as its own and receive every other project's material.
    const sharedName = relative(knowledgeRootDir(dataRoot), sharedKnowledgeDir(dataRoot));
    expect(() => projectKnowledgeDir(dataRoot, sharedName)).toThrow(/invalid project id/);
  });

  it('emits no binds when the deployment has no data root', () => {
    expect(knowledgeSandboxBinds(undefined, 'p-1')).toEqual([]);
    expect(knowledgeSandboxBinds('', 'p-1')).toEqual([]);
  });
});
