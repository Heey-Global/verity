import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleSupervisorRequest,
  MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_PROTOCOL_VERSION,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  runAgentSpawnBroker,
  supervisorRequestFrames,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

// ADR 0006 D9: a Server of version N routinely talks to a Sandbox from N−1. The
// Server writes its requests at its own floor, because every supervisor already
// deployed compares the version for equality; a supervisor must read the range in
// return, or the first bump breaks the pair from whichever side moved first.
describe('supervisor protocol range (ADR 0006 D9)', () => {
  const status = (protocolVersion: unknown) =>
    handleSupervisorRequest('/run/verity-runner', 'runner-1', { protocolVersion, kind: 'status' });

  it('answers a request written at the oldest dialect it supports', async () => {
    await expect(status(MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION)).resolves.toMatchObject({
      ok: true,
      runnerInstanceId: 'runner-1',
    });
  });

  it.each([
    ['newer than it knows', SUPERVISOR_PROTOCOL_VERSION + 1],
    ['older than it supports', MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION - 1],
    ['not a version at all', '1'],
  ])('refuses a request %s', async (_label, version) => {
    await expect(status(version)).rejects.toThrow(/unsupported supervisor protocol/u);
  });
});

it.each(['exit', 'interrupt'] as const)(
  'releases an agent home after %s with inherited pipes open',
  async (ending) => {
    await writeFile(join(runtimeDir, 'egress-connector.url'), 'http://127.0.0.1:1', {
      mode: 0o600,
    });
    const agents: ReturnType<typeof spawn>[] = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
      spawnChild: (_command, _args, options) => {
        // The descendant keeps stdout and the home lock fd alive after its parent
        // exits. A finite lifetime also bounds cleanup if the exit reaper regresses.
        const child = spawn(
          process.execPath,
          [
            '-e',
            `
        const {spawn} = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'],
          {stdio: ['ignore', 1, 2, 3]});
        descendant.once('spawn', () => ${ending === 'interrupt' ? "process.kill(process.pid, 'SIGTERM')" : 'process.exit(0)'});
      `,
          ],
          options,
        );
        agents.push(child);
        return child;
      },
    });
    const request = {
      protocolVersion: 1,
      kind: 'spawn-agent',
      command: 'codex-acp',
      args: [],
      cwd: runtimeDir,
      sessionEnv: { VERITY_SESSION_ID: 'exit-home' },
    };
    try {
      const started = Date.now();
      const first = await supervisorRequestFrames(broker.socketPath, request);
      expect(first.at(-1)).toMatchObject({
        ok: true,
        kind: 'exit',
        ...(ending === 'interrupt' ? { signal: 'SIGTERM' } : { code: 0 }),
      });
      expect(Date.now() - started).toBeLessThan(6000);
      const second = await supervisorRequestFrames(broker.socketPath, {
        ...request,
        command: 'claude-agent-acp',
      });
      expect(second.at(-1)).toMatchObject({
        ok: true,
        kind: 'exit',
        ...(ending === 'interrupt' ? { signal: 'SIGTERM' } : { code: 0 }),
      });
    } finally {
      for (const child of agents) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
      await broker.close();
    }
  },
);
