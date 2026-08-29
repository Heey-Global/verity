import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { agentLaunchSpec } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { nodeSpawner } from './runner.js';

/**
 * Verity's attestation rests on an assumption nobody had written down: that a
 * same-UID repository process cannot forge traffic into the private channel
 * between the Runner worker and an agent child. Today's attested Codex tool call
 * is read off a Sandbox child's stdout, and the ACP
 * design would read a second one off an adapter's stdout — so in both cases the
 * channel is a descriptor a sibling process can see in `/proc/<pid>/fd`.
 *
 * Measurement (docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md §5, M6) found that the
 * assumption holds, but only because libuv gives a piped child a *socketpair*,
 * and a socket cannot be reopened through `/proc`. An ordinary pipe can — the
 * forge succeeds, under the same `ptrace_scope`. So the protection is an
 * implementation detail of the spawn path, not something Verity arranges.
 *
 * The first test therefore goes through {@link nodeSpawner} itself rather than
 * `spawn`, so a change to Verity's own spawn options fails it. The second builds
 * a real pipe to show the attack is otherwise live, which is what makes the first
 * one worth having. Both mount the attack from a separate process that
 * verifies it is not an ancestor of its target — see
 * {@link forgeFromNonAncestor}. The third covers the spawn path a deployed turn
 * actually takes, which is the broker's and not `nodeSpawner`'s.
 *
 * Both also depend on a host that permits `/proc/<pid>/fd` access between
 * same-UID processes at all. A runner with `ptrace_scope >= 2` or `hidepid`
 * refuses the reopen outright, and then neither assertion is about Verity: the
 * socketpair would be unreopenable for the host's reason rather than its own, and
 * the control's premise would be absent. That precondition is therefore
 * *measured* in {@link beforeAll} rather than assumed, and a host that fails it
 * skips with the observed refusal named — see {@link hostRefusesProcForge}.
 */
describe('agent child stdio isolation', () => {
  const onLinux = platform() === 'linux' ? it : it.skip;

  /**
   * The control forge, run once before either assertion: a real `pipe(2)` between
   * two processes, attacked from a non-ancestor. Success is what makes the
   * socketpair result meaningful; a *permission* refusal means the host blocks the
   * whole class of attack and neither test can speak about Verity.
   */
  let pipeForge: Forge | undefined;
  let ptraceScope = 'unreadable';

  beforeAll(async () => {
    if (platform() !== 'linux') return;
    try {
      ptraceScope = readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim();
    } catch {
      // No Yama on this kernel; the forge result below still settles the question.
    }
    // `sh` wires a genuine pipe(2) between the halves; the writer holds it open
    // for the length of the measurement.
    const pipeline = spawn('sh', ['-c', 'sleep 5 | sleep 5'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    try {
      // The writer appears a moment after the shell does.
      let writer: number | undefined;
      for (let attempt = 0; attempt < 20 && writer === undefined; attempt++) {
        await settle();
        writer = findPipeWriter(pipeline.pid as number);
      }
      if (writer === undefined) return;
      expect(readlinkSync(`/proc/${writer}/fd/1`)).toMatch(/^pipe:/);
      pipeForge = forgeFromNonAncestor(writer);
    } finally {
      try {
        process.kill(-(pipeline.pid as number), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  /**
   * Why this host cannot answer the question, or `undefined` when it can.
   *
   * Only a *permission* refusal earns a skip. Everything else — the calibration
   * pipe never appearing, a target that exited (`ESRCH`), a missing `sh`, an
   * unrecognised code — is a measurement that did not run, not a fact about the
   * host, and returning `undefined` for those leaves the assertions below to fail
   * loudly. The distinction matters because the alternative reading turns every
   * broken setup into a silently green security test.
   */
  const hostRefusesProcForge = (): string | undefined => {
    const code = pipeForge?.code;
    if (code === undefined || !PERMISSION_DENIED.has(code)) return undefined;
    return `host refuses /proc/<pid>/fd forging outright (${code}, ptrace_scope=${ptraceScope}), so neither descriptor type is distinguishable here`;
  };

  /**
   * What a same-UID repository process would attempt: reopen another process's
   * stdout through `/proc` and write into it. Returns the failure code, or
   * `undefined` when the forge succeeded.
   *
   * This deliberately runs in a *separate* process rather than in the test. The
   * distinction is the whole point: `/proc` access to another task's descriptors
   * goes through a ptrace-mode check, and an ancestor can pass checks a workspace
   * process cannot, so forging from the parent would prove something the threat
   * model never claimed. Rather than infer the relationship from how each target
   * was spawned, the attacker walks the target's `ppid` chain and reports whether
   * it found itself there — so `isAncestor` is measured, and the two cases below
   * are known to attack from equivalent standing.
   */
  const forgeFromNonAncestor = (pid: number): Forge => {
    const attack = `
      const { closeSync, openSync, readFileSync, writeSync } = require('node:fs');
      const ppidOf = (p) => {
        const stat = readFileSync('/proc/' + p + '/stat', 'utf8');
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      };
      let isAncestor = false;
      try {
        for (let p = ${pid}; p > 1 && !isAncestor; p = ppidOf(p)) {
          if (ppidOf(p) === process.pid) isAncestor = true;
        }
      } catch {
        // Chain broke because something exited mid-walk; report it as unknown
        // rather than crashing, so the assertion fails loudly instead of on JSON.
        isAncestor = 'unknown';
      }
      let code;
      let fd;
      try {
        fd = openSync('/proc/${pid}/fd/1', 'w');
        writeSync(fd, 'FORGED\\n');
      } catch (error) {
        code = error.code ?? 'UNKNOWN';
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      console.log(JSON.stringify({ code, isAncestor }));`;
    const out = spawnSync(process.execPath, ['-e', attack], { encoding: 'utf8' });
    return JSON.parse(out.stdout.trim()) as Forge;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  onLinux('spawns agent children onto a socketpair a sibling cannot reopen', async (ctx) => {
    const proc = nodeSpawner(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      cwd: tmpdir(),
      env: process.env,
    });
    try {
      await settle();
      expect(proc.pid).toBeDefined();
      // A socket, not a pipe — this is the property the attestation depends on,
      // and it is asserted on every host: reading a child's own fd link needs no
      // ptrace permission, so a spawner that regressed to a forgeable pipe fails
      // here even where the forge below cannot be attempted.
      expect(readlinkSync(`/proc/${proc.pid}/fd/1`)).toMatch(/^socket:/);
      // The `isAncestor: false` below means nothing unless the same walk can
      // return true: this test process really is an ancestor of what it spawned.
      expect(isAncestorOf(process.pid, proc.pid as number)).toBe(true);
      // Corroboration, and the part the host can veto: on a runner that refuses
      // /proc forging wholesale, a socket is unreopenable for the host's reason
      // rather than its own, so attempting it would assert the environment.
      const refusal = hostRefusesProcForge();
      if (refusal !== undefined) {
        await ctx.annotate(`forge corroboration not attempted: ${refusal}`);
        return;
      }
      // ENXIO: a socket has no reopenable path through /proc.
      expect(forgeFromNonAncestor(proc.pid as number)).toEqual({
        code: 'ENXIO',
        isAncestor: false,
      });
    } finally {
      proc.kill('SIGKILL');
    }
  });

  onLinux('while an ordinary pipe is forgeable, which is why the above matters', (ctx) => {
    const refusal = hostRefusesProcForge();
    // This claim is about the host, not about Verity. Where the host refuses the
    // whole class of attack the claim is simply false there, and asserting it
    // would report a hardened runner as a Verity regression — so skip, with the
    // observed code in the note so the CI log says why the corroboration above
    // was skipped too.
    if (refusal !== undefined) ctx.skip(refusal);
    // Succeeds from the same non-ancestor standing that got ENXIO above, so the
    // difference is the descriptor type and not the attacker's ancestry. A
    // calibration that never ran arrives here as `undefined` and fails — that is
    // the intended outcome, since the corroboration above stands down on its
    // result and must not do so on a setup that fell over.
    expect(pipeForge, `ptrace_scope=${ptraceScope}`).toEqual({
      code: undefined,
      isAncestor: false,
    });
  });

  /**
   * The two tests above go through `nodeSpawner`, which is *not* what a deployed
   * turn uses: the Runner worker hands spawning to the agent spawn broker
   * (`runner-worker-entry.ts:297`), and the broker builds the child's stdio in
   * {@link agentLaunchSpec}. Measured on a live turn, that child's descriptors are
   * socketpairs too (§5 M7) — but nothing said they had to be, so a broker that
   * passed a raw `pipe(2)` or an inherited numeric fd would hand the workspace a
   * forgeable stdout and no test would notice.
   *
   * Asking libuv for `'pipe'` is what produces the unreopenable socket, so that
   * is the property to pin, for every command the broker will launch.
   */
  onLinux('and the shipped broker asks for the same stdio for every agent', async () => {
    for (const command of ['claude-agent-acp', 'codex-acp'] as const) {
      const spec = agentLaunchSpec(
        { command, args: [], cwd: tmpdir() },
        { agentUid: 1000, agentGid: 1000 },
      );
      expect(spec.spawnOptions.stdio, command).toEqual(['pipe', 'pipe', 'pipe']);
    }
    // And that this spelling still means a socketpair on this runtime — the same
    // claim the first test makes about `nodeSpawner`, made about the shipped spec.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
    });
    try {
      await settle();
      expect(readlinkSync(`/proc/${child.pid}/fd/1`)).toMatch(/^socket:/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

/** The outcome of one forge attempt: the failure code, or `undefined` when the
 *  write landed — plus whether the attacker turned out to be an ancestor of its
 *  target, which decides whether the attempt modelled the threat at all. */
interface Forge {
  code?: string;
  isAncestor: boolean | 'unknown';
}

/** The codes that mean *the host said no*, as opposed to the many that mean the
 *  measurement fell over. Only these two are grounds for skipping. */
const PERMISSION_DENIED = new Set(['EACCES', 'EPERM']);

/** `/proc/<pid>/stat` field 4 is ppid; the comm field may contain spaces, so parse
 *  after the closing parenthesis rather than splitting the whole line. */
function ppidOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

/** Whether `candidate` appears anywhere in `pid`'s parent chain. The same walk the
 *  attacker performs on itself, kept here so the negative result it reports can be
 *  shown to be a measurement rather than a constant. */
function isAncestorOf(candidate: number, pid: number): boolean {
  for (let p = pid; p > 1; p = ppidOf(p)) {
    if (ppidOf(p) === candidate) return true;
  }
  return false;
}

/** The child of `parent` whose stdout is an anonymous pipe, if any. */
function findPipeWriter(parent: number): number | undefined {
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (ppidOf(Number(pid)) !== parent) continue;
      if (readlinkSync(`/proc/${pid}/fd/1`).startsWith('pipe:')) return Number(pid);
    } catch {
      // Process exited between listing and reading.
    }
  }
  return undefined;
}
