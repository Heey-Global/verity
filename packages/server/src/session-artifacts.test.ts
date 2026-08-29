import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptPath } from '@verity/session';
import { purgeSessionArtifacts, sessionArtifactPaths } from './session-artifacts.js';

/**
 * The bug these cover: a deleted session left its backend transcripts on disk, so the
 * conversation stayed readable — verbatim prompts and replies — after the operator had
 * deleted it. Each test therefore asserts the file is GONE, and that a neighbouring
 * session's file is not.
 */

const SANDBOX_CWD = '/work';

/** The VERITY session id — deliberately unlike any binding id used below, because a
 * `session-delete` resolves claude's paths for it too and the two must be seen apart. */
const VERITY_SESSION_ID = 'ffffffff-0000-0000-0000-0000000000ff';

let runtimeDir: string;

beforeEach(async () => {
  // Realpath'd because the purge resolves its targets before removing them and reports
  // the resolved path; on a platform where the temp root is a symlink the raw
  // `mkdtemp` result would not match what comes back.
  runtimeDir = await realpath(await mkdtemp(join(tmpdir(), 'verity-session-artifacts-')));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

/** Write a codex rollout the way the CLI names and shapes one: dated directory,
 * `-<thread>.jsonl` suffix, and the thread id inside the first record — which is what
 * `codexRolloutFiles` confirms before it agrees the file belongs to the session. */
async function writeRollout(threadId: string, day: string, name?: string): Promise<string> {
  const dir = join(runtimeDir, 'codex-sessions', '2026', '08', day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name ?? `rollout-2026-08-${day}T10-00-00-${threadId}.jsonl`);
  await writeFile(file, `${JSON.stringify({ payload: { id: threadId } })}\n`, 'utf8');
  return file;
}

function claudeTranscriptPath(sessionId: string): string {
  return transcriptPath({
    cwd: SANDBOX_CWD,
    sessionId,
    claudeHome: join(runtimeDir, 'claude'),
  });
}

async function writeClaudeTranscript(sessionId: string): Promise<string> {
  const file = claudeTranscriptPath(sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{"type":"user"}\n', 'utf8');
  return file;
}

/** A subagent transcript, which claude files under the OWNING session's directory — a
 * sibling of that session's `.jsonl`, sharing its stem — but names after the subagent. */
async function writeClaudeSubagent(sessionId: string, agentId: string): Promise<string> {
  const dir = join(claudeTranscriptPath(sessionId).replace(/\.jsonl$/u, ''), 'subagents');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${agentId}.jsonl`);
  await writeFile(file, '{"type":"user"}\n', 'utf8');
  return file;
}

/**
 * The two paths a `session-delete` names for {@link VERITY_SESSION_ID} on top of whatever
 * the bindings resolve to: a cold-started claude thread is opened under the Verity id, so
 * its transcript can be on disk before any binding row names it. They are appended after
 * the bindings' paths, and — unless a test writes them — they are simply absent.
 */
function verityIdPaths(): string[] {
  const file = claudeTranscriptPath(VERITY_SESSION_ID);
  return [file, file.replace(/\.jsonl$/u, '')];
}

/** {@link verityIdPaths} appended to the paths a test's bindings account for. */
function withVerityIdPaths(...paths: string[]): string[] {
  return [...paths, ...verityIdPaths()];
}

describe('sessionArtifactPaths', () => {
  it('collects every rollout of a codex thread, including the restored copy', async () => {
    const first = await writeRollout('thread-a', '18');
    const resumed = await writeRollout('thread-a', '19');
    await mkdir(join(runtimeDir, 'codex-sessions', 'verity-restored'), { recursive: true });
    const restored = join(
      runtimeDir,
      'codex-sessions',
      'verity-restored',
      'rollout-thread-a.jsonl',
    );
    await writeFile(restored, `${JSON.stringify({ payload: { id: 'thread-a' } })}\n`, 'utf8');

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'codex', backendSessionId: 'thread-a' }],
      scope: 'session-delete',
    });

    expect([...paths].sort()).toEqual(withVerityIdPaths(first, resumed, restored).sort());
  });

  it('does not claim a rollout whose thread id merely ends with this one', async () => {
    // `-<id>.jsonl` alone would match `…-x-thread-a.jsonl` for id `thread-a`; the id is
    // re-confirmed inside the file precisely so a delete cannot take a stranger's log.
    const mine = await writeRollout('thread-a', '18');
    await writeRollout('x-thread-a', '18');

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'codex', backendSessionId: 'thread-a' }],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths(mine));
  });

  it('names the claude transcript AND the session’s subagent directory on a delete', async () => {
    // The subagent tree is a sibling of the transcript with the same stem. Naming only
    // the `.jsonl` leaves every subagent's full conversation on disk after the session
    // that spawned them is deleted.
    const file = await writeClaudeTranscript('11111111-2222-3333-4444-555555555555');

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: '11111111-2222-3333-4444-555555555555' }],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths(file, file.replace(/\.jsonl$/u, '')));
  });

  it('names the Verity session id’s claude paths when no binding ever reported one', async () => {
    // The window this closes: claude opens the thread under the Verity id, and the
    // `session_backend_state` row naming it only lands once the backend has reported
    // back. A crash, a cancel, or a delete mid-turn leaves the transcript on disk with
    // nothing pointing at it.
    const file = await writeClaudeTranscript(VERITY_SESSION_ID);

    const { paths, unknownBackends } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [],
      scope: 'session-delete',
    });

    expect(paths).toEqual([file, file.replace(/\.jsonl$/u, '')]);
    expect(unknownBackends).toEqual([]);
  });

  it('names the transcript once when a claude binding reports the Verity id itself', async () => {
    // The common case: the backend confirms the id it was started with. Both sources
    // resolve the same two paths, and a path named twice would be removed twice — the
    // second attempt finding nothing and reporting a phantom `absent`.
    const file = await writeClaudeTranscript(VERITY_SESSION_ID);

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: VERITY_SESSION_ID }],
      scope: 'session-delete',
    });

    expect(paths).toEqual([file, file.replace(/\.jsonl$/u, '')]);
  });

  it('names only the reproducible transcript on a backend switch', async () => {
    // The session lives on, and its subagent transcripts have no other copy anywhere in
    // Verity — the store never sees them. Only the file `materializeToDisk` can write
    // again may go here.
    const file = await writeClaudeTranscript('11111111-2222-3333-4444-555555555555');

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: '11111111-2222-3333-4444-555555555555' }],
      scope: 'backend-switch',
    });

    expect(paths).toEqual([file]);
  });

  it('leaves the Verity session id alone on a backend switch', async () => {
    // The session survives the switch, and the id it is switching TO may well be the
    // Verity id itself — the very transcript the next turn will append to.
    await writeClaudeTranscript(VERITY_SESSION_ID);

    const { paths } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'codex', backendSessionId: 'thread-never-ran' }],
      scope: 'backend-switch',
    });

    expect(paths).toEqual([]);
  });

  it('treats opencode and pi as having no runner-runtime state, not as unknown', async () => {
    const { paths, unknownBackends } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [
        { backend: 'opencode', backendSessionId: 'oc-1' },
        { backend: 'pi', backendSessionId: 'pi-1' },
      ],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths());
    expect(unknownBackends).toEqual([]);
  });

  it('reports a backend it has no entry for instead of skipping it silently', async () => {
    const { paths, unknownBackends } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'some-future-backend', backendSessionId: 'x' }],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths());
    expect(unknownBackends).toEqual(['some-future-backend']);
  });

  it('ignores a binding with no backend session id', async () => {
    const { paths, unknownBackends } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'codex', backendSessionId: '' }],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths());
    expect(unknownBackends).toEqual([]);
  });

  it('yields nothing for a claude id that cannot be a path segment', async () => {
    const { paths, unknownBackends } = await sessionArtifactPaths({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: '../../etc/passwd' }],
      scope: 'session-delete',
    });

    expect(paths).toEqual(withVerityIdPaths());
    expect(unknownBackends).toEqual([]);
  });
});

describe('purgeSessionArtifacts', () => {
  it('deletes both backends of a session and leaves another session untouched', async () => {
    const mineCodex = await writeRollout('thread-mine', '18');
    const theirsCodex = await writeRollout('thread-theirs', '18');
    const mineClaude = await writeClaudeTranscript('aaaaaaaa-0000-0000-0000-000000000001');
    const theirsClaude = await writeClaudeTranscript('bbbbbbbb-0000-0000-0000-000000000002');

    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [
        { backend: 'codex', backendSessionId: 'thread-mine' },
        { backend: 'claude', backendSessionId: 'aaaaaaaa-0000-0000-0000-000000000001' },
      ],
      scope: 'session-delete',
    });

    expect(existsSync(mineCodex)).toBe(false);
    expect(existsSync(mineClaude)).toBe(false);
    expect(existsSync(theirsCodex)).toBe(true);
    expect(existsSync(theirsClaude)).toBe(true);
    // The subagent directory was never created for this session, and this session's claude
    // turn reported an id of its own, so the Verity id names nothing either. All three are
    // absent rather than removed — the two counts are kept apart on purpose.
    expect([...purge.removed].sort()).toEqual([mineCodex, mineClaude].sort());
    expect([...purge.absent].sort()).toEqual(
      [mineClaude.replace(/\.jsonl$/u, ''), ...verityIdPaths()].sort(),
    );
    expect(purge.failed).toEqual([]);
    expect(purge.outsideRuntime).toEqual([]);
  });

  it('takes the subagent transcripts the deleted session spawned', async () => {
    // These are the easiest thing to leave behind: they live in a directory whose name
    // is the session id, but each FILE is named after a subagent the store never saw.
    const own = await writeClaudeTranscript('aaaaaaaa-0000-0000-0000-000000000001');
    const sub = await writeClaudeSubagent(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'agent-aaf1f9539084e629e',
    );
    const neighbour = await writeClaudeSubagent(
      'bbbbbbbb-0000-0000-0000-000000000002',
      'agent-a296c7e9ee23c0eb7',
    );

    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: 'aaaaaaaa-0000-0000-0000-000000000001' }],
      scope: 'session-delete',
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(dirname(dirname(sub)))).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect(purge.failed).toEqual([]);
  });

  it('takes the transcript a crashed session left under the Verity id', async () => {
    // No binding row was ever written — the turn died before the backend reported its id
    // — so the bindings account for nothing and this is the only thing standing between
    // the operator's delete and a readable conversation on disk.
    const own = await writeClaudeTranscript(VERITY_SESSION_ID);
    const sub = await writeClaudeSubagent(VERITY_SESSION_ID, 'agent-aaf1f9539084e629e');
    const neighbour = await writeClaudeTranscript('bbbbbbbb-0000-0000-0000-000000000002');

    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [],
      scope: 'session-delete',
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect([...purge.removed].sort()).toEqual(verityIdPaths().sort());
    expect(purge.failed).toEqual([]);
  });

  it('keeps the subagent transcripts when the session only switches backend', async () => {
    // The session is alive; the operator may switch straight back. Deleting the one copy
    // of its subagents' conversations on a routine, reversible action would be a real
    // loss, while the transcript beside them is re-materialized from the store.
    const own = await writeClaudeTranscript('aaaaaaaa-0000-0000-0000-000000000001');
    const sub = await writeClaudeSubagent(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'agent-aaf1f9539084e629e',
    );

    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: 'aaaaaaaa-0000-0000-0000-000000000001' }],
      scope: 'backend-switch',
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(sub)).toBe(true);
    expect(purge.removed).toEqual([own]);
    expect(purge.failed).toEqual([]);
  });

  it('keeps the Verity session id’s transcript when the session only switches backend', async () => {
    // The session lives on and that id may name the transcript of the backend it is
    // switching TO. Taking it here would delete the conversation the operator is still in.
    const own = await writeClaudeTranscript(VERITY_SESSION_ID);

    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [],
      scope: 'backend-switch',
    });

    expect(existsSync(own)).toBe(true);
    expect(purge.removed).toEqual([]);
    expect(purge.absent).toEqual([]);
    expect(purge.failed).toEqual([]);
  });

  it('refuses a target reached through a symlink out of the runtime', async () => {
    // The runner runtime is writable by the Sandbox, so `projects/<encoded-cwd>` could be
    // swapped for a link. `rm` would not follow a final symlink, but it does follow every
    // directory above it — which is how a purge could be aimed at someone else's files.
    const sessionId = 'dddddddd-0000-0000-0000-000000000004';
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'verity-outside-')));
    try {
      const planted = join(outside, `${sessionId}.jsonl`);
      await writeFile(planted, 'not ours\n', 'utf8');
      const projectsDir = dirname(claudeTranscriptPath(sessionId));
      await mkdir(dirname(projectsDir), { recursive: true });
      await symlink(outside, projectsDir, 'dir');

      const purge = await purgeSessionArtifacts({
        runtimeDir,
        sandboxCwd: SANDBOX_CWD,
        sessionId: VERITY_SESSION_ID,
        bindings: [{ backend: 'claude', backendSessionId: sessionId }],
        scope: 'session-delete',
      });

      expect(existsSync(planted)).toBe(true);
      expect(purge.removed).toEqual([]);
      expect(purge.outsideRuntime).toContain(join(projectsDir, `${sessionId}.jsonl`));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports paths that were never there as absent rather than as removed', async () => {
    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [
        { backend: 'claude', backendSessionId: 'cccccccc-0000-0000-0000-000000000003' },
        { backend: 'codex', backendSessionId: 'thread-never-ran' },
      ],
      scope: 'session-delete',
    });

    // The claude paths are deterministic, so they are named and then found missing; codex
    // resolves by listing, so an absent thread contributes no path at all. Counting the
    // former as `removed` would hide a wrong `sandboxCwd` — the leak this module exists
    // to detect looks exactly like a clean purge otherwise. Four, not two: the binding's
    // pair plus the Verity id's own.
    expect(purge.removed).toEqual([]);
    expect(purge.absent).toHaveLength(4);
    // Two of those four, though: the binding's pair. The Verity id's own pair is a guess
    // this module makes on every delete, so it is reported apart from the paths a binding
    // actually named — see below for what reads that difference.
    expect([...purge.absentBound].sort()).toEqual(
      [
        claudeTranscriptPath('cccccccc-0000-0000-0000-000000000003'),
        claudeTranscriptPath('cccccccc-0000-0000-0000-000000000003').replace(/\.jsonl$/u, ''),
      ].sort(),
    );
    expect(purge.runtimeMissing).toBe(false);
    expect(purge.failed).toEqual([]);
    expect(purge.unknownBackends).toEqual([]);
  });

  it('counts no binding path as absent for a session that kept nothing on the runtime', async () => {
    // An OpenCode-only session: its backend writes nothing here, so the only paths a
    // delete resolves are the two speculative claude ones, and their absence is the
    // expected outcome rather than a sign of anything. The caller logs on `absentBound`
    // for exactly this reason — gating on `absent` would warn about every such delete.
    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'opencode', backendSessionId: 'oc-1' }],
      scope: 'session-delete',
    });

    expect([...purge.absent].sort()).toEqual(verityIdPaths().sort());
    expect(purge.absentBound).toEqual([]);
    expect(purge.runtimeMissing).toBe(false);
  });

  it('reports a runtime that is not there at all rather than a purge that found nothing', async () => {
    // What a project delete leaves behind for its sessions: `deprovision({purge: true})`
    // has already taken `runners/<projectId>`, so every path under it is absent for one
    // uninteresting reason. Distinguishable from a session whose files should have been
    // there and were not.
    const gone = join(runtimeDir, 'runners', 'no-such-project');

    const purge = await purgeSessionArtifacts({
      runtimeDir: gone,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'claude', backendSessionId: 'cccccccc-0000-0000-0000-000000000003' }],
      scope: 'session-delete',
    });

    expect(purge.runtimeMissing).toBe(true);
    expect(purge.removed).toEqual([]);
    expect(purge.absentBound).toHaveLength(2);
  });

  it('leaves the runtime directory itself in place', async () => {
    await writeRollout('thread-only', '18');

    await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'codex', backendSessionId: 'thread-only' }],
      scope: 'session-delete',
    });

    // Only files are removed — never the dated directories, which other sessions' logs
    // still live in.
    expect(await readdir(join(runtimeDir, 'codex-sessions', '2026', '08', '18'))).toEqual([]);
  });

  it('reports an unknown backend so its transcript is not leaked in silence', async () => {
    const purge = await purgeSessionArtifacts({
      runtimeDir,
      sandboxCwd: SANDBOX_CWD,
      sessionId: VERITY_SESSION_ID,
      bindings: [{ backend: 'some-future-backend', backendSessionId: 'x' }],
      scope: 'session-delete',
    });

    expect(purge.unknownBackends).toEqual(['some-future-backend']);
    expect(purge.removed).toEqual([]);
  });
});
