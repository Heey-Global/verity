import { readdirSync, readFileSync } from 'node:fs';

/**
 * Tearing a process GROUP down is not enough to tear an agent turn down. Both agent
 * backends start every Bash tool call through `setsid`, so the shell — and the
 * `vitest`/`eslint`/`tsc` tree under it — leads its own session and its own group.
 * A `kill(-pid)` on the agent's group therefore reaches the agent and its in-group
 * children and misses exactly the processes that hold the memory and the CPU. Those
 * survivors are reparented to the sandbox's init, nothing collects them afterwards,
 * and they keep running (and keep counting against the sandbox's `pidsLimit`) until
 * the container is recreated.
 *
 * The parent/child links in `/proc` survive `setsid`, so a descendant walk finds
 * them. The walk is inherently racy — a process can exit, or fork, while the tree is
 * being captured — which is why the group signal stays alongside it: the two cover
 * each other. Every read here is best-effort and never throws.
 *
 * Only LIVE descendants are found. A tool call that deliberately daemonized (a dev
 * server started with `nohup`, or anything that double-forks) has already reparented to
 * init by the time its shell exited, so it is not in the tree and is not signalled —
 * turn teardown keeps leaving those alone.
 *
 * A backgrounded process whose SHELL is still running is a different case, and this is a
 * real behaviour change for it: it is a descendant, so it goes down with the turn. That
 * covers an agent's background-Bash tool, which holds its `setsid` shell open for as
 * long as the process it started. Such a process used to outlive the turn that started
 * it — as an orphan the agent could no longer read — and now does not. That is the same
 * mechanism as the leak this exists to close; which of the two a given tree is cannot be
 * told apart from `/proc`.
 *
 * `/proc` is Linux-only, and `/proc/<pid>/task/<pid>/children` needs a kernel built with
 * `CONFIG_CHECKPOINT_RESTORE`. Without either, the walk yields an empty tree and teardown
 * degrades to exactly the group signal it has today — silently, because this package has
 * no logging seam. The copy of this walk inside the spawn broker warns once when it finds
 * `/proc` but no children API, and that is where the tell lives for both.
 */

/**
 * SIGTERM → SIGKILL grace for an escaped subtree. Deliberately short, and deliberately
 * shorter than the agent's own escalation (`AGENT_KILL_ESCALATION_MS`, 5 s): by the time
 * this tree is torn down its turn is over, so there is no output left worth waiting for,
 * while the memory it holds is the whole reason the teardown exists.
 *
 * The order matters more than the number. SIGTERM goes first and a second is a long time
 * for a signal handler — `git` unlinks its lock files from `sigchain` on the way out,
 * and a build tool's worst case is a partial artefact that its next run rewrites. What
 * this will not wait for is a process that ignores SIGTERM outright, which is exactly
 * the one worth killing.
 */
export const PROCESS_TREE_KILL_GRACE_MS = 1_000;

/** Read seam. Injectable so the walk is testable against a synthetic `/proc`. */
export interface ProcessTreeOptions {
  readProc?: (path: string) => string;
  readTaskIds?: (pid: number) => number[];
}

const readProcFile = (path: string): string => readFileSync(path, 'utf8');
const readTaskIds = (pid: number): number[] =>
  readdirSync(`/proc/${pid}/task`)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);

/**
 * Fields of `/proc/<pid>/stat` AFTER `comm`, which may itself contain spaces and
 * parentheses — hence the split starting at the LAST `)`. Index 2 is field 5 (`pgrp`),
 * index 19 is field 22 (`starttime`).
 */
function statFields(pid: number, readProc: (path: string) => string): string[] {
  const stat = readProc(`/proc/${pid}/stat`);
  const end = stat.lastIndexOf(')');
  // No `comm` terminator at all means the line is truncated or not a `stat` line.
  // Slicing from 1 anyway would produce a plausible-looking but misaligned field list,
  // and a bogus non-empty `starttime` is worse than none: it defeats the fence quietly
  // in both directions.
  if (end < 0) return [];
  // Trim rather than assume the single space real `/proc` puts after `comm`: a slice
  // that started one character off would shift EVERY index, quietly reading `ppid` as
  // `pgrp` and `utime` as `starttime` — a failure that reports plausible numbers instead
  // of nothing, which is the one thing the `end < 0` guard above exists to avoid.
  return stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
}

/** `starttime` — the fence against pid reuse between the walk and a later signal. */
export function processStartTime(
  pid: number,
  readProc: (path: string) => string = readProcFile,
): string {
  return statFields(pid, readProc)[19] ?? '';
}

/**
 * Depth-first walk of `root`'s descendants, each recorded with its start time so a
 * later signal can refuse a pid the kernel has since recycled. `root` itself is NOT
 * included: its own teardown belongs to the caller (the group signal, or `child.kill`).
 *
 * `keep` decides which descendants are recorded; the walk always descends through the
 * ones it drops, because an in-group shell is exactly how an escaped grandchild is
 * reached.
 *
 * The kernel files a child under the thread that forked it, so every task's `children`
 * file is read. If the task directory cannot be listed, the main-thread path remains a
 * best-effort fallback for older/non-Linux environments and synthetic readers.
 */
function walkProcessTree(
  root: number,
  readProc: (path: string) => string,
  listTaskIds: (pid: number) => number[],
  keep: (fields: string[]) => boolean,
): Map<number, string> {
  const descendants = new Map<number, string>();
  let rootStartTime: string;
  try {
    rootStartTime = processStartTime(root, readProc);
  } catch {
    return descendants;
  }
  // The children files are trustworthy only while `root` still names the process
  // whose teardown authorized this walk.
  if (rootStartTime === '') return descendants;
  const visited = new Set<number>();
  const visit = (parent: number): void => {
    if (visited.has(parent)) return;
    visited.add(parent);
    let taskIds: number[];
    try {
      taskIds = listTaskIds(parent);
    } catch {
      taskIds = [parent];
    }
    const children = new Set<number>();
    for (const taskId of taskIds) {
      try {
        for (const child of readProc(`/proc/${parent}/task/${taskId}/children`)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)) {
          children.add(child);
        }
      } catch {
        // A thread or the whole parent exited mid-walk.
      }
    }
    for (const child of children) {
      try {
        // Fence the recursive read on BOTH sides. The pid came from its parent's
        // `children` file, but it can exit and be reused before or during `visit`.
        // Anything collected below a child whose identity changed may belong to the
        // replacement process, so roll that entire addition back.
        const before = statFields(child, readProc);
        const startTime = before[19] ?? '';
        // No start time means no fence: at signal time an empty capture would compare
        // equal to the empty read of whatever now holds that pid, and the check meant to
        // refuse a recycled pid would wave it through. A descendant whose identity cannot
        // be established is therefore dropped — the group signal still covers it if it
        // never left the group, and an unfenced kill is the one outcome worth avoiding.
        if (startTime === '') continue;
        const alreadyCollected = new Set(descendants.keys());
        visit(child);
        const after = statFields(child, readProc);
        if ((after[19] ?? '') !== startTime) {
          for (const pid of descendants.keys()) {
            if (!alreadyCollected.has(pid)) descendants.delete(pid);
          }
          continue;
        }
        if (keep(after)) descendants.set(child, startTime);
      } catch {
        // It exited while the tree was being captured.
      }
    }
  };
  visit(root);
  try {
    if (processStartTime(root, readProc) !== rootStartTime) descendants.clear();
  } catch {
    descendants.clear();
  }
  return descendants;
}

/** Every live descendant of `root`, keyed by pid, valued by its start time. */
export function collectProcessTree(
  root: number,
  options: ProcessTreeOptions = {},
): Map<number, string> {
  const readProc = options.readProc ?? readProcFile;
  return walkProcessTree(root, readProc, options.readTaskIds ?? readTaskIds, () => true);
}

/** `pgrp` — which process group a `stat` line says its process belongs to. */
function groupIdOf(fields: string[]): string {
  return fields[2] ?? '';
}

/**
 * The descendants of `root` that a `kill(-root)` would MISS — the ones outside process
 * group `root`, which in practice means every `setsid` tool tree. Descendants inside it
 * are excluded on purpose: the group signal already reaches them, and they are entitled
 * to whatever grace their group leader gets rather than to the short one an escaped tree
 * is escalated on.
 *
 * The group is `root`'s pid and NOT the `pgrp` its own `/proc` entry reports, because
 * `-root` is what every caller signals. A detached spawn — which is how both spawners
 * start an agent — makes the two identical. A root that did NOT lead its group is where
 * they diverge, and there the pid is the answer that keeps this set complementary to the
 * group signal: `kill(-root)` reaches nothing at all in that case, so the descendants
 * that merely inherited root's group have to be signalled here rather than assumed
 * covered.
 */
export function collectEscapedProcessTree(
  root: number,
  options: ProcessTreeOptions = {},
): Map<number, string> {
  const readProc = options.readProc ?? readProcFile;
  const rootGroup = String(root);
  return walkProcessTree(
    root,
    readProc,
    options.readTaskIds ?? readTaskIds,
    (fields) => groupIdOf(fields) !== rootGroup,
  );
}

/**
 * Signal a captured tree, skipping any pid whose start time no longer matches.
 *
 * Returns how many pids were actually signalled, for callers that have somewhere to
 * report it. Nothing in this package logs and both in-tree callers discard the count;
 * the copy of this walk inside the spawn broker is where it is used, because that is
 * where a teardown that silently stops reaching anything would go unnoticed.
 */
export function signalProcessTree(
  tree: ReadonlyMap<number, string>,
  signal: NodeJS.Signals,
  options: ProcessTreeOptions & {
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  } = {},
): number {
  const readProc = options.readProc ?? readProcFile;
  const kill =
    options.kill ?? ((pid: number, signalName: NodeJS.Signals) => process.kill(pid, signalName));
  let signalled = 0;
  for (const [pid, startTime] of tree) {
    try {
      if (processStartTime(pid, readProc) !== startTime) continue;
      kill(pid, signal);
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}
