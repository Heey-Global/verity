import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@verity/adapter-claude';
import { agentEventSchema, type AgentEvent } from '@verity/events';
import type { RunResult } from './backend-contract.js';
import {
  stampFrame,
  tailFrames,
  writeFrame,
  type RunnerFrame,
  type RunnerFrameBody,
} from './runner-transport.js';

// Stamp a body with a fixed turn/instance and an explicit seq so each constant is a
// full envelope-carrying frame (ADR 0006 D3). The transport layer roundtrips frames
// verbatim; contiguity/dedup of the seq is the Server ingest's concern, not here.
const TURN_ID = 'turn-1';
const RUNNER_INSTANCE = 'runner-1';
function frame(body: RunnerFrameBody, frameSeq: number): RunnerFrame {
  return stampFrame(body, { turnId: TURN_ID, runnerInstanceId: RUNNER_INSTANCE, frameSeq });
}

// A representative frame of each variant, over one turn's lifetime.
const SESSION_FRAME = frame({ kind: 'session', id: 'sess-1' }, 1);
const TEXT_EVENT: AgentEvent = { t: 'text', delta: 'hello' };
const STATUS_EVENT: AgentEvent = { t: 'status', state: 'running' };
const EVENT_FRAME_A = frame({ kind: 'event', event: TEXT_EVENT }, 2);
const EVENT_FRAME_B = frame({ kind: 'event', event: STATUS_EVENT }, 3);
const PERMISSION_REQUEST: PermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'ls' },
  toolUseId: 'tool-1',
};
const PERMISSION_FRAME = frame({ kind: 'permission-request', request: PERMISSION_REQUEST }, 4);
const RESULT: RunResult = { sessionId: 'sess-1', exitCode: 0, stderr: '', aborted: false };
const RESULT_FRAME = frame({ kind: 'result', result: RESULT }, 5);

const eventExamples: Record<AgentEvent['t'], AgentEvent> = {
  session: { t: 'session', id: 's', model: 'model', worktree: '/work' },
  dev_servers_changed: {
    t: 'dev_servers_changed',
    devServers: [
      {
        port: 3000,
        reachable: true,
        pid: 1,
        name: 'Web',
        command: 'npm start',
        workdir: '.',
        scope: 'session',
        sessionId: 's',
        managedInstanceId: 'instance',
      },
    ],
  },
  status: { t: 'status', state: 'crashed', message: 'Connection closed' },
  text: { t: 'text', delta: 'hello', parentToolId: 'parent' },
  notice: { t: 'notice', text: 'notice', role: 'agent', clientRequestId: 'request' },
  prompt: {
    t: 'prompt',
    peer: { sessionId: 's', projectId: 'p', label: 'Peer', message: 'hello' },
    initiatedBy: { userId: 'user' },
    text: 'hello',
    steered: true,
    attachments: [
      { kind: 'image', mediaType: 'image/png', id: 'blob', data: 'YQ==' },
      { kind: 'file', mediaType: 'text/plain', fileName: 'a.txt', id: 'blob', data: 'YQ==' },
    ],
  },
  thinking: { t: 'thinking', blockId: 'b', signature: 'sig', delta: 'hmm', parentToolId: 'parent' },
  skill: { t: 'skill', text: 'skill' },
  tool_call_start: { t: 'tool_call_start', id: 'tool', name: 'Bash', parentToolId: 'parent' },
  tool_call: {
    t: 'tool_call',
    id: 'tool',
    name: 'Bash',
    input: { command: 'ls' },
    parentToolId: 'parent',
  },
  tool_result: {
    t: 'tool_result',
    id: 'tool',
    output: 'ok',
    isError: false,
    outputRef: { id: 'blob', bytes: 2 },
    parentToolId: 'parent',
  },
  permission: {
    t: 'permission',
    id: 'permission',
    tool: 'Bash',
    input: {},
    riskClass: 'ask',
    grantChannel: 'acp',
  },
  result: {
    t: 'result',
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
    stopReason: 'end_turn',
    telemetry: {
      backend: 'codex',
      mode: 'acp',
      userPromptChars: 1,
      runtimePromptChars: 2,
      submittedPromptChars: 3,
      attachments: 0,
      resumed: false,
    },
    permissionDenials: [{ tool: 'Bash', toolUseId: 'tool', input: {} }],
  },
  rate_limit: {
    t: 'rate_limit',
    status: 'allowed',
    resetsAt: 1,
    window: 'weekly',
    usedPercent: 10,
    scope: 'all',
    providerLabel: 'Provider',
  },
  task: {
    t: 'task',
    id: 'task',
    phase: 'ended',
    toolUseId: 'tool',
    description: 'Work',
    status: 'completed',
  },
  choices: {
    t: 'choices',
    question: 'Which?',
    options: [{ label: 'Continue', recommended: true }],
    multiSelect: false,
  },
  automation_proposal: {
    t: 'automation_proposal',
    proposal: {
      name: 'Review',
      schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'UTC' },
      prompt: 'Review changes',
      script: 'true',
      model: 'model',
    },
  },
  interrupted: { t: 'interrupted' },
  merged: { t: 'merged', number: 1 },
  compaction: { t: 'compaction', boundary: true },
  error: { t: 'error', kind: 'connection_closed', message: 'closed' },
  diagnostic: {
    t: 'diagnostic',
    source: 'agent',
    outcome: 'failed',
    phase: 'prompt',
    backend: 'codex',
    code: -1,
    model: 'model',
    exitCode: 1,
    signal: null,
    turnActive: true,
    stderrTail: 'agent stderr',
  },
  session_progress: {
    t: 'session_progress',
    summary: 'Done',
    outcomeDelivered: true,
    blocker: 'None',
    requiredDecision: 'Continue',
  },
  tasks_updated: { t: 'tasks_updated', origin: 'agent', change: 'completed', taskIds: ['task'] },
  raw: { t: 'raw', backend: 'codex', payload: { nested: true } },
};

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-runner-transport-'));
  file = join(dir, 'events.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runner-transport (ADR 0006 Stage 2.1)', () => {
  it('covers every event variant and optional object field in the schema', () => {
    expect(Object.keys(eventExamples).sort()).toEqual(
      agentEventSchema.options.map((schema) => schema.shape.t.value).sort(),
    );
    for (const schema of agentEventSchema.options) {
      const example = eventExamples[schema.shape.t.value];
      expect(Object.keys(example).sort()).toEqual(Object.keys(schema.shape).sort());
    }
  });

  it.each(Object.entries(eventExamples))(
    'roundtrips a %s event with reversed nested field order',
    async (_type, example) => {
      const event = reverseKeys(example) as AgentEvent;
      const stamped = frame({ kind: 'event', event }, 1);
      await writeFrame({ path: file }, stamped);
      await writeFrame({ path: file }, frame({ kind: 'result', result: RESULT }, 2));
      const seen: RunnerFrame[] = [];
      await tailFrames(file, (item) => {
        seen.push(item);
      });
      expect(seen[0]).toEqual(stamped);
      expect(JSON.stringify(seen[0])).toBe(JSON.stringify(stamped));
    },
  );

  it.each([
    ['retired channel', { ...eventExamples.permission, grantChannel: 'native' }],
    ['unknown fields', { ...eventExamples.diagnostic, futureField: { detail: 'retained' } }],
  ])('verifies the original payload before schema normalization: %s', async (_label, event) => {
    expect(JSON.stringify(agentEventSchema.parse(event))).not.toBe(JSON.stringify(event));
    const stamped = frame({ kind: 'event', event: event as AgentEvent }, 1);
    await writeFrame({ path: file }, stamped);
    await writeFrame({ path: file }, frame({ kind: 'result', result: RESULT }, 2));
    const seen: RunnerFrame[] = [];
    await tailFrames(file, (item) => {
      seen.push(item);
    });
    expect(seen[0]).toEqual(stamped);
  });

  it('still rejects a valid event whose payload was changed after stamping', async () => {
    const stamped = frame({ kind: 'event', event: eventExamples.diagnostic }, 1);
    await writeFrame({ path: file }, {
      ...stamped,
      event: { ...eventExamples.diagnostic, stderrTail: 'tampered' },
    } as RunnerFrame);
    await expect(tailFrames(file, () => {})).rejects.toThrow('invalid runner frame payload hash');
  });

  it('rejects an invalid event even when its raw hash is valid', async () => {
    await writeFrame(
      { path: file },
      frame(
        { kind: 'event', event: { t: 'diagnostic', source: 'invalid' } as unknown as AgentEvent },
        1,
      ),
    );
    await expect(tailFrames(file, () => {})).rejects.toThrow('invalid event frame');
  });

  it('accepts the legacy runner hash for a process diagnostic with model appended last', async () => {
    const body = {
      kind: 'event',
      event: {
        t: 'diagnostic',
        source: 'agent',
        outcome: 'failed',
        phase: 'prompt',
        backend: 'codex',
        exitCode: 1,
        signal: null,
        turnActive: true,
        stderrTail: 'stderr',
        model: 'model',
      },
    };
    // Keep the old algorithm independent of stampFrame to guard rolling upgrades.
    const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await appendFile(
      file,
      JSON.stringify({
        protocolVersion: SESSION_FRAME.protocolVersion,
        runnerInstanceId: RUNNER_INSTANCE,
        turnId: TURN_ID,
        frameSeq: 1,
        payloadHash,
        ...body,
      }) + '\n',
    );
    await writeFrame({ path: file }, frame({ kind: 'result', result: RESULT }, 2));
    const seen: RunnerFrame[] = [];
    await tailFrames(file, (item) => {
      seen.push(item);
    });
    expect(seen[0]).toMatchObject({ ...body, payloadHash });
  });

  it.each([
    { id: 's', kind: 'session' },
    { event: eventExamples.diagnostic, kind: 'event' },
    { request: PERMISSION_REQUEST, kind: 'permission-request' },
    { result: RESULT, kind: 'result' },
  ] as RunnerFrameBody[])('preserves body key order for $kind frames', async (body) => {
    const stamped = frame(body, 1);
    await writeFrame({ path: file }, stamped);
    if (body.kind !== 'result')
      await writeFrame({ path: file }, frame({ kind: 'result', result: RESULT }, 2));
    const seen: RunnerFrame[] = [];
    await tailFrames(file, (item) => {
      seen.push(item);
    });
    expect(seen[0]).toEqual(stamped);
  });

  it('writes each frame variant as one JSONL line and tails them back in order + typed', async () => {
    const frames = [SESSION_FRAME, EVENT_FRAME_A, PERMISSION_FRAME, EVENT_FRAME_B, RESULT_FRAME];
    for (const f of frames) await writeFrame({ path: file }, f);

    const seen: RunnerFrame[] = [];
    await tailFrames(
      file,
      (frame) => {
        seen.push(frame);
      },
      { pollMs: 1 },
    );

    // Parses back in order, and each variant is correctly discriminated + typed.
    expect(seen).toEqual(frames);
    const [first, evt, perm] = seen;
    expect(first).toEqual(SESSION_FRAME);
    expect(evt?.kind).toBe('event');
    if (evt?.kind === 'event') expect(evt.event).toEqual(TEXT_EVENT);
    expect(perm?.kind).toBe('permission-request');
    if (perm?.kind === 'permission-request') expect(perm.request).toEqual(PERMISSION_REQUEST);
  });

  it('tails a frame larger than the bounded read chunk across multiple reads', async () => {
    const large = frame(
      { kind: 'event', event: { t: 'text', delta: 'x'.repeat(2 * 1024 * 1024) } },
      1,
    );
    const terminal = frame({ kind: 'result', result: RESULT }, 2);
    await writeFrame({ path: file }, large);
    await writeFrame({ path: file }, terminal);
    const seen: RunnerFrame[] = [];
    await tailFrames(
      file,
      (item) => {
        seen.push(item);
      },
      { pollMs: 1 },
    );
    expect(seen).toEqual([large, terminal]);
  });

  it('rejects data after the terminal result frame', async () => {
    await writeFrame({ path: file }, SESSION_FRAME);
    await writeFrame({ path: file }, RESULT_FRAME);
    // A frame written AFTER the result must not be delivered (tail already resolved).
    await writeFrame({ path: file }, EVENT_FRAME_A);

    const seen: RunnerFrame[] = [];
    await expect(
      tailFrames(
        file,
        (frame) => {
          seen.push(frame);
        },
        { pollMs: 1 },
      ),
    ).rejects.toThrow('runner result frame must be terminal');

    expect(seen).toEqual([SESSION_FRAME]);
  });

  it('rejects trailing frames that begin beyond the current read chunk', async () => {
    await writeFrame({ path: file }, RESULT_FRAME);
    await appendFile(file, ' '.repeat(1024 * 1024));
    await writeFrame({ path: file }, EVENT_FRAME_A);
    await expect(tailFrames(file, () => {}, { pollMs: 1 })).rejects.toThrow(
      'runner result frame must be terminal',
    );
  });

  it('buffers a partial trailing line across polls (frame split by a poll boundary)', async () => {
    const seen: RunnerFrame[] = [];
    const tail = tailFrames(
      file,
      (frame) => {
        seen.push(frame);
      },
      { pollMs: 5 },
    );

    // Write the session frame whole, then the event frame's line in TWO halves with
    // a gap that spans at least one poll — the tail must not deliver the event until
    // its terminating newline arrives, and must not corrupt it.
    await writeFrame({ path: file }, SESSION_FRAME);
    const eventLine = `${JSON.stringify(EVENT_FRAME_A)}\n`;
    const cut = Math.floor(eventLine.length / 2);
    await appendFile(file, eventLine.slice(0, cut));
    await vi.waitFor(() => {
      expect(seen).toEqual([SESSION_FRAME]);
    });
    await sleep(20); // spans a poll: the partial half must be buffered, not parsed
    expect(seen).toEqual([SESSION_FRAME]); // event not yet complete
    await appendFile(file, eventLine.slice(cut));
    await writeFrame({ path: file }, RESULT_FRAME);

    await tail;
    expect(seen).toEqual([SESSION_FRAME, EVENT_FRAME_A, RESULT_FRAME]);
  });

  it('delivers frames strictly in order even when onFrame is async', async () => {
    for (const f of [SESSION_FRAME, EVENT_FRAME_A, EVENT_FRAME_B, RESULT_FRAME]) {
      await writeFrame({ path: file }, f);
    }
    const order: string[] = [];
    await tailFrames(
      file,
      async (frame) => {
        // Stagger the async work so an unordered impl would reorder these.
        await sleep(frame.kind === 'event' ? 4 : 1);
        order.push(frame.kind);
      },
      { pollMs: 1 },
    );
    expect(order).toEqual(['session', 'event', 'event', 'result']);
  });

  it('rejects on a malformed frame line', async () => {
    await appendFile(file, '{"kind":"bogus"}\n');
    await expect(tailFrames(file, () => {}, { pollMs: 1 })).rejects.toThrow(/frame kind/);
  });

  it('bounds an unterminated frame accumulated across polls', async () => {
    const tail = tailFrames(file, () => {}, { pollMs: 1 });
    await appendFile(file, 'x'.repeat(8 * 1024 * 1024));
    await appendFile(file, 'x');
    await expect(tail).rejects.toThrow('runner frame exceeded the size limit');
  });

  it.each([
    ['wrong protocol', { ...SESSION_FRAME, protocolVersion: 999 }],
    ['fractional sequence', { ...SESSION_FRAME, frameSeq: 1.5 }],
    ['empty turn id', { ...SESSION_FRAME, turnId: '' }],
    ['malformed event', { ...EVENT_FRAME_A, event: { t: 'status', state: 'bogus' } }],
    ['malformed result', { ...RESULT_FRAME, result: { exitCode: '0' } }],
    ['forged payload hash', { ...SESSION_FRAME, id: 'other-session' }],
  ])('rejects a structurally invalid %s frame', async (_label, invalid) => {
    await appendFile(file, `${JSON.stringify(invalid)}\n`);
    await expect(tailFrames(file, () => {}, { pollMs: 1 })).rejects.toThrow(/invalid/);
  });

  it('waits for the file to appear before the first frame', async () => {
    const seen: RunnerFrame[] = [];
    const tail = tailFrames(
      file,
      (frame) => {
        seen.push(frame);
      },
      { pollMs: 2 },
    );
    // File does not exist yet; create it after a delay.
    await sleep(15);
    await writeFrame({ path: file }, SESSION_FRAME);
    await writeFrame({ path: file }, RESULT_FRAME);
    await tail;
    expect(seen).toEqual([SESSION_FRAME, RESULT_FRAME]);
  });

  it('aborts the tail when the signal fires', async () => {
    await writeFrame({ path: file }, SESSION_FRAME); // no result frame -> would poll forever
    const ac = new AbortController();
    const tail = tailFrames(file, () => {}, { pollMs: 2, signal: ac.signal });
    await sleep(10);
    ac.abort();
    await expect(tail).rejects.toThrow(/abort/i);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
