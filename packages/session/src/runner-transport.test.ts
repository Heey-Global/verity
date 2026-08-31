import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
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
