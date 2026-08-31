import { describe, expect, it, vi } from 'vitest';
import {
  collectEscapedProcessTree,
  collectProcessTree,
  signalProcessTree,
} from './process-tree.js';

/**
 * A synthetic `/proc`. Every line is a real `stat` shape — `comm` in parentheses,
 * `pgrp` at field 5, `starttime` at field 22 — because parsing those two out of a
 * `comm` that itself contains spaces and parentheses is half of what is under test.
 */
function fakeProc(entries: Record<string, string>): (path: string) => string {
  return (path: string): string => {
    const content = entries[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

/** agent 100 → in-group helper 150 → `setsid` shell 200 → vitest 300. */
const TREE: Record<string, string> = {
  '/proc/100/task/100/children': '150 200\n',
  '/proc/150/task/150/children': '',
  '/proc/200/task/200/children': '300\n',
  '/proc/300/task/300/children': '',
  '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
  '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
  '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
  '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
};

describe('collectProcessTree', () => {
  it('records every descendant, deepest first', () => {
    const tree = collectProcessTree(100, { readProc: fakeProc(TREE) });
    // Post-order: a child is recorded only after its own subtree, so signalling in
    // insertion order tears the leaves down before the shells that own them.
    expect([...tree]).toEqual([
      [150, '150'],
      [300, '222'],
      [200, '111'],
    ]);
  });

  it('reads children forked by non-main threads', () => {
    const threaded = {
      ...TREE,
      '/proc/100/task/100/children': '',
      '/proc/100/task/101/children': '200\n',
    };
    expect([
      ...collectProcessTree(100, {
        readProc: fakeProc(threaded),
        readTaskIds: (pid) => (pid === 100 ? [100, 101] : [pid]),
      }),
    ]).toEqual([
      [300, '222'],
      [200, '111'],
    ]);
  });

  it('yields an empty tree where /proc does not exist', () => {
    expect(
      collectProcessTree(100, {
        readProc: () => {
          throw new Error('ENOENT');
        },
      }).size,
    ).toBe(0);
  });

  it('drops a subtree when its parent pid is reused during the walk', () => {
    let childStatReads = 0;
    const readProc = (path: string): string => {
      if (path === '/proc/200/stat') {
        childStatReads += 1;
        return childStatReads === 1
          ? TREE[path]!
          : '200 (replacement) S 1 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0';
      }
      return fakeProc(TREE)(path);
    };

    expect([...collectProcessTree(100, { readProc })]).toEqual([[150, '150']]);
  });

  it('drops the whole capture when the root pid is reused during the walk', () => {
    let rootStatReads = 0;
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat') {
        rootStatReads += 1;
        return rootStatReads === 1
          ? TREE[path]!
          : '100 (replacement) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0';
      }
      return fakeProc(TREE)(path);
    };

    expect(collectProcessTree(100, { readProc }).size).toBe(0);
  });
});

describe('collectEscapedProcessTree', () => {
  it('keeps only the descendants a group signal would miss', () => {
    // 150 shares the agent's group (pgrp 100) and is therefore left to `kill(-100)`
    // and to the agent's own grace. 200/300 called `setsid` and lead their own groups.
    const tree = collectEscapedProcessTree(100, { readProc: fakeProc(TREE) });
    expect([...tree.keys()]).toEqual([300, 200]);
  });

  it('descends THROUGH an in-group child to reach an escaped grandchild', () => {
    // The escape is one level below an in-group shell: dropping 150 from the result
    // must not stop the walk at it, or 300 is never found.
    const tree = collectEscapedProcessTree(100, {
      readProc: fakeProc({
        ...TREE,
        '/proc/100/task/100/children': '150\n',
        '/proc/150/task/150/children': '300\n',
        '/proc/300/stat': '300 (node) R 150 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
      }),
    });
    expect([...tree.keys()]).toEqual([300]);
  });

  it('drops a descendant whose stat line carries no start time', () => {
    // Without a start time there is no fence: at signal time the empty capture would
    // compare equal to the equally empty read of whoever holds that pid by then, and the
    // pid-reuse check would pass for exactly the process whose identity is unknown.
    const truncated = { ...TREE, '/proc/300/stat': '300 (node (v24)) R 200 300 300' };
    const tree = collectEscapedProcessTree(100, { readProc: fakeProc(truncated) });
    expect([...tree.keys()]).toEqual([200]);
  });

  it('does not trust descendants reached through an unfenceable intermediate', () => {
    const tree = collectEscapedProcessTree(100, {
      readProc: fakeProc({
        ...TREE,
        '/proc/200/stat': '200 (short-lived shell) S 100 200 200',
      }),
    });

    expect([...tree.keys()]).toEqual([]);
  });

  it('judges membership by the root pid, not by the group the root reports', () => {
    // `kill(-root)` is what the caller signals, so `root` is the group this has to be
    // complementary to. A root that never led its group makes the two differ, and there
    // the group signal reaches NOTHING — so 150, which merely inherited group 42, is
    // escaped like the rest and must be signalled individually rather than assumed
    // covered. The root's group is irrelevant, but its start time still fences the
    // entire walk against pid reuse.
    const inheritedGroup = {
      ...TREE,
      '/proc/100/stat': '100 (claude) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
    };
    expect([
      ...collectEscapedProcessTree(100, { readProc: fakeProc(inheritedGroup) }).keys(),
    ]).toEqual([150, 300, 200]);
    const withoutAgentStat = { ...TREE };
    delete withoutAgentStat['/proc/100/stat'];
    expect(collectEscapedProcessTree(100, { readProc: fakeProc(withoutAgentStat) }).size).toBe(0);
  });
});

describe('signalProcessTree', () => {
  it('signals every captured pid', () => {
    const kill = vi.fn();
    const tree = collectEscapedProcessTree(100, { readProc: fakeProc(TREE) });
    signalProcessTree(tree, 'SIGKILL', { kill, readProc: fakeProc(TREE) });
    expect(kill.mock.calls).toEqual([
      [300, 'SIGKILL'],
      [200, 'SIGKILL'],
    ]);
  });

  it('refuses a pid the kernel recycled since the walk', () => {
    // `starttime` is the fence: pid 200 exited and its number was handed to somebody
    // else, so the capture no longer entitles anyone to signal it.
    const tree = collectEscapedProcessTree(100, { readProc: fakeProc(TREE) });
    const kill = vi.fn();
    signalProcessTree(tree, 'SIGKILL', {
      kill,
      readProc: fakeProc({
        ...TREE,
        '/proc/200/stat': '200 (sshd) S 1 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0',
      }),
    });
    expect(kill.mock.calls).toEqual([[300, 'SIGKILL']]);
  });

  it('keeps going when a pid disappeared entirely', () => {
    const tree = collectEscapedProcessTree(100, { readProc: fakeProc(TREE) });
    const kill = vi.fn();
    const without300 = { ...TREE };
    delete without300['/proc/300/stat'];
    signalProcessTree(tree, 'SIGTERM', { kill, readProc: fakeProc(without300) });
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM']]);
  });
});
