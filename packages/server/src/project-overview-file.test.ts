import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rename } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
import { PROJECT_MEMORY_MAX_CHARS } from '@verity/store';

import { OVERVIEW_FILE_NAME, projectKnowledgeDir } from './knowledge-folder.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import {
  appendProjectOverview,
  projectMemoryRevision,
  replaceProjectOverview,
  readOrMigrateProjectOverview,
  readProjectOverview,
} from './project-overview-file.js';

describe('project overview file', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'verity-overview-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('edits authoritative Memory with revision checks and keeps clearing authoritative', async () => {
    await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy fact');
    const saved = await replaceProjectOverview(
      dataRoot,
      'project',
      projectMemoryRevision('Legacy fact'),
      'Edited fact',
    );
    expect(await readProjectOverview(dataRoot, 'project')).toBe('Edited fact');
    await appendProjectOverview(dataRoot, 'project', 'Concurrent fact');
    await expect(
      replaceProjectOverview(dataRoot, 'project', saved.revision, 'Stale overwrite'),
    ).rejects.toThrow(/changed/);
    const current = (await readProjectOverview(dataRoot, 'project'))!;
    await replaceProjectOverview(dataRoot, 'project', projectMemoryRevision(current), '');
    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy fact'),
    ).toBeUndefined();
  });

  it('serializes simultaneous appends without losing either fact', async () => {
    await Promise.all([
      appendProjectOverview(dataRoot, 'project', 'First fact'),
      appendProjectOverview(dataRoot, 'project', 'Second fact'),
    ]);

    const body = readFileSync(
      join(projectKnowledgeDir(dataRoot, 'project'), OVERVIEW_FILE_NAME),
      'utf8',
    );
    expect(body).toBe('First fact\nSecond fact\n');
    expect(await readProjectOverview(dataRoot, 'project')).toBe('First fact\nSecond fact');
  });

  it('holds the Explorer lock between revision checking and atomic replacement', async () => {
    await appendProjectOverview(dataRoot, 'project', 'Original fact');
    const root = projectKnowledgeDir(dataRoot, 'project');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let signalRename!: () => void;
    let releaseRename!: () => void;
    const reachedRename = new Promise<void>((resolve) => {
      signalRename = resolve;
    });
    const allowRename = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      signalRename();
      await allowRename;
      await actual.rename(from, to);
    });
    const replacement = replaceProjectOverview(
      dataRoot,
      'project',
      projectMemoryRevision('Original fact'),
      'Settings fact',
    );
    await reachedRename;
    let explorerFinished = false;
    const explorer = acquireKnowledgeMutationLock(root).then((release) => {
      try {
        writeFileSync(join(root, OVERVIEW_FILE_NAME), 'Explorer fact\n');
        explorerFinished = true;
      } finally {
        release();
      }
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(explorerFinished).toBe(false);
    } finally {
      releaseRename();
      await Promise.all([replacement, explorer]);
    }
    expect(await readProjectOverview(dataRoot, 'project')).toBe('Explorer fact');
  });

  it('does not create content for a blank append', async () => {
    expect(await appendProjectOverview(dataRoot, 'project', '  ')).toBe(0);
    expect(await readProjectOverview(dataRoot, 'project')).toBeUndefined();
  });

  it('reads non-ASCII guidance using the same character limit as writes', async () => {
    const guidance = '資'.repeat(Math.min(PROJECT_MEMORY_MAX_CHARS, 1_000));
    await appendProjectOverview(dataRoot, 'project', guidance);

    expect(await readProjectOverview(dataRoot, 'project')).toBe(guidance);
  });

  it('migrates guidance at the exact character limit', async () => {
    const guidance = 'x'.repeat(PROJECT_MEMORY_MAX_CHARS);
    expect(await readOrMigrateProjectOverview(dataRoot, 'project', async () => guidance)).toBe(
      guidance,
    );
    expect(await readProjectOverview(dataRoot, 'project')).toBe(guidance);
  });

  it('does not inject an oversized file into a fresh session', async () => {
    await appendProjectOverview(dataRoot, 'project', 'kept');
    writeFileSync(
      join(projectKnowledgeDir(dataRoot, 'project'), OVERVIEW_FILE_NAME),
      'x'.repeat(PROJECT_MEMORY_MAX_CHARS + 1),
    );

    expect(await readProjectOverview(dataRoot, 'project')).toBeUndefined();
  });

  it('does not restore legacy guidance after the migrated file is deleted', async () => {
    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy guidance'),
    ).toBe('Legacy guidance');
    rmSync(join(projectKnowledgeDir(dataRoot, 'project'), OVERVIEW_FILE_NAME));

    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy guidance'),
    ).toBeUndefined();
  });

  it('marks an existing overview authoritative before it is deleted', async () => {
    await appendProjectOverview(dataRoot, 'project', 'File guidance');
    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy guidance'),
    ).toBe('File guidance');
    rmSync(join(projectKnowledgeDir(dataRoot, 'project'), OVERVIEW_FILE_NAME));

    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy guidance'),
    ).toBeUndefined();
  });

  it('treats an intentionally empty overview as authoritative', async () => {
    await appendProjectOverview(dataRoot, 'project', 'temporary');
    writeFileSync(join(projectKnowledgeDir(dataRoot, 'project'), OVERVIEW_FILE_NAME), '');
    expect(
      await readOrMigrateProjectOverview(dataRoot, 'project', async () => 'Legacy guidance'),
    ).toBeUndefined();
    expect(await readProjectOverview(dataRoot, 'project')).toBeUndefined();
  });
});
