// Occasions are what lets the Wiki keep up with a project. The breaks that stay
// green elsewhere: an event that stops recording one (its call removed in a
// refactor), a session deleted without review whose messages are kept anyway,
// and a failing store that takes the user's import or deletion down with it.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { hasProjectWiki, noteDeletedSession, noteWikiOccasion } from './wiki-occasions.js';

type Store = Parameters<typeof noteDeletedSession>[0];

function store(transcript = 'User: Fix it\n\nVerity: Fixed', maintenance = false) {
  const record = vi.fn().mockResolvedValue(true);
  const forgetSession = vi.fn().mockResolvedValue(undefined);
  const sessionTranscript = vi.fn().mockResolvedValue(transcript);
  const value = {
    wikiOccasions: { record, forgetSession, sessionTranscript },
    wikiMaintenance: { isSession: vi.fn().mockResolvedValue(maintenance) },
  } as unknown as Store;
  return { value, record, forgetSession, sessionTranscript };
}

describe('noteDeletedSession', () => {
  const session = { sessionId: 's1', projectId: 'p', name: 'Fix session crash' };

  it('keeps the conversation with an occasion when deleted as done', async () => {
    const { value, record } = store();
    await noteDeletedSession(value, session, true);
    expect(record).toHaveBeenCalledWith({
      projectId: 'p',
      kind: 'session',
      ref: 's1',
      title: 'Fix session crash',
      body: 'User: Fix it\n\nVerity: Fixed',
      reopen: true,
    });
  });

  it('keeps nothing and forgets an earlier occasion without review', async () => {
    const { value, record, sessionTranscript, forgetSession } = store();
    await noteDeletedSession(value, session, false);
    expect(record).not.toHaveBeenCalled();
    expect(sessionTranscript).not.toHaveBeenCalled();
    expect(forgetSession).toHaveBeenCalledWith('p', 's1');
  });

  // Its own run as an occasion would start the next run, and so on.
  it('never keeps the Wiki maintenance session for the Wiki', async () => {
    const { value, record } = store(undefined, true);
    await noteDeletedSession(value, session, true);
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing for an empty conversation or a session outside a project', async () => {
    const { value, record } = store('');
    await noteDeletedSession(value, session, true);
    await noteDeletedSession(value, { ...session, projectId: null }, true);
    expect(record).not.toHaveBeenCalled();
  });

  it('never fails the deletion when the store does', async () => {
    const { value, sessionTranscript } = store();
    sessionTranscript.mockRejectedValue(new Error('down'));
    const warn = vi.fn();
    await expect(noteDeletedSession(value, session, true, { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('lets a deletion go ahead when the store stalls', async () => {
    const { value, sessionTranscript } = store();
    sessionTranscript.mockReturnValue(new Promise(() => undefined));
    const warn = vi.fn();
    await expect(noteDeletedSession(value, session, true, { warn }, 10)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ sessionId: 's1' }, expect.stringContaining('not awaited'));
  });
});

it('never fails the event that caused an occasion', async () => {
  const { value, record } = store();
  record.mockRejectedValue(new Error('down'));
  await expect(
    noteWikiOccasion(value, { projectId: 'p', kind: 'source', ref: 'sources/a.md', title: 'a' }),
  ).resolves.toBeUndefined();
});

// Every kind the table allows must be recorded somewhere in the server, read
// from the sources rather than listed here, so a call lost in a refactor fails.
it('records every kind of occasion somewhere in the server', () => {
  const migration = readFileSync(join(__dirname, '../../store/src/migrations.ts'), 'utf8');
  const kinds = /kind in \(('source'[^)]*)\)\),\n\s*ref text/.exec(migration)?.[1];
  expect(kinds).toBeDefined();
  const sources = readdirSync(__dirname, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(__dirname, file), 'utf8'))
    .join('\n');
  for (const kind of kinds!.split(',').map((value) => value.trim().replace(/'/g, ''))) {
    const recorded =
      kind === 'session'
        ? /noteDeletedSession\(/.test(
            sources.replace(/export async function noteDeletedSession/, ''),
          )
        : new RegExp(`kind: '${kind}'`).test(sources);
    expect(recorded, `no occasion of kind ${kind} is recorded`).toBe(true);
  }
});

describe('hasProjectWiki', () => {
  const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wiki-'));

  it('finds a Wiki by its start page', async () => {
    const dataRoot = root();
    // No knowledge folder at all (an unattached volume) is not "no Wiki".
    await expect(hasProjectWiki(dataRoot, 'p')).rejects.toThrow();
    mkdirSync(join(dataRoot, 'knowledge'));
    expect(await hasProjectWiki(dataRoot, 'p')).toBe(false);
    mkdirSync(join(dataRoot, 'knowledge/p/insights'), { recursive: true });
    writeFileSync(join(dataRoot, 'knowledge/p/insights/index.md'), '# P\n');
    expect(await hasProjectWiki(dataRoot, 'p')).toBe(true);
  });

  // "No Wiki" discards occasions; a folder it cannot read is not that.
  it.skipIf(process.getuid?.() === 0)(
    'fails rather than reporting no Wiki when unreadable',
    async () => {
      const dataRoot = root();
      mkdirSync(join(dataRoot, 'knowledge/p/insights'), { recursive: true });
      chmodSync(join(dataRoot, 'knowledge/p'), 0o000);
      try {
        await expect(hasProjectWiki(dataRoot, 'p')).rejects.toThrow();
      } finally {
        chmodSync(join(dataRoot, 'knowledge/p'), 0o755);
      }
    },
  );
});
