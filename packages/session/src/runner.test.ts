import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_PERMISSION_MODES, assertSafeArgs, nodeSpawner } from './runner.js';

/** Drain a spawned child's stdout to a single string. */
async function collect(stdout: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stdout) out += chunk;
  return out;
}

describe('assertSafeArgs (§5b invariant — permission posture)', () => {
  // The vocabulary a profile that states none passes: spelled out rather than
  // omitted, because `assertSafeArgs` takes it as a REQUIRED argument so that no
  // call site can drop the mode check by accident.
  const NO_VOCABULARY = undefined;

  it('rejects permission-bypassing flags in any form', () => {
    const none = NO_VOCABULARY;
    expect(() => assertSafeArgs(['--dangerously-skip-permissions'], none)).toThrow(/§5b invariant/);
    expect(() => assertSafeArgs(['--dangerously-bypass-approvals-and-sandbox'], none)).toThrow(
      /§5b/,
    );
    expect(() => assertSafeArgs(['--allow-dangerously-skip-permissions'], none)).toThrow(/§5b/);
  });

  it('rejects a permission-skipping mode value (space and = forms)', () => {
    const modes = ALLOWED_PERMISSION_MODES;
    expect(() => assertSafeArgs(['--permission-mode', 'bypassPermissions'], modes)).toThrow(/§5b/);
    expect(() => assertSafeArgs(['--permission-mode=bypassPermissions'], modes)).toThrow(/§5b/);
  });

  it('rejects an unknown permission mode and a missing value (space and = forms)', () => {
    const modes = ALLOWED_PERMISSION_MODES;
    expect(() => assertSafeArgs(['--permission-mode', 'whatever'], modes)).toThrow(/§5b/);
    expect(() => assertSafeArgs(['--permission-mode=whatever'], modes)).toThrow(/§5b/);
    expect(() => assertSafeArgs(['--permission-mode'], modes)).toThrow(/§5b/);
  });

  it('accepts every allowed permission mode', () => {
    for (const mode of ALLOWED_PERMISSION_MODES) {
      expect(() =>
        assertSafeArgs(['--permission-mode', mode], ALLOWED_PERMISSION_MODES),
      ).not.toThrow();
    }
    expect(() =>
      assertSafeArgs(['-p', '--output-format', 'stream-json'], ALLOWED_PERMISSION_MODES),
    ).not.toThrow();
  });

  it('checks the mode value against the vocabulary it was given, not a fixed one', () => {
    // The shared ACP loop spawns every agent, and a `--permission-mode` value only
    // means something inside one agent's vocabulary. Claude's list must not decide
    // whether a Codex mode is legal, and vice versa.
    const codex = ['read-only', 'workspace-write'];
    expect(() => assertSafeArgs(['--permission-mode', 'workspace-write'], codex)).not.toThrow();
    expect(() => assertSafeArgs(['--permission-mode', 'plan'], codex)).toThrow(/§5b/);
    expect(() =>
      assertSafeArgs(['--permission-mode', 'plan'], ALLOWED_PERMISSION_MODES),
    ).not.toThrow();
  });

  it('still rejects the permission-skipping forms for an agent that states no vocabulary', () => {
    // A profile with no declared modes gets no VALUE check — but "bypass" and
    // "dangerous" name the same intent in every agent, so those never depend on it.
    const none = NO_VOCABULARY;
    expect(() => assertSafeArgs(['--permission-mode', 'anything-at-all'], none)).not.toThrow();
    expect(() => assertSafeArgs(['--permission-mode', 'bypassPermissions'], none)).toThrow(/§5b/);
    expect(() => assertSafeArgs(['--dangerously-bypass-approvals-and-sandbox'], none)).toThrow(
      /§5b/,
    );
  });
});

describe('nodeSpawner (real child process, integration)', () => {
  it('pipes a real process stdout end-to-end and reports a clean exit', async () => {
    const proc = nodeSpawner('node', ['-e', `process.stdout.write('hello\\n')`], {
      cwd: process.cwd(),
      env: process.env,
    });
    const out = await collect(proc.stdout);
    await expect(proc.exited).resolves.toBe(0);
    expect(out).toBe('hello\n');
  });

  it('reports a non-zero exit code and captures bounded stderr', async () => {
    const proc = nodeSpawner('node', ['-e', `process.stderr.write('boom diag');process.exit(3)`], {
      cwd: process.cwd(),
      env: process.env,
    });
    await collect(proc.stdout);
    await expect(proc.exited).resolves.toBe(3);
    expect(proc.stderr()).toContain('boom diag');
  });

  it('writes the stdin payload to a real child and closes the pipe (EOF)', async () => {
    // Echo stdin back on stdout so we can assert the child actually received it and
    // saw EOF — the one-shot path writes the payload and closes immediately.
    const script = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write('got:'+s.trim())});`;
    const proc = nodeSpawner('node', ['-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'payload',
    });
    await expect(collect(proc.stdout)).resolves.toBe('got:payload');
    await expect(proc.exited).resolves.toBe(0);
  });

  it('keeps stdin open for streamed messages, then EOFs via closeStdin', async () => {
    // Child echoes one line per newline-delimited stdin message, then a marker on EOF
    // — a minimal streaming-input agent (the shape ACP's JSON-RPC channel needs).
    const script =
      `let buf='';let n=0;` +
      `process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){buf=buf.slice(i+1);n++;process.stdout.write('msg'+n+'\\n');}});` +
      `process.stdin.on('end',()=>{process.stdout.write('eof\\n')});`;
    const proc = nodeSpawner('node', ['-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'first\n',
      keepStdinOpen: true,
    });
    expect(proc.writeStdin?.('second\n')).toBe(true);
    proc.closeStdin?.();
    // Further writes after close are refused (no silent loss into a dead pipe).
    expect(proc.writeStdin?.('third\n')).toBe(false);

    await expect(collect(proc.stdout)).resolves.toBe('msg1\nmsg2\neof\n');
    await expect(proc.exited).resolves.toBe(0);
  });

  it('maps a signal kill to a non-zero exit code (not 0)', async () => {
    const proc = nodeSpawner('node', ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    proc.kill();
    await expect(proc.exited).resolves.toBeGreaterThanOrEqual(128);
  });

  it('rejects exited when the command cannot be spawned', async () => {
    const proc = nodeSpawner('verity-no-such-command-xyz', [], {
      cwd: process.cwd(),
      env: process.env,
    });
    await expect(proc.exited).rejects.toThrow(/ENOENT|spawn/);
  });

  it('does not surface an unhandled rejection when the spawn fails before exited is awaited', async () => {
    // Regression (a dead worktree once took down the whole control-plane): a spawn
    // failure — here a missing `cwd`, the real-world case of a cleaned-up worktree —
    // rejects `exited` ASYNCHRONOUSLY. Callers drain stdout before they await
    // `exited`, so the rejection can land with no consumer attached. Without the
    // keep-alive handler that becomes an unhandledRejection that crashes the host.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const proc = nodeSpawner('node', ['-e', 'process.exit(0)'], {
        cwd: '/verity/definitely/missing/worktree',
        env: process.env,
      });
      // Let the async 'error' fire with NO consumer attached to `exited` yet.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toHaveLength(0); // keep-alive handled the early rejection
      // The real consumer still receives the spawn error.
      await expect(proc.exited).rejects.toThrow(/ENOENT|spawn/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * Spawn an agent-shaped process that puts `grandchildBody` into a DETACHED grandchild
   * — the shape `setsid` gives every Bash tool call — and return once that grandchild
   * has actually reached its own code.
   *
   * The readiness handshake is load-bearing, not hygiene: a grandchild that has been
   * forked but has not yet run its script still carries the DEFAULT signal disposition,
   * so a test about surviving SIGTERM would pass on a process that never installed the
   * handler it is supposed to be proving. It announces itself only afterwards, and the
   * parent forwards that line so both arrive on one stream.
   */
  const spawnEscapedGrandchild = async (
    grandchildBody = '',
  ): Promise<{ proc: ReturnType<typeof nodeSpawner>; grandchildPid: number }> => {
    // `console.log` rather than a `write` with an escape: this source passes through the
    // parent's own string literal, where a `\n` would become a real newline and split it.
    const body = `${grandchildBody};console.log("RDY");setInterval(()=>{},1000)`;
    const script =
      `const {spawn}=require('node:child_process');` +
      `const g=spawn(process.execPath,['-e','${body}'],{detached:true});` +
      `g.stdout.on('data',(d)=>process.stdout.write(d));` +
      `g.unref();` +
      `process.stdout.write('GPID:'+g.pid+'\\n');` +
      `setInterval(()=>{},1000);`;
    const proc = nodeSpawner(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: process.env,
    });
    let grandchildPid: number | undefined;
    let ready = false;
    for await (const chunk of proc.stdout) {
      const match = /GPID:(\d+)/.exec(chunk);
      if (match?.[1] !== undefined) grandchildPid = Number(match[1]);
      if (chunk.includes('RDY')) ready = true;
      if (ready && grandchildPid !== undefined) break;
    }
    expect(ready).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);
    return { proc, grandchildPid: grandchildPid as number };
  };

  /**
   * Poll until the pid stops running, up to `attempts` × 20 ms.
   *
   * `kill(pid, 0)` alone is not the whole answer: where an ancestor is a
   * `PR_SET_CHILD_SUBREAPER` — or the container's init does not reap — a killed
   * grandchild lingers as a zombie and keeps answering signal 0. State `Z` in
   * `/proc/<pid>/stat` (the field after the last `)`) means the process is dead and
   * only its exit status is still there, which is what this is asking about.
   */
  const isRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0] !== 'Z';
    } catch {
      return false; // No /proc entry at all: gone.
    }
  };

  const waitForReaped = async (pid: number, attempts = 200): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      if (!isRunning(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  const forceKill = (pid: number): void => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone — the expected case once the test passed.
    }
  };

  /**
   * These three cover behaviour that only exists where the walk can run: `/proc`, AND a
   * kernel built with `CONFIG_CHECKPOINT_RESTORE`, which is what supplies
   * `/proc/<pid>/task/<pid>/children`. Without either, `process-tree.ts` degrades to the
   * plain group signal by design, so the escape these assert on is expected to survive
   * and the tests would report a design decision as a failure. The probe uses this
   * process, which is by definition alive and has a `/proc` entry.
   */
  const walkUnavailable =
    process.platform !== 'linux' ||
    !existsSync(`/proc/${process.pid}/task/${process.pid}/children`);

  it('runs the teardown tests rather than skipping them, on CI', () => {
    // A skip is the right answer on a developer's macOS laptop and the wrong one in CI,
    // where it would let the whole feature ship green and untested. CI runs on Linux
    // with the children API, so anything else there is a regression in the runner image,
    // not a platform this is expected to degrade on.
    if (process.env.CI === undefined) return;
    expect(walkUnavailable).toBe(false);
  });

  it.skipIf(walkUnavailable)('kill reaches a grandchild that left the process group', async () => {
    // The gap a group signal alone leaves, and the one that actually costs: both agent
    // backends start every Bash tool call through `setsid`, so the shell — and the
    // vitest/eslint tree under it — leads its OWN session and group and `kill(-pid)`
    // never reaches it. Such a grandchild used to survive the turn, reparent to the
    // sandbox's init, and keep holding its memory until the container was recreated.
    const { proc, grandchildPid } = await spawnEscapedGrandchild();
    try {
      // Prove the premise before asserting the fix: the grandchild really is in another
      // process group, so a pass below cannot be the group signal doing the work. Field 5
      // of /proc/<pid>/stat is `pgrp`; `comm` can contain spaces, hence the last `)`.
      const processGroupOf = (pid: number): number => {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]);
      };
      expect(processGroupOf(grandchildPid)).not.toBe(proc.pid);

      proc.kill();
      await proc.exited;

      expect(await waitForReaped(grandchildPid)).toBe(true);
    } finally {
      // Never leave a `setInterval` process behind for the rest of the run, however
      // this test ends.
      forceKill(grandchildPid);
    }
  });

  it.skipIf(walkUnavailable)(
    'leaves a daemon that already reparented to init running',
    async () => {
      // The boundary of the change, and the reason it is a walk of LIVE descendants
      // rather than of a recorded pid list: a tool call that deliberately daemonized —
      // a dev server the agent was asked to leave running — has no living link back to
      // the agent by the time the turn ends, so it is not in the tree and is not
      // signalled. Built here by letting the intermediate process EXIT first, which is
      // exactly how a daemon reparents to init.
      const dir = mkdtempSync(join(tmpdir(), 'verity-runner-daemon-'));
      const pidFile = join(dir, 'daemon.pid');
      const daemonScript = join(dir, 'daemon.js');
      const middleScript = join(dir, 'middle.js');
      writeFileSync(
        daemonScript,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
          `setInterval(()=>{},1000);`,
      );
      writeFileSync(
        middleScript,
        `const {spawn}=require('node:child_process');` +
          `const d=spawn(process.execPath,[${JSON.stringify(daemonScript)}],` +
          `{detached:true,stdio:'ignore'});` +
          `d.unref();`,
      );
      const script =
        `const {spawn}=require('node:child_process');` +
        `const m=spawn(process.execPath,[${JSON.stringify(middleScript)}],{stdio:'ignore'});` +
        `m.on('exit',()=>console.log('GONE'));` +
        `setInterval(()=>{},1000);`;
      const proc = nodeSpawner(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: process.env,
      });
      let daemonPid: number | undefined;
      try {
        for await (const chunk of proc.stdout) if (chunk.includes('GONE')) break;
        for (let i = 0; i < 100 && daemonPid === undefined; i++) {
          if (existsSync(pidFile)) daemonPid = Number(readFileSync(pidFile, 'utf8'));
          else await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(daemonPid).toBeGreaterThan(0);

        proc.kill();
        await proc.exited;
        // Well past the escalation that would have taken it down had it been captured.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(isRunning(daemonPid as number)).toBe(true);
      } finally {
        if (daemonPid !== undefined) forceKill(daemonPid);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(walkUnavailable)(
    'escalates an escaped grandchild that ignores SIGTERM to SIGKILL',
    async () => {
      // The motivating case is a tool tree that does NOT go down politely — a `vitest`
      // run with its own signal handler, or one wedged in native code. Without the
      // escalation it would sit there holding the sandbox's memory after the turn ended.
      const { proc, grandchildPid } = await spawnEscapedGrandchild('process.on("SIGTERM",()=>{})');
      try {
        proc.kill();
        await proc.exited;
        // It ignores SIGTERM and it is out of reach of `kill(-pid)`, so nothing but the
        // SIGKILL escalation can reap it — and the poll window is well past that grace.
        expect(await waitForReaped(grandchildPid)).toBe(true);
      } finally {
        forceKill(grandchildPid);
      }
    },
  );

  it('kill terminates the whole process tree, not just the direct child', async () => {
    // The core of the duplicate-process fix: an agent's grandchildren (the shells it
    // spawns) must die WITH it. The parent spawns a long-lived grandchild in its own
    // (inherited) process group and prints its pid; killing the parent must reap it.
    const script =
      `const {spawn}=require('node:child_process');` +
      `const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);` +
      `process.stdout.write('GPID:'+g.pid+'\\n');` +
      `setInterval(()=>{},1000);`;
    const proc = nodeSpawner(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: process.env,
    });
    let grandchildPid: number | undefined;
    for await (const chunk of proc.stdout) {
      const match = /GPID:(\d+)/.exec(chunk);
      if (match?.[1] !== undefined) {
        grandchildPid = Number(match[1]);
        break;
      }
    }
    expect(grandchildPid).toBeGreaterThan(0);
    // The grandchild is alive before the kill (signal 0 probes existence).
    expect(() => process.kill(grandchildPid as number, 0)).not.toThrow();

    proc.kill();
    await proc.exited;

    // Poll: the group SIGTERM propagates asynchronously. `kill(pid, 0)` throws ESRCH
    // once the grandchild is gone.
    let reaped = false;
    for (let i = 0; i < 50 && !reaped; i++) {
      try {
        process.kill(grandchildPid as number, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        reaped = true;
      }
    }
    expect(reaped).toBe(true);
  });
});
