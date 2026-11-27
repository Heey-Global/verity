import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listTurns,
  readTurnState,
  probeSupervisor,
  SUPERVISED_WORKER_BACKENDS,
  supervisorWorkerEnv,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  NATIVE_WORKER_SETTLE_TIMEOUT_MS,
  runAgentSpawnBroker,
  runSupervisor,
  supervisorRequest,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('runs bundled ACP workers end-to-end', async () => {
    const binDir = join(runtimeDir, 'bin');
    await mkdir(binDir);
    const codex = join(binDir, 'codex');
    await writeFile(
      codex,
      `#!/bin/sh
if [ "$1" = 'app-server' ]; then
  read initialize
  printf '%s\\n' '{"id":1,"result":{}}'
  read initialized
  read thread_start
  printf '%s\\n' '{"id":2,"result":{"thread":{"id":"codex-app-s1"}}}'
  read turn_start
  printf '%s\\n' '{"id":3,"result":{"turn":{"id":"codex-app-turn"}}}'
	  printf '%s\\n' '{"id":99,"method":"item/tool/call","params":{"threadId":"codex-app-s1","turnId":"codex-app-turn","callId":"secret-call-1","namespace":null,"tool":"verity_secret_job","arguments":{"kind":"restricted","profile":{"id":"profile-1","version":1,"policyHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"parameters":{"operation":"list"},"snapshotId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}}'
	  read tool_result
	  printf '%s\\n' '{"method":"item/completed","params":{"threadId":"codex-app-s1","turnId":"codex-app-turn","completedAtMs":1,"item":{"type":"dynamicToolCall","id":"secret-call-1","tool":"verity_secret_job","arguments":{},"status":"completed","success":true}}}'
	  sleep 1
	  printf '%s\\n' '{"method":"item/agentMessage/delta","params":{"delta":"approval received"}}'
  printf '%s\\n' '{"method":"turn/completed","params":{"threadId":"codex-app-s1","turn":{"id":"codex-app-turn","status":"completed","error":null}}}'
  exit 0
fi
all_args="$*"
# The supervisor's turn timeout is backend-agnostic; Codex carries it now that the
# native Claude worker is gone.
case "$*" in
  *timeout-codex*) sleep 2; exit 0 ;;
esac
require_image=''
case "$*" in
  *'image through native Codex worker'*) require_image=1 ;;
esac
image=''
saw_exec=''
saw_resume=''
saw_session=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = 'exec' ]; then saw_exec=1; fi
  if [ "$1" = 'resume' ]; then
    if [ -z "$saw_exec" ]; then exit 42; fi
    saw_resume=1
  fi
  if [ "$1" = 'codex-native-s1' ]; then
    if [ -z "$saw_resume" ]; then exit 42; fi
    saw_session=1
  fi
  if [ "$1" = '--image' ]; then shift; image="$1"; fi
  shift
done
if [ -n "$require_image" ] && [ -z "$image" ]; then exit 40; fi
if [ -n "$image" ] && [ "$(cat "$image")" != 'hi' ]; then exit 41; fi
case "$all_args" in
  *'resume native Codex worker'*)
    if [ -z "$saw_exec" ] || [ -z "$saw_resume" ] || [ -z "$saw_session" ]; then exit 42; fi
    ;;
esac
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-native-s1"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`,
    );
    await chmod(codex, 0o755);
    const codexAcp = join(binDir, 'codex-acp');
    await writeFile(
      codexAcp,
      `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let sessionId = 'codex-acp-bundled-s1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
    } });
  } else if (message.method === 'session/new') {
    writeFileSync(join(message.params.cwd, '.acp-mcp-capture.json'), JSON.stringify(message.params.mcpServers));
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      modes: { currentModeId: 'agent-full-access', availableModes: [
        { id: 'agent-full-access', name: 'Agent Full Access' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from bundled codex-acp' } },
    } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.id !== undefined) {
    appendFileSync(join(process.cwd(), '.acp-unexpected.jsonl'), JSON.stringify(message) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
    );
    await chmod(codexAcp, 0o755);
    // The Claude arm of the same end-to-end path. Since ADR 0012 removed the native
    // transport, `claude-acp` is Claude's ONLY transport — so without this the real
    // bundled worker is never once exercised for the backend every Claude session in
    // the fleet now runs on, and the composition that would break (this bundle, that
    // profile, the broker's `claude-agent-acp` mapping) is covered nowhere.
    //
    // Deliberately NOT a copy of the Codex fake with the name swapped: it answers
    // `session/set_mode`, which is the part of the handshake the two profiles do
    // differently. Codex pins its mode to a constant, while Claude's derives from the
    // caller's `permissionMode` — so the mode reaching the agent is worth asserting
    // for Claude and meaningless for Codex.
    const claudeAcp = join(binDir, 'claude-agent-acp');
    await writeFile(
      claudeAcp,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const sessionId = 'claude-acp-bundled-s1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
    } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      modes: { currentModeId: 'default', availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
        { id: 'acceptEdits', name: 'Accept Edits' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/load') {
    writeFileSync(join(process.cwd(), '.acp-claude-load.json'), JSON.stringify(message.params));
    send({ jsonrpc: '2.0', id: message.id, result: {
      modes: { currentModeId: 'default', availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'default', name: 'Default' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/set_mode') {
    writeFileSync(join(process.cwd(), '.acp-claude-mode.json'), JSON.stringify(message.params));
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from bundled claude-agent-acp' } },
    } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
    );
    await chmod(claudeAcp, 0o755);
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      codexPath: codex,
      codexAcpPath: codexAcp,
      claudeAcpPath: claudeAcp,
      worktreeRoot: runtimeDir,
      // Both ACP fakes are Node scripts, so they run under THIS node rather than
      // whatever `#!/usr/bin/env node` resolves to on the runner. The native Codex
      // fake is `/bin/sh` and is executed directly, as before.
      spawnChild: (_command, args, options) =>
        args[7] === codexAcp || args[7] === claudeAcp
          ? spawn(process.execPath, [args[7], ...args.slice(8)], options)
          : spawn(args[7]!, args.slice(8), options),
    });
    // The gate under test refuses a backend this supervisor was not launched for, so
    // it needs a parseable backend name that is NOT in this list. Both halves are
    // pinned below rather than left to the reader: widening the list to every
    // supervised backend would otherwise leave the refusal assertion with no invalid
    // input and pass for the wrong reason.
    const launchedBackends = ['codex-acp', 'claude-acp'];
    const unsupportedBackend = 'opencode-acp';
    expect(launchedBackends).not.toContain(unsupportedBackend);
    expect(SUPERVISED_WORKER_BACKENDS).toContain(unsupportedBackend);
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [resolve('features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs')],
      workerBackends: launchedBackends,
      workerEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        // Derive the rest exactly the way the production entry does, from a stand-in
        // container env. Naming VERITY_MCP_GATEWAY_URL here directly is what let this
        // test pass while the supervisor never forwarded it: the gateway reached the
        // ACP worker in the test harness and nowhere else.
        ...supervisorWorkerEnv({
          VERITY_AGENT_SPAWN_BROKER_SOCKET: broker.socketPath,
          VERITY_MCP_GATEWAY_URL: 'http://relay.internal/internal/mcp',
        }),
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-unsupported',
          startCommandId: 'start-unsupported',
          sessionId: 'session-unsupported',
          // A backend the request validator parses but this supervisor was not
          // launched for — the gate under test. It has to be a parseable name:
          // A retired or invented name would be refused one step earlier and prove
          // nothing about `workerBackends`.
          backend: unsupportedBackend,
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'must not be claimed',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/does not support backend/),
      });
      await expect(readTurnState(runtimeDir, 'turn-unsupported')).resolves.toBeUndefined();

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-codex-acp',
          startCommandId: 'start-codex-acp',
          sessionId: 'session-codex-acp',
          backend: 'codex-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'hello through bundled Codex ACP worker',
          steerable: true,
          permissionControl: true,
          mcpGatewayToken: 'turn-bound-gateway-bearer',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-codex-acp');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      await expect(
        readFile(join(runtimeDir, '.acp-mcp-capture.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toEqual([
        {
          name: 'verity',
          type: 'http',
          url: 'http://relay.internal/internal/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer turn-bound-gateway-bearer' }],
        },
      ]);
      const acpFrames = (
        await readFile(join(runtimeDir, 'turns/turn-codex-acp/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(acpFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'session', id: 'codex-acp-bundled-s1' }),
          expect.objectContaining({
            kind: 'event',
            event: {
              t: 'text',
              delta: 'hello from bundled codex-acp',
            },
          }),
        ]),
      );

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-claude-acp',
          startCommandId: 'start-claude-acp',
          sessionId: 'session-claude-acp',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'hello through bundled Claude ACP worker',
          permissionMode: 'plan',
          steerable: true,
          permissionControl: true,
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-claude-acp');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      // The requested posture reached the agent as a real `session/set_mode`. This is
      // the §5b invariant observed from the far end of the whole chain — supervisor,
      // bundled worker, ACP client, Claude profile — rather than at the seam that
      // asserts it, and it is what the profile's `permissionModes` vocabulary bounds.
      await expect(
        readFile(join(runtimeDir, '.acp-claude-mode.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toMatchObject({ sessionId: 'claude-acp-bundled-s1', modeId: 'plan' });
      const claudeFrames = (
        await readFile(join(runtimeDir, 'turns/turn-claude-acp/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(claudeFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'session', id: 'claude-acp-bundled-s1' }),
          expect.objectContaining({
            kind: 'event',
            event: { t: 'text', delta: 'hello from bundled claude-agent-acp' },
          }),
        ]),
      );

      // Resume through the bundled worker. The deleted native `turn-native-resume`
      // case was the only end-to-end exercise of `resumeSessionId`, and Codex cannot
      // take its place — its profile declares `loadSessionUnsupported`, so `session/load`
      // is reachable through Claude alone. Everything between the supervisor request
      // and the agent is the real bundle.
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-claude-acp-resume',
          startCommandId: 'start-claude-acp-resume',
          sessionId: 'session-claude-acp',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'resume through bundled Claude ACP worker',
          resumeSessionId: 'claude-acp-bundled-s1',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-claude-acp-resume');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      // It resumed rather than starting over: the agent saw `session/load` carrying the
      // id from the first turn, in this worktree.
      await expect(
        readFile(join(runtimeDir, '.acp-claude-load.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toMatchObject({ sessionId: 'claude-acp-bundled-s1', cwd: runtimeDir });
    } finally {
      await supervisor.close();
      await broker.close();
    }
  });

  it('rejects pipelined and oversized frames without applying a claim', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    const rawRequest = async (payload: string): Promise<Record<string, unknown>> =>
      await new Promise((resolve, reject) => {
        const socket = createConnection(supervisor.socketPath);
        let response = '';
        socket.once('error', reject);
        socket.on('data', (chunk) => {
          response += chunk.toString('utf8');
        });
        socket.once('end', () => resolve(JSON.parse(response) as Record<string, unknown>));
        socket.once('connect', () => socket.write(payload));
      });
    try {
      const claim = JSON.stringify({
        protocolVersion: 1,
        kind: 'claim-turn',
        turnId: 'pipelined',
        startCommandId: 'start-pipelined',
      });
      await expect(rawRequest(`${claim}\n${claim}\n`)).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/exactly one request/),
      });
      expect(await listTurns(runtimeDir)).toEqual([]);

      await expect(rawRequest(`${'x'.repeat(4 * 1024 * 1024 + 2)}\n`)).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/frame too large/),
      });
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  // The refusal used to be destroyed along with the connection: `socket.end(frame,
  // () => socket.destroy())` cuts off a peer that is still streaming, so the
  // Server's remaining write died with EPIPE and the frame naming the cause never
  // landed. That is what an operator sending two phone photos saw — `write EPIPE`,
  // naming neither the size nor the attachments. Keep answering a peer mid-write.
  it('answers an oversize frame to a peer that is still writing it', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      const socket = createConnection(supervisor.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      let response = '';
      let unanswered: Error | undefined;
      // Only a failure that beats the refusal is the one this test is about.
      // Once the answer has landed the supervisor is entitled to close, and the
      // writes still queued here then fail for the ordinary reason — the
      // incident was a peer that got `write EPIPE` *instead of* an answer.
      const noteWriteError = (error: Error): void => {
        if (response.length === 0) unanswered ??= error;
      };
      socket.removeAllListeners('error');
      socket.on('error', noteWriteError);
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
      });
      // Attached before the first write, not after the loop: the refusal can be
      // answered and the connection closed while this loop is still turning, and
      // a listener added afterwards waits for an event that has already fired.
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const megabyte = 'x'.repeat(1024 * 1024);
      // Eight separate writes with the event loop turning in between: the cap is
      // crossed early and several more writes are still to come.
      for (let index = 0; index < 8; index += 1) {
        socket.write(megabyte, (error) => {
          if (error !== undefined && error !== null) noteWriteError(error);
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Tell the supervisor that the request stream is complete. It deliberately
      // drains an oversized peer rather than resetting it, so its refusal cannot
      // be lost behind an RST, and this half-close is what lets that drain
      // finish instead of running down the grace timer.
      socket.end();
      await closed;

      expect(JSON.parse(response.trim())).toMatchObject({
        ok: false,
        error: expect.stringMatching(/frame too large/),
      });
      expect(unanswered).toBeUndefined();
      // Draining a refused payload must not cost the supervisor its next request.
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  it('destroys an idle connection during shutdown', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    const idle = createConnection(supervisor.socketPath);
    await new Promise<void>((resolve, reject) => {
      idle.once('connect', resolve);
      idle.once('error', reject);
    });
    await expect(supervisor.close()).resolves.toBeUndefined();
    expect(idle.destroyed).toBe(true);
  });
});
