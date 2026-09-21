import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureProjectKnowledge,
  ensureSharedKnowledge,
  knowledgeSandboxBinds,
  KNOWLEDGE_MOUNT_TARGET,
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
      expect(mode).toBe('ro');
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
    writeFileSync(join(dir, 'imports', 'Angebot.pdf'), 'kept');
    const afterFirst = readdirSync(dir).sort();

    // Provisioning calls this on every pass, including passes over a folder that
    // already holds material. A non-idempotent `ensure` would take the operator's
    // files with it and leave nothing behind to notice.
    await ensureProjectKnowledge(dataRoot, 'p-1');

    for (const sub of PROJECT_KNOWLEDGE_SUBDIRS) {
      expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
    }
    expect(readdirSync(dir).sort()).toEqual(afterFirst);
    expect(readFileSync(join(dir, 'imports', 'Angebot.pdf'), 'utf8')).toBe('kept');
    expect(dir).toBe(projectKnowledgeDir(dataRoot, 'p-1'));
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
