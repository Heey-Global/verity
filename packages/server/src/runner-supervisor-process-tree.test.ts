import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectEscapedProcessTree, PROCESS_TREE_KILL_GRACE_MS } from '@verity/session';
import {
  killExitedTrustedCliProcessGroup,
  resetProcessTreeWarnings,
  stopAgentProcessGroup,
  collectEscapedProcessTree as brokerCollectEscapedProcessTree,
  PROCESS_TREE_KILL_GRACE_MS as BROKER_PROCESS_TREE_KILL_GRACE_MS,
  trustedCliLaunchSpec,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('launches trusted CLI commands as the agent with a minimal secret-bearing environment', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/fastlane',
        args: ['deliver'],
        cwd: '/work/project',
        secrets: [{ name: 'ASC_PRIVATE_KEY', value: 'private-key-marker' }],
      },
      {
        agentUid: 1000,
        agentGid: 1000,
        env: {
          PATH: '/usr/bin',
          DOPPLER_TOKEN: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('--reuid=1000');
    expect(spec.args).toContain('/usr/local/bin/fastlane');
    expect(spec.spawnOptions.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      LANG: 'C.UTF-8',
      ASC_PRIVATE_KEY: 'private-key-marker',
    });
    expect(spec.spawnOptions.detached).toBe(true);
    for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG']) {
      expect(() =>
        trustedCliLaunchSpec(
          {
            kind: 'trusted-cli',
            command: '/usr/local/bin/fastlane',
            args: ['deliver'],
            cwd: '/work/project',
            secrets: [{ name, value: 'attacker-value' }],
          },
          { agentUid: 1000, agentGid: 1000 },
        ),
      ).toThrow(/unsafe trusted CLI environment variable/u);
    }
  });

  it('kills surviving trusted CLI descendants after the direct child exits', () => {
    const kill = vi.fn();
    killExitedTrustedCliProcessGroup({ pid: 4321 }, kill);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('signals agent descendants that left the process group, then escalates them', () => {
    // The tool trees an agent starts through `setsid` are outside its process group, so
    // `kill(-pid)` alone never reaches them — and they are exactly the ones holding the
    // sandbox's memory. Synthetic /proc: agent 100 → shell 200 → vitest 300.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      // Both escaped descendants, and the group itself.
      expect(kill.mock.calls).toEqual([
        [300, 'SIGTERM'],
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
      kill.mockClear();
      // The agent keeps its caller's grace; only the escaped subtree is escalated.
      vi.advanceTimersByTime(2_000);
      expect(kill.mock.calls).toEqual([
        [300, 'SIGKILL'],
        [200, 'SIGKILL'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to signal a process group recycled while its descendants are walked', () => {
    let rootReads = 0;
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat') {
        rootReads += 1;
        const startTime = rootReads === 1 ? '100' : '999';
        return `100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
      }
      if (path === '/proc/100/task/100/children') return '';
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };

    stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });

    expect(kill).not.toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retains the process-group fallback when root identity is unreadable from the outset', () => {
    const readProc = (path: string): string => {
      if (path === '/proc/100/task/100/children') return '';
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };

    stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });

    expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('refuses to signal a pid the kernel recycled between the walk and the escalation', () => {
    // `starttime` (field 22) is the fence: a descendant that exits and whose pid is
    // reused must not be signalled on the strength of the earlier walk.
    let startTime = '111';
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat')
        return '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0';
      if (path === '/proc/100/task/100/children') return '200\n';
      if (path === '/proc/200/task/200/children') return '';
      if (path === '/proc/200/stat')
        return `200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill).toHaveBeenCalledWith(200, 'SIGTERM');
      kill.mockClear();
      startTime = '999'; // pid 200 is now somebody else.
      vi.advanceTimersByTime(2_000);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves descendants inside the agent group to the group signal', () => {
    // Parity with `collectEscapedProcessTree` in @verity/session: a helper that stayed in
    // the agent's group (pgrp 100) is already reached by `kill(-100)` and is entitled to
    // the agent's own grace, not to the short one an escaped tree is escalated on.
    // Agent 100 → in-group helper 150, and separately the `setsid` shell 200.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
      kill.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(kill.mock.calls).toEqual([[200, 'SIGKILL']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('descends through an in-group child to reach an escaped grandchild', () => {
    // Dropping the in-group helper from the RESULT must not stop the walk at it: the
    // escape usually sits one level below something that never left the group.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150\n',
      '/proc/150/task/150/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/300/stat': '300 (node (v24)) R 150 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [300, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the escalation it had to perform, and stays quiet when it did not', () => {
    // The count `signalProcessTree` returns is the only observability this design has;
    // it is worth nothing if the line never reaches the broker's log.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('SIGKILLed 1 agent tool process(es) that outlived SIGTERM'),
        expect.any(Function),
      );
      stderr.mockClear();
      // A tree that went down on SIGTERM leaves nothing to escalate, and nothing to say.
      delete proc['/proc/200/stat'];
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      vi.advanceTimersByTime(2_000);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
    }
  });

  it('says so when the kernel has no /proc children API to walk', () => {
    // Without CONFIG_CHECKPOINT_RESTORE the walk finds nothing and every teardown looks
    // like a sandbox that had no escaped tool trees — the one failure this whole
    // mechanism cannot otherwise distinguish from success.
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat')
        return '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0';
      throw new Error(`ENOENT: ${path}`);
    };
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // The tell is latched to once per process, so it is order-dependent across a file
    // that tears many synthetic trees down. Start from a known state instead of from
    // whichever test ran first.
    resetProcessTreeWarnings();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('no /proc/<pid>/task/<pid>/children on this kernel'),
        expect.any(Function),
      );
      // ...and only once: a broker on such a kernel tears a tree down every turn.
      stderr.mockClear();
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      resetProcessTreeWarnings();
    }
  });

  it('schedules no escalation when the teardown signal is already SIGKILL', () => {
    // Nothing survives SIGKILL, so a follow-up timer would be a pure leak — and one
    // holding a captured tree of pids the kernel is free to recycle.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGKILL', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGKILL'],
        [-100, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(kill.mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a descendant whose stat line carries no start time', () => {
    // Parity with @verity/session: an empty capture would compare equal to the equally
    // empty read at signal time, so the pid-reuse fence would pass for precisely the
    // process whose identity could not be established.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks /proc exactly like @verity/session does, on the same fixture', () => {
    // The broker cannot import the workspace, so the /proc walk exists twice on purpose.
    // This is the tripwire against the two copies drifting: not the constant alone, but
    // the BEHAVIOUR — which pids each considers escaped, in which order. The fixture is
    // BEHAVIOUR as the broker actually applies it — the walk's result reaching `kill`,
    // in order, with the group signal around it. The walks themselves are compared
    // fixture by fixture in the test below.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '400\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/400/task/400/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
      '/proc/400/stat': '400 (tsc --build) R 150 400 400 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 333 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      // Drop the group signal the broker adds around the walk's own result.
      const brokerOrder = kill.mock.calls
        .map((call) => call[0] as number)
        .filter((pid) => pid !== -100);
      expect(brokerOrder).toEqual([...collectEscapedProcessTree(100, { readProc }).keys()]);
      expect(brokerOrder).toEqual([400, 300, 200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agrees with @verity/session on every edge the two walks could drift on', () => {
    // The walk itself, compared directly rather than through what the broker signalled:
    // pids AND the start times each recorded, over one fixture per axis on which a
    // hand-synced copy realistically diverges. Each fixture also pins the answer, so a
    // change made identically in both copies still has to be argued for rather than
    // just agreed with itself.
    const base: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '400\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/400/task/400/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
      '/proc/400/stat': '400 (tsc --build) R 150 400 400 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 333 0 0',
    };
    const withoutRootStat = { ...base };
    delete withoutRootStat['/proc/100/stat'];
    const fixtures: Array<{
      name: string;
      proc: Record<string, string>;
      expected: [number, string][];
    }> = [
      {
        // A `comm` with a space and parentheses (the `lastIndexOf(')')` parse), an
        // in-group helper skipped but descended through, a grandchild recorded before
        // its parent (post-order).
        name: 'the full tree',
        expected: [
          [400, '333'],
          [300, '222'],
          [200, '111'],
        ],
        proc: base,
      },
      {
        // Without the root's identity, neither copy may trust that its children files
        // still belong to the process whose teardown authorized the walk.
        name: 'no root stat',
        expected: [],
        proc: withoutRootStat,
      },
      {
        // A root that never led its group. `kill(-100)` then reaches nothing at all, so
        // 150 — which merely inherited group 42 — is escaped like the rest and has to be
        // signalled here rather than left to a group signal that will miss it.
        name: 'a root whose group is not its own pid',
        expected: [
          [400, '333'],
          [150, '150'],
          [300, '222'],
          [200, '111'],
        ],
        proc: {
          ...base,
          '/proc/100/stat': '100 (claude) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
          '/proc/150/stat': '150 (mcp-server) S 100 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
        },
      },
      {
        // Neither a short line nor an empty one may yield a fenceable descendant.
        name: 'a truncated stat line (no start time, no comm terminator)',
        expected: [[200, '111']],
        proc: { ...base, '/proc/300/stat': '300 (node (v24)) R 200 300 300', '/proc/400/stat': '' },
      },
      {
        name: 'a root with no children file at all',
        expected: [],
        proc: { '/proc/100/stat': base['/proc/100/stat'] as string },
      },
      { name: 'no /proc at all', expected: [], proc: {} },
    ];
    for (const fixture of fixtures) {
      const readProc = (path: string): string => {
        const content = fixture.proc[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      };
      const broker = [...brokerCollectEscapedProcessTree(100, readProc)];
      expect(broker, `broker vs @verity/session on ${fixture.name}`).toEqual([
        ...collectEscapedProcessTree(100, { readProc }),
      ]);
      expect(broker, `escaped set on ${fixture.name}`).toEqual(fixture.expected);
    }
  });

  it('escalates the escaped subtree on the same grace as @verity/session', () => {
    // The other half of the same tripwire: how long an escaped tree gets before SIGKILL.
    expect(BROKER_PROCESS_TREE_KILL_GRACE_MS).toBe(PROCESS_TREE_KILL_GRACE_MS);
  });
});
