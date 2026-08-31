import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import type { Readable } from 'node:stream';
import type { Spawner } from './backend-contract.js';
import {
  PROCESS_TREE_KILL_GRACE_MS,
  collectEscapedProcessTree,
  processStartTime,
  signalProcessTree,
} from './process-tree.js';

/**
 * The process-spawn seam every backend runs its agent through (concept §5a), plus
 * the §5b permission-posture invariant on the argv it is given. Backend-neutral by
 * construction: the Claude stream-json runner that used to live here went with the
 * native transport (ADR 0012), so what remains is the spawn primitive itself —
 * detached process group, bounded stderr, optional held-open stdin — which ACP,
 * Codex, and OpenCode all sit on top of.
 */

/**
 * Permission modes that do NOT skip the permission system (§5b). Single source
 * of truth: the server's turn-body enum derives from this same tuple, so the
 * HTTP 400 and the spawn-time invariant can never drift apart.
 */
export const ALLOWED_PERMISSION_MODES = ['auto', 'default', 'plan', 'acceptEdits'] as const;

/** Cap on retained stderr (keep the most recent bytes for diagnostics). */
const STDERR_CAP_BYTES = 16 * 1024;

async function* readStrings(readable: Readable): AsyncGenerator<string> {
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    yield typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
}

function exitCodeFromClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signum = constants.signals[signal] ?? 0;
    return signum > 0 ? 128 + signum : 1;
  }
  return 1;
}

/**
 * Signal the child's WHOLE process tree, not just the direct child. The child is
 * spawned {@link https://nodejs.org/api/child_process.html#optionsdetached detached},
 * so it leads its own group (its pid == the group id) and a negative-pid signal reaches
 * every descendant — the shells, `git`, and editors the agent spawned. Without this,
 * signalling only the direct process orphans those grandchildren, which keep writing to
 * the worktree after the turn is torn down (the duplicate-process race on engine
 * handover).
 *
 * The group signal alone is NOT sufficient: an agent backend starts each Bash tool call
 * through `setsid`, which leaves the group, so the heavyweight tool processes are
 * precisely the ones a `kill(-pid)` misses. {@link collectEscapedProcessTree} finds them over
 * `/proc` and they are signalled first, then escalated — see `process-tree.ts` for why
 * both mechanisms are kept.
 *
 * Never throws: a group already gone (`ESRCH`) or a kill racing a natural exit is a
 * normal no-op, and we still fall back to a direct child signal.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  // Only signal the GROUP while Node still sees the child as running. Once it has been
  // reaped (`exitCode`/`signalCode` set), the OS may have recycled its pid onto an
  // unrelated process-group leader on this host — and a successful `process.kill(-pid)`
  // to the wrong group throws nothing, so the catch below would not save us. In that
  // window fall through to `child.kill`, which Node makes a safe no-op on a dead child.
  const running = child.exitCode === null && child.signalCode === null;
  if (pid === undefined || !running) {
    try {
      child.kill(signal);
    } catch {
      // Child already dead.
    }
    return;
  }
  // Captured BEFORE anything is signalled: a SIGTERM'd shell tears its own children
  // down, and a tree walked afterwards would be missing exactly what we mean to reach.
  // Only the pids that LEFT the group, so the escalation below cannot hard-kill an
  // in-group helper out from under an agent that is still inside its own grace.
  let rootStartTime = '';
  try {
    rootStartTime = processStartTime(pid);
  } catch {
    // Root exited before its identity could be captured.
  }
  const escaped = collectEscapedProcessTree(pid);
  signalProcessTree(escaped, signal);
  let rootIdentityMatches = true;
  if (rootStartTime !== '') {
    try {
      rootIdentityMatches = processStartTime(pid) === rootStartTime;
    } catch {
      rootIdentityMatches = false;
    }
  }
  if (rootIdentityMatches) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Group gone / not permitted — fall through to signalling the child directly.
      try {
        child.kill(signal);
      } catch {
        // Child already dead.
      }
    }
  }
  // Nothing survives SIGKILL, and an empty capture has nothing to escalate: in both
  // cases a timer would only be a handle holding pids the kernel is free to recycle.
  if (signal === 'SIGKILL' || escaped.size === 0) return;
  // Escalate the ESCAPED subtree only. The agent process keeps whatever grace its
  // caller grants it (acp-backend runs a cooperative cancel first and escalates on its
  // own clock); a tool tree whose turn is already over has nothing left to flush, and
  // it is the one that keeps burning the sandbox's memory if SIGTERM is ignored.
  //
  // Deliberately NOT unref'd. Host shutdown is exactly when a surviving tool tree costs
  // the most — it outlives the process that was supposed to reap it — so this timer is
  // allowed to hold the event loop for its one second. The guard above keeps that from
  // being a per-turn tax: a teardown with nothing escaped schedules nothing at all.
  setTimeout(() => {
    signalProcessTree(escaped, 'SIGKILL');
  }, PROCESS_TREE_KILL_GRACE_MS);
}

/** The real spawner: a detached-stdin child process whose stdout is piped. */
export const nodeSpawner: Spawner = (command, args, options) => {
  // stdin: `/dev/null` when the caller feeds the child nothing (the whole prompt
  // rides on argv); a pipe when there is an initial payload to write or the caller
  // holds the channel open. stderr is piped and drained into a bounded buffer so it
  // can't block the child while staying available for diagnostics.
  const keepOpen = options.keepStdinOpen === true;
  const feedStdin = options.stdin !== undefined || keepOpen;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [feedStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // Give the child its own process group (session leader) so {@link killProcessGroup}
    // can tear down its entire subprocess tree with one negative-pid signal. NOT
    // `unref`'d: the parent still tracks the child and waits on its exit as before.
    detached: true,
  });
  if (child.stdout === null) {
    throw new Error('spawned process has no stdout pipe');
  }
  // Tracks whether the child's stdin is still writable. In streaming mode (#101)
  // it stays open after the initial write so the conductor can inject further
  // user messages; otherwise we close it right away.
  let stdinOpen = false;
  const childStdin = child.stdin;
  if (feedStdin) {
    if (childStdin === null) {
      throw new Error('spawned process has no stdin pipe');
    }
    // An EPIPE (child died before reading) must not crash the control-plane — it
    // surfaces via the exit code / stderr instead.
    childStdin.on('error', () => undefined);
    if (keepOpen) {
      // Streaming-input mode: write the initial payload but KEEP stdin open so the
      // caller can stream more messages mid-turn (ACP's JSON-RPC channel, steering
      // injections, #101).
      stdinOpen = true;
      if (options.stdin !== undefined) childStdin.write(options.stdin);
    } else {
      // One-shot: write and close (EOF) so a print-mode child processes the single
      // payload and exits.
      childStdin.end(options.stdin);
    }
  }
  const stdout = child.stdout;
  stdout.setEncoding('utf8');

  let stderrTail = '';
  if (child.stderr !== null) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_CAP_BYTES);
    });
  }

  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve(exitCodeFromClose(code, signal));
    });
  });
  // A spawn failure (`ENOENT` for a missing agent binary OR a missing `cwd`,
  // `EACCES`, …) rejects `exited` ASYNCHRONOUSLY — and a caller typically attaches
  // its `await proc.exited` consumer only AFTER it has drained stdout, so the
  // rejection can land first with no handler. That unhandledRejection crashes the
  // whole control-plane (one dead worktree → every session down). Attach a no-op
  // handler at creation so the early rejection is always "handled"; the real
  // consumer still receives the error via its own independent `await` and fails
  // just that turn.
  exited.catch(() => undefined);

  return {
    stdout: readStrings(stdout),
    pid: child.pid,
    exited,
    stderr: () => stderrTail,
    kill: (signal) => {
      killProcessGroup(child, signal);
    },
    writeStdin: (data: string): boolean => {
      if (!stdinOpen || childStdin === null || childStdin.destroyed || !childStdin.writable) {
        return false;
      }
      // The backpressure return is ignored: the chunk is buffered and flushed
      // regardless, so a successful enqueue counts as delivered.
      childStdin.write(data);
      return true;
    },
    closeStdin: (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      if (childStdin !== null && !childStdin.destroyed) {
        try {
          childStdin.end();
        } catch {
          // Child already gone — EOF is moot.
        }
      }
    },
  };
};

/**
 * §5b invariant guard on the resulting permission posture (not a token
 * denylist): rejects any flag that signals skipping/bypassing permissions or
 * the sandbox (in any `--flag` or `--flag=value` form). Fails loudly before spawn.
 *
 * The flag scan is deliberately agent-agnostic. "dangerous", "bypass" and
 * "skip-perm" name the same intent in every agent Verity spawns — Claude's
 * `--dangerously-skip-permissions` and Codex's
 * `--dangerously-bypass-approvals-and-sandbox` are the same request — so every
 * backend gets it.
 *
 * `allowedModes` is the opposite: a `--permission-mode` VALUE only means
 * something inside one agent's vocabulary (`plan` is Claude's, and says nothing
 * about Codex). Callers pass the vocabulary of the agent actually being spawned,
 * or `undefined` for an agent that states none — which then checks only the
 * agent-agnostic forms above, still rejecting every mode that skips permissions
 * because those spell "bypass" in their own name.
 *
 * REQUIRED, deliberately, rather than defaulted to {@link ALLOWED_PERMISSION_MODES}:
 * a default would let a new call site silently inherit Claude's vocabulary — either
 * validating another agent's modes against the wrong list, or (if the default were
 * `undefined`) dropping the check with no diagnostic. Every caller states which it
 * means, and adding one is a decision the compiler asks for.
 */
export function assertSafeArgs(
  args: readonly string[],
  allowedModes: readonly string[] | undefined,
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const lower = arg.toLowerCase();
    if (lower.includes('dangerous') || lower.includes('bypass') || lower.includes('skip-perm')) {
      throw new Error(
        `refusing to spawn the agent with permission-bypassing arg '${arg}' (§5b invariant)`,
      );
    }
    if (allowedModes === undefined) continue;
    if (lower === '--permission-mode') {
      assertPermissionMode(args[i + 1], allowedModes);
    } else if (lower.startsWith('--permission-mode=')) {
      assertPermissionMode(arg.slice('--permission-mode='.length), allowedModes);
    }
  }
}

function assertPermissionMode(value: string | undefined, allowedModes: readonly string[]): void {
  if (value === undefined || !allowedModes.includes(value)) {
    throw new Error(
      `refusing to spawn the agent with permission mode '${value ?? ''}' (§5b invariant)`,
    );
  }
}
