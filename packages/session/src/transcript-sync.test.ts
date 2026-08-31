import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TranscriptStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeCwd,
  materializeToDisk,
  readAppended,
  restoreIfMissing,
  syncOnce,
  syncTranscript,
  transcriptPath,
  type TailState,
} from './transcript-sync.js';

let ctx: TestDb;
let transcript: TranscriptStore;
let dir: string;

beforeAll(async () => {
  ctx = await createTestDb();
  transcript = new TranscriptStore(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
  dir = await mkdtemp(join(tmpdir(), 'verity-transcript-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function freshState(): TailState {
  return { offset: 0, pending: Buffer.alloc(0) };
}

describe('encodeCwd / transcriptPath', () => {
  it('encodes a cwd by replacing every slash with a dash', () => {
    expect(encodeCwd('/tmp')).toBe('-tmp');
    expect(encodeCwd('/work')).toBe('-work');
    expect(encodeCwd('/home/dev/foo')).toBe('-home-dev-foo');
  });

  it('collapses every non-alphanumeric character, not just the slash', () => {
    // Verified against Claude Code 2.1.220: running it from /tmp/Pr_Obe.X/Sub-Dir9
    // produces the folder `-tmp-Pr-Obe-X-Sub-Dir9` — letters and digits survive,
    // everything else becomes `-`.
    expect(encodeCwd('/tmp/Pr_Obe.X/Sub-Dir9')).toBe('-tmp-Pr-Obe-X-Sub-Dir9');
    // The case that matters in production: every session worktree is a dot-directory,
    // so a slash-only encoding named a folder claude never writes to.
    expect(encodeCwd('/work/.verity-sessions/agent-1a2b3c4d')).toBe(
      '-work--verity-sessions-agent-1a2b3c4d',
    );
  });

  it('builds the transcript path under <claudeHome>/projects/<encoded>/<id>.jsonl', () => {
    expect(transcriptPath({ cwd: '/work', sessionId: 'abc-123', claudeHome: '/ch' })).toBe(
      '/ch/projects/-work/abc-123.jsonl',
    );
  });

  it('rejects a session id that could escape the projects dir', () => {
    expect(() =>
      transcriptPath({ cwd: '/work', sessionId: '../../etc/passwd', claudeHome: '/ch' }),
    ).toThrow(/invalid session id/);
    expect(() => transcriptPath({ cwd: '/work', sessionId: 'a/b', claudeHome: '/ch' })).toThrow();
  });
});

describe('readAppended', () => {
  it('reads the whole file from offset 0, then only the appended tail', async () => {
    const file = join(dir, 't.jsonl');
    await writeFile(file, 'a\nb\n');
    const first = await readAppended(file, 0);
    expect(first.chunk.toString('utf8')).toBe('a\nb\n');
    expect(first.offset).toBe(4);

    await appendFile(file, 'c\n');
    const second = await readAppended(file, first.offset);
    expect(second.chunk.toString('utf8')).toBe('c\n');
    expect(second.offset).toBe(6);
  });

  it('re-reads from 0 when the file shrank (rewrite / reset)', async () => {
    const file = join(dir, 't.jsonl');
    await writeFile(file, 'long original content\n');
    const big = (await stat(file)).size;
    await writeFile(file, 'x\n'); // rewrite, smaller
    const result = await readAppended(file, big);
    expect(result.chunk.toString('utf8')).toBe('x\n');
    expect(result.offset).toBe(2);
  });

  it('bounds each read even when the unread tail is multi-megabyte', async () => {
    const file = join(dir, 'large.jsonl');
    await writeFile(file, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const first = await readAppended(file, 0);
    expect(first.chunk.length).toBe(1024 * 1024);
    expect(first.offset).toBe(1024 * 1024);
    const second = await readAppended(file, first.offset);
    expect(second.chunk.length).toBe(1024 * 1024);
  });
});

describe('syncOnce', () => {
  it('persists complete lines verbatim and carries a trailing partial', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n{"part'); // last line incomplete
    let state = freshState();
    state = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual(['{"a":1}', '{"b":2}']);
    expect(state.pending.toString('utf8')).toBe('{"part');

    await appendFile(file, 'ial":3}\n');
    state = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual(['{"a":1}', '{"b":2}', '{"partial":3}']);
    expect(state.pending.toString('utf8')).toBe('');
  });

  it('reconstructs a multi-byte UTF-8 char split across two ticks', async () => {
    const file = join(dir, 's1.jsonl');
    // 'é' = 0xC3 0xA9. Write only the lead byte first (no newline).
    await writeFile(file, Buffer.from([0xc3]));
    let state = freshState();
    state = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual([]); // nothing complete yet

    await appendFile(file, Buffer.from([0xa9, 0x0a])); // trailing byte + LF
    await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual(['é']); // faithful, not '��'
  });

  it('REPLACES (not duplicates) the stored transcript when the file is rewritten/compacted', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'old-line-one\nold-line-two\nold-line-three\n');
    let state = freshState();
    state = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual([
      'old-line-one',
      'old-line-two',
      'old-line-three',
    ]);

    // claude compacts → file rewritten SMALLER with new content
    await writeFile(file, 'compacted\n');
    state = await syncOnce(file, state, transcript, 's1');
    // replaced, NOT old1/old2/old3 + compacted
    expect(await transcript.getLines('s1')).toEqual(['compacted']);
    expect(state.pending.toString('utf8')).toBe('');
  });

  it('drops a stale buffered partial on rewrite', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'aaaaaaaaaa\nbbb'); // complete line + partial 'bbb'
    let state = freshState();
    state = await syncOnce(file, state, transcript, 's1');
    expect(state.pending.toString('utf8')).toBe('bbb');

    await writeFile(file, 'x\n'); // rewrite, smaller than the old offset
    state = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual(['x']); // replaced; 'bbb' partial dropped
    expect(state.pending.toString('utf8')).toBe('');
  });

  it('is a no-op when nothing new was appended', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'a\n');
    let state = freshState();
    state = await syncOnce(file, state, transcript, 's1');
    const after = await syncOnce(file, state, transcript, 's1');
    expect(await transcript.getLines('s1')).toEqual(['a']);
    expect(after.offset).toBe(2);
  });
});

describe('syncTranscript (polling loop)', () => {
  it('tails appended lines into the store until aborted', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'line-1\nline-2\n');
    const controller = new AbortController();
    const done = syncTranscript(file, transcript, 's1', { pollMs: 10, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 40));
    await appendFile(file, 'line-3\n');
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await done;
    expect(await transcript.getLines('s1')).toEqual(['line-1', 'line-2', 'line-3']);
  });

  it('survives the file disappearing mid-tail and resumes when it returns', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'a\n');
    const controller = new AbortController();
    const done = syncTranscript(file, transcript, 's1', { pollMs: 10, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    await rm(file); // gone mid-loop — must NOT kill the sync
    await new Promise((r) => setTimeout(r, 30));
    await appendFile(file, 'a\nb\n'); // reappears
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await done;
    expect(await transcript.getLines('s1')).toContain('b'); // resumed
  });

  it('performs the final flush when abort wins before the first poll', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'a\n');
    const controller = new AbortController();
    controller.abort();
    await syncTranscript(file, transcript, 's1', { pollMs: 10, signal: controller.signal });
    expect(await transcript.getLines('s1')).toEqual(['a']);
  });

  it('propagates durable-store failures instead of silently dropping transcript data', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'a\n');
    vi.spyOn(transcript, 'appendLines').mockRejectedValueOnce(new Error('database unavailable'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      syncTranscript(file, transcript, 's1', { signal: controller.signal, rootDir: dir }),
    ).rejects.toThrow('database unavailable');
  });

  it('drains a multi-chunk backlog during the final flush', async () => {
    const file = join(dir, 's1.jsonl');
    const line = 'x'.repeat(600_000);
    await writeFile(file, `${line}\n${line}\n${line}\n`);
    const controller = new AbortController();
    controller.abort();
    await syncTranscript(file, transcript, 's1', { signal: controller.signal, rootDir: dir });
    expect((await transcript.getLines('s1')).map((item) => item.length)).toEqual([
      600_000, 600_000, 600_000,
    ]);
  });

  it('skips bytes before startOffset (resume — prior lines already in the store)', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'prior\nnew\n');
    const controller = new AbortController();
    const done = syncTranscript(file, transcript, 's1', {
      pollMs: 10,
      signal: controller.signal,
      startOffset: 6, // length of 'prior\n'
    });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await done;
    expect(await transcript.getLines('s1')).toEqual(['new']); // 'prior' skipped
  });

  it('final flush captures a line written between the last poll and abort', async () => {
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'a\n');
    const controller = new AbortController();
    const done = syncTranscript(file, transcript, 's1', {
      pollMs: 5000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20)); // first tick persists 'a'
    await appendFile(file, 'last\n'); // written before the (5s-away) next poll
    controller.abort(); // abort triggers the final flush
    await done;
    expect(await transcript.getLines('s1')).toEqual(['a', 'last']);
  });
});

describe('materializeToDisk / restoreIfMissing', () => {
  it('restores beneath an execute-only runtime root without requiring list access', async () => {
    await transcript.appendLines('s1', ['{"db":1}']);
    const file = join(dir, 'projects', '-work', 's1.jsonl');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dir, 0o100);
    try {
      await expect(restoreIfMissing(transcript, 's1', file, { rootDir: dir })).resolves.toBe(true);
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await readFile(file, 'utf8')).toBe('{"db":1}\n');
  });

  it('refuses an ancestor symlink that escapes the declared runtime root', async () => {
    await transcript.appendLines('s1', ['{"db":1}']);
    const outside = await mkdtemp(join(tmpdir(), 'verity-transcript-outside-'));
    await mkdir(join(dir, 'projects'));
    await symlink(outside, join(dir, 'projects', 'cwd'));
    const file = join(dir, 'projects', 'cwd', 'nested', 's1.jsonl');
    try {
      await expect(readAppended(file, 0, dir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        restoreIfMissing(transcript, 's1', file, { rootDir: dir }),
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(
        materializeToDisk(transcript, 's1', file, { rootDir: dir }),
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(access(join(outside, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to read or restore through a transcript symlink', async () => {
    await transcript.appendLines('s1', ['{"db":1}']);
    const outside = join(dir, 'outside.jsonl');
    const file = join(dir, 's1.jsonl');
    await writeFile(outside, 'HOST-SECRET\n');
    await symlink(outside, file);

    await expect(readAppended(file, 0)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(restoreIfMissing(transcript, 's1', file)).rejects.toMatchObject({
      code: 'ELOOP',
    });
    await expect(materializeToDisk(transcript, 's1', file)).resolves.toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('HOST-SECRET\n');
    expect(await readFile(file, 'utf8')).toBe('{"db":1}\n');
  });

  it('writes the durable transcript to disk (0600), reconstructing the .jsonl', async () => {
    await transcript.appendLines('s1', ['{"type":"system"}', '{"type":"result"}']);
    const file = join(dir, 'nested', 's1.jsonl');
    await materializeToDisk(transcript, 's1', file);
    expect(await readFile(file, 'utf8')).toBe('{"type":"system"}\n{"type":"result"}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('enforces 0600 even when the target already exists with looser perms', async () => {
    await transcript.appendLines('s1', ['{"x":1}']);
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'old\n', { mode: 0o644 });
    await materializeToDisk(transcript, 's1', file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('{"x":1}\n');
  });

  it('restores a missing file from the DB and reports it', async () => {
    await transcript.appendLines('s1', ['{"x":1}']);
    const file = join(dir, 's1.jsonl');
    expect(await restoreIfMissing(transcript, 's1', file)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('{"x":1}\n');
  });

  it('does not overwrite an existing file', async () => {
    await transcript.appendLines('s1', ['{"db":1}']);
    const file = join(dir, 's1.jsonl');
    await writeFile(file, 'ON-DISK\n');
    expect(await restoreIfMissing(transcript, 's1', file)).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('ON-DISK\n');
  });

  it('writes nothing when the store holds no transcript (an empty file is a decoy)', async () => {
    // `claude --resume` reads a zero-byte file exactly like a missing conversation,
    // then exits before `system/init` — and the decoy would make every later
    // restore a no-op, so the session could never recover.
    const file = join(dir, 'projects', '-work', 's1.jsonl');
    expect(await materializeToDisk(transcript, 's1', file)).toBe(false);
    expect(await restoreIfMissing(transcript, 's1', file)).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it('restores at the requested path even when a sibling folder holds this session', async () => {
    // A sibling is evidence about some OTHER cwd's encoding, never about the path
    // claude will open for THIS one — skipping on it would leave the only path the
    // CLI reads empty. A redundant copy costs a file; a skipped restore costs the
    // conversation.
    await transcript.appendLines('s1', ['{"db":1}']);
    const projects = join(dir, 'projects');
    const theirs = join(projects, '-somewhere-else', 's1.jsonl');
    await mkdir(dirname(theirs), { recursive: true });
    await writeFile(theirs, '{"cli":1}\n');
    const ours = join(projects, '-work--verity-sessions-agent-1a2b', 's1.jsonl');
    expect(await restoreIfMissing(transcript, 's1', ours)).toBe(true);
    expect(await readFile(ours, 'utf8')).toBe('{"db":1}\n');
    expect(await readFile(theirs, 'utf8')).toBe('{"cli":1}\n');
  });

  it('still restores when the sibling folders hold no transcript for this session', async () => {
    await transcript.appendLines('s1', ['{"db":1}']);
    const projects = join(dir, 'projects');
    await mkdir(join(projects, '-somewhere-else'), { recursive: true });
    await writeFile(join(projects, '-somewhere-else', 'other-session.jsonl'), '{"x":1}\n');
    const file = join(projects, '-work', 's1.jsonl');
    expect(await restoreIfMissing(transcript, 's1', file)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('{"db":1}\n');
  });
});
