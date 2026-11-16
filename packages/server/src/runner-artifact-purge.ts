import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EventStore } from '@verity/store';

import { candidateRunnerProjectIds } from './embedded-support.js';
import { queueSessionCleanup } from './pending-session-cleanup.js';
import { sandboxPersonTag } from './sandbox-identity.js';
import {
  purgeSessionArtifacts as purgeSessionArtifactFiles,
  type SessionArtifactScope,
} from './session-artifacts.js';

interface PurgeLog {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Remove the backend transcripts a session leaves in runner runtimes: on a backend
 * switch the displaced threads' files, on a session delete a durable cleanup entry
 * covering every runtime that may hold them, people's own sandboxes included.
 */
export function createRunnerArtifactPurge(deps: {
  dataVolumeRoot: string;
  store: Pick<EventStore, 'getSession' | 'getProject' | 'projectSandboxes'>;
  /** Read on use: the Fastify app owning the logger is built after this. */
  log: () => PurgeLog;
  controlPlaneRunner: boolean;
  /** The worktree's path inside the sandbox, shared with the runner's own call. */
  sessionSandboxCwd: (worktree: string) => string;
}) {
  const { dataVolumeRoot, sessionSandboxCwd } = deps;
  const eventStore = deps.store;
  const config = { controlPlaneRunner: deps.controlPlaneRunner };
  return async (
    sessionId: string,
    bindings: readonly { backend: string; backendSessionId: string }[],
    scope: SessionArtifactScope,
    /** A person's sandbox whose runtime holds these bindings' files. */
    personTag?: string,
  ): Promise<void> => {
    try {
      // A delete runs even with no bindings at all: a cold-started claude thread
      // writes `<veritySessionId>.jsonl` before the binding row naming it lands, so
      // a session deleted in that window has a transcript nothing points at. A
      // switch, by contrast, is only ever called with the rows it displaced.
      if (bindings.length === 0 && scope !== 'session-delete') return;
      const session = await eventStore.getSession(sessionId);
      if (session === undefined) {
        // The row is what names the worktree, and without it there is no directory
        // to look in. Reachable rather than defensive: a delete that gave up on a
        // slow purge (`SESSION_ARTIFACT_PURGE_TIMEOUT_MS`) removes the row while
        // this call is still in flight, and the files it was going to take are then
        // left for the startup sweep. Logged because a leak nobody hears about is
        // how the whole class of bug this module fixes went unnoticed for months.
        deps
          .log()
          .warn(
            { sessionId, scope },
            'verity: transcript purge found no session row — leaving its files to the startup sweep',
          );
        return;
      }
      const controlPlaneRunner = config.controlPlaneRunner === true;
      // Only asked when it can change the answer — this runs once per session in the
      // project-delete loop, and the lookup is pure overhead in every deployment
      // without the dedicated control-plane runner.
      const isControlPlaneProject =
        controlPlaneRunner && session.projectId !== null
          ? (await eventStore.getProject(session.projectId))?.kind === 'control_plane'
          : false;
      const runnerProjectIds = new Set(
        personTag !== undefined && session.projectId !== null && scope !== 'session-delete'
          ? [`${personTag}/${session.projectId}`]
          : candidateRunnerProjectIds({
              projectId: session.projectId,
              isControlPlaneProject,
              controlPlaneRunner,
            }),
      );
      if (runnerProjectIds.size === 0) return;

      const sandboxCwd = sessionSandboxCwd(session.worktree);
      const cleanupRoot = join(dataVolumeRoot, 'pending-session-cleanup');
      if (scope === 'session-delete' && session.projectId !== null) {
        // Every person who worked in the session may hold its files in their
        // own sandbox's runtime (ADR 0023 §4).
        for (const sandbox of await eventStore.projectSandboxes.list(session.projectId))
          if (!sandbox.projectDefault)
            runnerProjectIds.add(`${sandboxPersonTag(sandbox.userId)}/${session.projectId}`);
      }
      if (scope === 'session-delete') {
        await queueSessionCleanup(cleanupRoot, {
          sessionId,
          sandboxCwd,
          runnerProjectIds: [...runnerProjectIds],
          // A person's own thread is named without its scope here; its files
          // in that person's runtime are left to the per-sandbox cleanup.
          bindings: bindings.map((binding) => ({
            ...binding,
            backend: binding.backend.split('#')[0] ?? binding.backend,
          })),
        });
        return;
      }

      const removed: string[] = [];
      const absent: string[] = [];
      const absentBound: string[] = [];
      const failed: string[] = [];
      const outsideRuntime: string[] = [];
      const unresolved: string[] = [];
      const unknownBackends = new Set<string>();
      let runtimeSeen = false;
      for (const runnerProjectId of runnerProjectIds) {
        const runtimeDir = join(dataVolumeRoot, 'runners', runnerProjectId);
        // Control sessions may name a historical project with no runner runtime.
        if (!existsSync(runtimeDir)) continue;
        try {
          const purge = await purgeSessionArtifactFiles({
            runtimeDir,
            sandboxCwd,
            bindings,
            sessionId,
            scope,
          });
          removed.push(...purge.removed);
          absent.push(...purge.absent);
          absentBound.push(...purge.absentBound);
          failed.push(...purge.failed);
          outsideRuntime.push(...purge.outsideRuntime);
          if (!purge.runtimeMissing) runtimeSeen = true;
          if (purge.unresolved) unresolved.push(runtimeDir);
          for (const backend of purge.unknownBackends) unknownBackends.add(backend);
        } catch (error) {
          unresolved.push(runtimeDir);
          deps
            .log()
            .warn(
              { err: error, sessionId, runnerProjectId },
              'verity: runner session cleanup remains pending',
            );
        }
      }
      // A path that resolved OUT of the runtime means something planted a symlink in
      // a directory the Sandbox can write. Nothing was deleted — but this is not a
      // cleanup problem, so it gets its own message rather than being read as one.
      if (outsideRuntime.length > 0) {
        deps
          .log()
          .error(
            { sessionId, scope, outsideRuntime },
            'verity: refused a transcript path that resolved outside the runner runtime',
          );
      }
      // All three mean a transcript outlived the row naming it, which is the exact
      // failure this code was written to end — so say so rather than counting a
      // partial purge as a clean one. `unresolved` is the runtime whose file list
      // could not even be built, which returns the same empty result as a session
      // that had nothing there. `absent` rides along for context and does not gate:
      // a session that never ran a claude subagent legitimately produces one, and
      // searching a second candidate runtime produces a full set. It is only worth
      // reading when NOTHING was removed, which is what a wrong `sandboxCwd` or a
      // wrong runtime looks like.
      if (failed.length > 0 || unknownBackends.size > 0 || unresolved.length > 0) {
        deps.log().warn(
          {
            sessionId,
            scope,
            runnerProjectIds: [...runnerProjectIds],
            removed: removed.length,
            absent: absent.length,
            failed,
            unresolved,
            unknownBackends: [...unknownBackends],
          },
          'verity: backend transcripts outlived the session state naming them',
        );
      }
      // Nothing removed, nothing failed, and every path a BINDING named came back
      // absent — from a runtime that is actually there. That is the shape of a
      // `sandboxCwd` or a runtime directory derived wrongly: it deletes nothing,
      // reports no error, and would otherwise be indistinguishable from a clean
      // purge. It is also the shape of a session whose files an earlier sweep already
      // collected, which is why it warns rather than errors — but without it the most
      // likely systemic failure in this path is silent.
      //
      // `absentBound`, not `absent`, and only with a runtime present: a delete always
      // resolves the two speculative claude paths, and a project delete tears the
      // runtime down before purging its sessions. Gating on the wider signal would put
      // this line on every OpenCode session delete and every session in a project
      // delete — routine events, both — and a warning that fires on the routine case
      // is not read when the real one arrives.
      if (runtimeSeen && absentBound.length > 0 && removed.length === 0 && failed.length === 0) {
        deps.log().warn(
          {
            sessionId,
            scope,
            runnerProjectIds: [...runnerProjectIds],
            sandboxCwd,
            absent: absentBound.length,
          },
          'verity: found none of a session’s backend transcripts where they should be',
        );
      }
    } catch (error) {
      // Backend switches remain best effort. Deletion must retain the session
      // if its durable cleanup ownership could not be recorded.
      deps
        .log()
        .error(
          { err: error, sessionId, scope },
          'verity: could not purge the backend transcripts of a session',
        );
      if (scope === 'session-delete') throw error;
    }
  };
}
