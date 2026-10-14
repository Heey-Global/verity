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

// The app once chained every frame of every stream behind the one before it.
// The heartbeat bypasses that path, so a send that never completed left the
// attachment silent in one direction with its pongs still arriving, and
// nothing ended it. Swift only compiles on the Apple workflow, so these guards
// read the shape of the fix out of the source.
it('does not chain sends across streams', () => {
  const writer = section('  private actor Writer {', '\n  private final class Stream');
  // Order matters only within a stream, which each stream's own pump keeps;
  // a chain across streams ties every stream to the slowest send.
  expect(writer).not.toMatch(/previous|predecessor/u);
});

it('sends every frame of a stream from one awaited sequence', () => {
  // With no chain, per-stream order rests on each stream's frames coming from
  // one place that awaits each send: the open from accept, data and end from
  // the pump, and the reset after the stream is retired.
  const calls = [
    ...source.matchAll(/^\s*(?:try\??|Task \{ try\?) await writer\.send\(\["type": "([a-z.]+)"/gmu),
  ].map((match) => match[1]);
  expect(calls.sort()).toEqual([
    'attach',
    'stream.data',
    'stream.end',
    'stream.open',
    'stream.reset',
  ]);
});

it('bounds every WebSocket send and ends the attachment on a miss', () => {
  const writer = section('  private actor Writer {', '\n  private final class Stream');
  // The one call that reaches the socket is inside the deadline; a bare call
  // would wait on the transport for good.
  expect(writer.match(/socket\.send\(/gu)).toHaveLength(1);
  expect(writer).toMatch(
    /bounded\(seconds: Self\.sendDeadlineSeconds, progress: progress\) \{[\s\S]{0,120}?try await socket\.send\(/u,
  );
  // Measured against progress: a slow link that keeps completing sends is
  // not a stopped socket.
  expect(writer).toMatch(/if progress\.mark != mark \{ mark = progress\.mark; continue \}/u);
  expect(writer).toMatch(/once\.resume\(RemoteSmokeError\.sendStalled\)/u);
  // The transport's send ignores cancellation: a task group that waited for
  // it would never return, and the deadline would never fire.
  expect(writer).not.toMatch(/withThrowingTaskGroup/u);
  expect(writer).toMatch(/withCheckedThrowingContinuation/u);
  // A missed deadline must reach the tunnel, which stops with a stall reason
  // the JavaScript recovery recognises and replaces.
  expect(writer).toMatch(
    /if Self\.isStall\(error\), !stallRaised, let onStall \{\s*stallRaised = true\s*onStall\(\)/u,
  );
  expect(source).toMatch(
    /stop\(reason: "stall: send unanswered within \\\(Writer\.sendDeadlineSeconds\) s", cause: \.sendStall\)/u,
  );
  const transport = readFileSync(
    new URL('../apps/mobile/lib/remoteControlTransport.ts', import.meta.url),
    'utf8',
  );
  expect(transport).toContain("startsWith('stall')");
});

it('never lets the frame reader wait on the writer queue when it resets a stream', () => {
  // The reader loop handles frames inline; a reset that awaited the writer
  // would stop receiving while the queue is stuck, silencing the inbound
  // direction too.
  const reset = section('  private func reset(_ id: String, code: String) async {', '\n  }\n');
  expect(reset).not.toMatch(/^\s*try\? await writer\.send/mu);
  expect(reset).toMatch(/Task \{ try\? await writer\.send\(\["type": "stream\.reset"/u);
});
