import { constants } from 'node:fs';
import { lstat, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { transcriptPath } from '@verity/session';
import { codexRolloutFiles, RUNNER_CLAUDE_HOME_DIRNAME } from './runner-transcript.js';

/**
 * Deleting a Verity session must delete its conversation, not just its row.
 *
 * The store row goes with the `DELETE`, the durable transcript goes with it by FK
 * cascade, and the worktree is removed alongside at every delete site. What outlived
 * all three is the backend's own file on the shared runner runtime: claude's
 * `<runtime>/claude/projects/<encoded-cwd>/<id>.jsonl`, and codex's
 * `<runtime>/codex-sessions/**\/rollout-*-<thread>.jsonl`. Those files hold the
 * verbatim prompts and model replies. Nothing removed them, so every session ever
 * deleted still had its transcript on disk — in the project this was found on, 483
 * claude transcripts (311 MB) and 2444 codex rollouts (736 MB), the oldest weeks old.
 *
 * Both files are DERIVED: `ServerTranscript`/`ServerCodexTranscript` materialize them
 * back out of the durable store on resume ({@link ../runner-transcript.ts |
 * materializeToDisk}/`restoreIfMissing`). So removing them for a session whose store
 * rows are going away loses nothing that survives the delete anyway — which is why
 * this is safe to do unconditionally, and why it has to happen BEFORE the store
 * delete: the backend session ids that name the files live in `session_backend_state`,
 * which the cascade is about to take.
 */

/** One backend's binding for a session: which backend, and the id it knows the
 * session by. Mirrors a `session_backend_state` row. */
interface SessionBackendBinding {
  backend: string;
  backendSessionId: string;
}

/**
 * Why the artifacts are being removed — which decides how much may go.
 *
 * `session-delete` ends the session: everything it owns is fair game. `backend-switch`
 * keeps it alive and merely re-binds it to another backend, so only files Verity can
 * reproduce may be touched. The distinction is not cosmetic; see the `claude` entry in
 * {@link BACKEND_ARTIFACTS} for the file it protects.
 */
export type SessionArtifactScope = 'session-delete' | 'backend-switch';

export interface SessionArtifactInput {
  /** Server-side host path of the runner runtime: `<dataVolumeRoot>/runners/<projectId>`.
   * Also the containment boundary — nothing outside it is ever removed. */
  runtimeDir: string;
  /** The cwd as the SANDBOX saw it. claude encodes it into its `projects/` folder
   * name, so the host-side path would resolve to a different — empty — directory. */
  sandboxCwd: string;
  bindings: readonly SessionBackendBinding[];
  /**
   * The VERITY session id — not a backend's id for it.
   *
   * A cold-started claude thread is opened under this id (see
   * `EventStore.listLiveBackendSessionIds`), so `projects/<encoded-cwd>/<id>.jsonl`
   * exists from the first turn, while the `session_backend_state` row naming it only
   * lands once the backend has reported back. Delete a session in between — a crash, a
   * cancel, a turn still in flight — and the bindings name nothing while the transcript
   * is on disk. Resolving this id as well is what closes that window; a session whose
   * claude id later diverges is covered by its binding, and the two dedupe.
   *
   * Used on a `session-delete` only. On a `backend-switch` the session lives on and this
   * id may well be the transcript of the backend it is switching TO.
   */
  sessionId: string;
  /** Required rather than defaulted: a caller that has not thought about which of the
   * two cases it is should not silently get the destructive one. */
  scope: SessionArtifactScope;
}

/** Resolve every file one backend left on the runner runtime for one session.
 * Returning nothing is a valid answer and means "this backend keeps no state here".
 * Sync or async: only codex has to read the disk to answer. */
type BackendArtifacts = (
  input: SessionArtifactInput,
  backendSessionId: string,
) => readonly string[] | Promise<readonly string[]>;

/**
 * What claude leaves behind for one id: TWO deterministic paths, both derived from it.
 *
 *   `projects/<encoded-cwd>/<id>.jsonl`             the session's own transcript
 *   `projects/<encoded-cwd>/<id>/subagents/*.jsonl` one file per subagent it spawned
 *
 * The second is easy to miss — the transcript file and the directory are siblings with
 * the same stem — and missing it leaves the subagents' full conversations on disk after
 * the session they belong to is gone. Removing the directory takes the whole tree, so a
 * backend that later adds another per-session subdirectory is covered without a change
 * here.
 *
 * But ONLY when the session itself is going away. The two paths are not equally
 * replaceable: the transcript is re-materialized from the durable store on resume
 * (`materializeToDisk`), while nothing in Verity persists or restores a subagent
 * transcript — those files are the only copy that exists. Deleting them on a
 * `backend-switch`, where the session lives on and the operator may switch straight
 * back, would destroy real history on a routine, reversible action. So a switch takes
 * the reproducible file and leaves the tree; the session's eventual delete is when it
 * goes, and if the switch has by then displaced this binding, the startup sweep collects
 * it once the id stops being live.
 *
 * A standalone function rather than only a table entry because a delete resolves it
 * twice: once per claude binding, and once for the Verity session id, which names a
 * transcript before any binding exists ({@link SessionArtifactInput.sessionId}).
 *
 * A session that never ran a claude turn yields paths that do not exist; the caller
 * reports those as absent rather than counting them removed.
 */
function claudeArtifacts(input: SessionArtifactInput, id: string): string[] {
  let transcript: string;
  try {
    transcript = transcriptPath({
      cwd: input.sandboxCwd,
      sessionId: id,
      claudeHome: join(input.runtimeDir, RUNNER_CLAUDE_HOME_DIRNAME),
    });
  } catch {
    // `transcriptPath` rejects ids that are unsafe as a path segment. An id that cannot
    // name a file never produced one; there is nothing to delete.
    return [];
  }
  if (input.scope === 'backend-switch') return [transcript];
  return [transcript, transcript.replace(/\.jsonl$/u, '')];
}

/**
 * What each backend leaves behind, one entry per value `session_backend_state.backend`
 * can hold. `Conductor.backendKey` (`packages/session/src/conductor.ts`) is the single
 * writer of that column and produces exactly `codex`, `opencode`, or `claude`; `pi` is
 * listed ahead of its backend registration so the file it will or will not write is a
 * decision someone made here rather than an omission.
 *
 * A backend absent from this table is reported by {@link purgeSessionArtifacts} as
 * unknown instead of being silently skipped — the failure mode this whole module
 * exists to fix is exactly a transcript nobody remembered to delete.
 */
const BACKEND_ARTIFACTS: Readonly<Record<string, BackendArtifacts>> = {
  /** See {@link claudeArtifacts}. Named separately because a delete resolves it for the
   * Verity session id too, which no binding has to have reported. */
  claude: (input, backendSessionId) => claudeArtifacts(input, backendSessionId),

  /**
   * Resolved by content, not by name: {@link codexRolloutFiles} filters on the
   * `-<thread>.jsonl` suffix and then confirms the id inside each candidate, so a
   * thread id that happens to be a suffix of another one cannot take a stranger's
   * rollout with it. It returns EVERY rollout of that thread — a resumed thread writes
   * a fresh dated file per run, plus the `verity-restored/` copy Verity materialized —
   * which is the whole set that has to go.
   *
   * A backend switch preserves rollouts. The durable sink is polled, so the final bytes
   * may not have reached the store when the binding changes; deleting here made a
   * reversible model switch lose that tail permanently. Session deletion (or the
   * orphan sweep after the id is no longer live) remains the safe collection boundary.
   *
   * That sink is not a separate condition to check: the rollouts this resolver can find
   * live under `<dataVolumeRoot>/runners/<projectId>`, and a Codex turn only writes there
   * when the runner supervisor is wired — the same branch, `runnerSupervisor` with a
   * `dataVolumeRoot`, that sets `serverManagedTranscript` and installs the sink
   * (`embedded.ts`, `runnerConductorDeps`). A deployment without it runs Codex inside the
   * container, where nothing on the volume is this resolver's to take.
   *
   * This is the one resolver that reads the disk, and it walks the runtime's whole
   * dated archive per binding: deleting a project runs it once per session, serially.
   * The walk is dirents only — the suffix filter runs before any file is opened — and it
   * sits next to quiescing each of those sessions, which costs far more, so the archive
   * is not pre-listed and shared. If a runtime ever holds enough rollouts for the walk
   * to show up next to that, listing once per runtime and matching all bindings against
   * the listing is the shape to reach for.
   */
  codex: async (input, backendSessionId) =>
    input.scope === 'backend-switch'
      ? []
      : await codexRolloutFiles(input.runtimeDir, backendSessionId),

  /**
   * Nothing on the runner runtime. OpenCode moved to ACP under the runner supervisor
   * (ADR 0012 Amendment 4), but unlike Codex it was given no
   * {@link ../runner-transcript.ts | RunnerTranscriptSink}: its conversation exists
   * only in Verity's store (deleted by the cascade) and in OpenCode's own session
   * storage under the agent's XDG data dir — `/run/verity/opencode/data/opencode`,
   * pinned by the spawn broker and created per container start
   * (`verity-agent-spawn-broker.mjs`, `OPENCODE_STATE_DIR`) — which lives in the
   * sandbox container's overlay and dies with the container. That placement is a
   * decision, not an accident: the runner runtime next to it outlives the container,
   * and storing conversations there would leave them behind every deletion this
   * module exists to complete. Its one mounted volume (`provisioner.ts`,
   * `$XDG_CONFIG_HOME/opencode`) is shared credentials and config, not per-session
   * history — deleting from it would break other sessions.
   *
   * So there is nothing under a runner runtime for this to name — not because the
   * directory happened to be absent when someone looked, but because no code path
   * writes one. If OpenCode ever gains a sink, this entry is where its files get named.
   *
   * The key is `opencode`, not `opencode-acp`, and that is not a leftover: these keys
   * are the conductor's backend keys, the strings `Conductor.backendKey` persists in
   * `session_backend_state.backend` (`conductor.ts`). Those did not change with the
   * transport — `opencode-acp` is a `RunnerSupervisorBackend`, a different
   * namespace naming which worker binary runs the turn.
   */
  opencode: () => [],

  /**
   * Reserved, same shape as OpenCode: `/home/dev/.pi` is a shared config volume, and
   * no `pi` backend writes to the runner runtime today. Present so that registering
   * the backend surfaces this file rather than quietly inheriting the unknown path.
   */
  pi: () => [],
};

/** What one session left on disk, and which of its backends this module cannot place. */
export interface SessionArtifacts {
  paths: string[];
  /**
   * The subset of {@link paths} that no binding named — the two claude paths a delete
   * guesses from the Verity session id ({@link SessionArtifactInput.sessionId}).
   *
   * They are a guess by construction: every session that never ran a claude turn has
   * them resolved and finds nothing, which is the expected outcome and not evidence of
   * anything. Kept apart so a caller reading {@link SessionArtifactPurge.absent} for
   * signs of a wrong `sandboxCwd` is not reading a guess that was always going to miss.
   */
  speculative: string[];
  /** Backends bound to the session that {@link BACKEND_ARTIFACTS} has no entry for.
   * Never empty silently — the caller logs these, because an unrecognised backend is
   * a transcript that is about to be leaked. */
  unknownBackends: string[];
}

/** Every on-disk backend artifact belonging to one session, resolved through
 * {@link BACKEND_ARTIFACTS}. */
export async function sessionArtifactPaths(input: SessionArtifactInput): Promise<SessionArtifacts> {
  const paths: string[] = [];
  const speculative: string[] = [];
  const unknownBackends: string[] = [];
  for (const { backend, backendSessionId } of input.bindings) {
    if (backendSessionId.length === 0) continue;
    const resolve = Object.hasOwn(BACKEND_ARTIFACTS, backend)
      ? BACKEND_ARTIFACTS[backend]
      : undefined;
    if (resolve === undefined) {
      if (!unknownBackends.includes(backend)) unknownBackends.push(backend);
      continue;
    }
    paths.push(...(await resolve(input, backendSessionId)));
  }
  // The Verity session id names a claude transcript whether or not a binding row ever
  // caught up with it; see {@link SessionArtifactInput.sessionId} for why that gap
  // exists and why only a delete may act on it. Deduped: the common case is a
  // cold-started thread whose binding reports back this very id.
  if (input.scope === 'session-delete') {
    for (const path of claudeArtifacts(input, input.sessionId)) {
      if (paths.includes(path)) continue;
      paths.push(path);
      // Only what the dedupe did NOT already have: when the binding reports this very id
      // — the common case — the path is a binding's, and its absence would be a real
      // signal rather than a guess that missed.
      speculative.push(path);
    }
  }
  return { paths, speculative, unknownBackends };
}

/** The outcome of a purge, for the caller's log. */
export interface SessionArtifactPurge {
  /** Paths that existed and are now gone. */
  removed: string[];
  /** Paths that were not there to begin with. Counted apart from {@link removed}
   * deliberately: a wrong `sandboxCwd`, or the wrong runner runtime, produces exactly
   * this and would otherwise be indistinguishable from a clean purge — while detecting
   * that leak is the entire point of the module. A binding exists only once its backend
   * has reported a session id, so a named file that is absent is worth a look. */
  absent: string[];
  /**
   * Of {@link absent}, only the paths a binding named — see
   * {@link SessionArtifacts.speculative} for what is left out and why.
   *
   * This is the field to gate a "found nothing where it should have been" alert on.
   * Gating on {@link absent} would fire for every OpenCode-only or Pi-only session
   * delete, and for every session that was deleted before it ever ran a claude turn,
   * because a delete always resolves the speculative pair and those sessions never had
   * the file. An alert that fires on the routine case is not read when the real one
   * arrives.
   */
  absentBound: string[];
  /** Paths that survived the attempt — a genuine leak worth logging. */
  failed: string[];
  /** Paths that resolved outside {@link SessionArtifactInput.runtimeDir} and were left
   * alone. Non-empty means something planted a symlink; see {@link purgeSessionArtifacts}. */
  outsideRuntime: string[];
  /** Backends this module could not place; see {@link SessionArtifacts.unknownBackends}. */
  unknownBackends: string[];
  /**
   * True when {@link SessionArtifactInput.runtimeDir} is not there at all, which makes
   * every path under it absent for one uninteresting reason.
   *
   * An ordinary answer twice over: the caller searches every runtime a session could be
   * under and most sessions are only in one, and a project delete tears the whole
   * runtime down before its sessions are purged. Reported so a caller can tell "the
   * files were not where they should be" from "there was no there".
   */
  runtimeMissing: boolean;
  /** True when {@link sessionArtifactPaths} itself failed, so this purge does not know
   * what it was supposed to delete and every other field is empty for that reason rather
   * than because there was nothing to do. Reported separately because the two are
   * otherwise the same result, and one of them is a leak. */
  unresolved: boolean;
}

/**
 * Whether `candidate` — already resolved through {@link realpath} — is `root` or lives
 * under it. Shared with the startup sweep (`session-artifact-sweep.ts`), which deletes
 * under the same threat model and must draw the boundary the same way.
 *
 * Takes REAL paths: comparing unresolved ones would answer a question about strings
 * rather than about the filesystem, which is precisely the hole a planted symlink walks
 * through.
 */
export function isWithinRealPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a target for deletion, refusing anything that leaves the runtime.
 *
 * `rm` unlinks a final symlink rather than following it, but every INTERMEDIATE
 * component is followed during resolution — and the runner runtime is writable by the
 * sandbox, so `projects/<encoded-cwd>` could be replaced with a link pointing anywhere.
 * Resolving the parent is followed by opening that directory with `O_NOFOLLOW`,
 * validating the opened descriptor, and deleting through `/proc/self/fd/<fd>`. The
 * held directory handle closes the check/use race: replacing any path component after
 * validation cannot redirect the deletion.
 *
 * Returns the resolved path, `'absent'` when there is nothing there, or `'outside'`
 * when it escapes the runtime. `root` is the runtime as `realpath` reports it, resolved
 * once by the caller: it is the boundary every candidate is measured against, so
 * re-resolving it per path would both repeat the work and widen the window in which the
 * boundary could move underneath the comparison.
 */
async function resolveTarget(
  path: string,
  root: string,
): Promise<{ resolved: string; anchored: string; parent: FileHandle } | 'absent' | 'outside'> {
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch {
    // The containing directory is gone — nothing to remove, and nothing that could be
    // inside it.
    return 'absent';
  }
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    return 'absent';
  }
  // Anchor deletion to the directory object we validated, not its mutable path.
  // Re-check the opened descriptor through procfs: an attacker swapping an
  // intermediate component between realpath and open can otherwise redirect the
  // later rm outside the runtime.
  const descriptorPath = `/proc/self/fd/${parentHandle.fd}`;
  let openedParent: string;
  try {
    openedParent = await realpath(descriptorPath);
  } catch {
    await parentHandle.close();
    return 'absent';
  }
  const resolved = join(openedParent, basename(path));
  // The runtime directory itself is never a target, only ever a boundary.
  if (resolved === root || !isWithinRealPath(root, resolved)) {
    await parentHandle.close();
    return 'outside';
  }
  try {
    await lstat(join(descriptorPath, basename(path)));
  } catch {
    await parentHandle.close();
    return 'absent';
  }
  return {
    resolved,
    anchored: join(descriptorPath, basename(path)),
    parent: parentHandle,
  };
}

/**
 * Delete those artifacts. Best-effort per file and never throws: this runs on the
 * delete path, where the store row is about to go regardless, and turning a successful
 * delete into a 500 because one file was already gone would strand the session in the
 * UI. What could not be removed is returned rather than swallowed.
 */
export async function purgeSessionArtifacts(
  input: SessionArtifactInput,
): Promise<SessionArtifactPurge> {
  let resolved: SessionArtifacts;
  try {
    resolved = await sessionArtifactPaths(input);
  } catch {
    return {
      removed: [],
      absent: [],
      absentBound: [],
      failed: [],
      outsideRuntime: [],
      runtimeMissing: false,
      unknownBackends: [],
      unresolved: true,
    };
  }
  // The containment boundary, resolved ONCE for every candidate below rather than per
  // path: it is the same directory each time, and re-resolving it would widen the window
  // in which it could move underneath the comparison. Undefined when the runtime is not
  // there — an ordinary answer, since the caller searches every candidate runtime a
  // session could be under and most sessions are only in one. Every path it would have
  // held is then absent, which is what the old per-path resolution reported too.
  let root: string | undefined;
  try {
    root = await realpath(input.runtimeDir);
  } catch {
    root = undefined;
  }
  const removed: string[] = [];
  const absent: string[] = [];
  const absentBound: string[] = [];
  const failed: string[] = [];
  const outsideRuntime: string[] = [];
  for (const path of resolved.paths) {
    const target = root === undefined ? 'absent' : await resolveTarget(path, root);
    if (target === 'absent') {
      absent.push(path);
      if (!resolved.speculative.includes(path)) absentBound.push(path);
      continue;
    }
    if (target === 'outside') {
      outsideRuntime.push(path);
      continue;
    }
    try {
      // `recursive` is needed for claude's per-session `subagents/` tree, which only a
      // `session-delete` ever names. `force` still absorbs a file that vanished between
      // the check above and here. The same options are what the ephemeral-turn cleanup
      // in `embedded.ts` uses.
      await rm(target.anchored, { recursive: true, force: true });
      removed.push(target.resolved);
    } catch {
      // The RESOLVED path, like `removed` — this is the leak someone will go looking for,
      // and the requested path may name a symlink rather than the file still on disk.
      failed.push(target.resolved);
    } finally {
      await target.parent.close().catch(() => undefined);
    }
  }
  return {
    removed,
    absent,
    absentBound,
    failed,
    outsideRuntime,
    runtimeMissing: root === undefined,
    unknownBackends: resolved.unknownBackends,
    unresolved: false,
  };
}
