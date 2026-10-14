import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(
  new URL('../apps/mobile/native/RemoteAppTunnel.swift', import.meta.url),
  'utf8',
);

function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

// The app's send queue is serial: every frame of every stream waits for the
// one before it. The heartbeat bypasses that queue, so a send that never
// completes leaves the attachment silent in one direction with its pongs still
// arriving, and nothing ends it. Swift only compiles on the Apple workflow, so
// these guards read the shape of the fix out of the source.
it('bounds every WebSocket send in the writer queue and ends the attachment on a miss', () => {
  const writer = section('  private actor Writer {', '\n  private final class Stream');
  // The one call that reaches the socket is inside the deadline; a bare call
  // would wait on the transport for good.
  expect(writer).not.toMatch(/^\s*try await socket\.send\(/mu);
  expect(writer).toMatch(
    /bounded\(seconds: Self\.sendDeadlineSeconds\) \{ try await socket\.send\(/u,
  );
  expect(writer).toMatch(/once\.resume\(RemoteSmokeError\.sendStalled\)/u);
  // The transport's send ignores cancellation: a task group that waited for
  // it would never return, and the deadline would never fire.
  expect(writer).not.toMatch(/withThrowingTaskGroup/u);
  expect(writer).toMatch(/withCheckedThrowingContinuation/u);
  // A missed deadline must reach the tunnel, which stops with a stall reason
  // the JavaScript recovery recognises and replaces.
  expect(writer).toMatch(/if Self\.isStall\(error\) \{ onStall\?\(\) \}/u);
  expect(source).toMatch(
    /stop\(reason: "stall: send unanswered within \\\(Writer\.sendDeadlineSeconds\) s", cause: \.sendStall\)/u,
  );
  const transport = readFileSync(
    new URL('../apps/mobile/lib/remoteControlTransport.ts', import.meta.url),
    'utf8',
  );
  expect(transport).toContain("startsWith('stall')");
});

it('never lets the frame reader wait on the writer queue', () => {
  // The reader loop handles frames inline; a reset that awaited the writer
  // would stop receiving while the queue is stuck, silencing the inbound
  // direction too.
  const reset = section('  private func reset(_ id: String, code: String) async {', '\n  }\n');
  expect(reset).not.toMatch(/^\s*try\? await writer\.send/mu);
  expect(reset).toMatch(/Task \{ try\? await writer\.send\(\["type": "stream\.reset"/u);
});
