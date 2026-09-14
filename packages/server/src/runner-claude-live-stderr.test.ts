import { describe, expect, it } from 'vitest';
import { unexpectedStderrLines } from './runner-claude-live-stderr.js';

describe('live smoke stderr', () => {
  it("tolerates the adapter's per-query diagnostic", () => {
    // Verbatim from claude-agent-acp 0.70.0, which is what turned the release
    // gate red on every branch that touches the sandbox.
    expect(
      unexpectedStderrLines(
        '[session/query] sessionId=c9646f83 resume=none apiType=native baseUrl=native\n',
      ),
    ).toEqual([]);
    expect(unexpectedStderrLines('')).toEqual([]);
  });

  it('tolerates bounded session creation timings', () => {
    const timing =
      '[session/create] sessionId=session-1 phase=prepare-query durationMs=8 totalMs=24';
    expect(unexpectedStderrLines(timing)).toEqual([]);
    expect(unexpectedStderrLines(`${timing} token=secret`)).toEqual([`${timing} token=secret`]);
    expect(unexpectedStderrLines(timing.replace('durationMs=8', 'durationMs=fast'))).toEqual([
      timing.replace('durationMs=8', 'durationMs=fast'),
    ]);
  });

  it('tolerates bounded session replay timings', () => {
    const timings = [
      '[session/models] sessionId=session-1 phase=read-transcript durationMs=2 totalMs=2 messages=1 model=unknown',
      '[session/load] sessionId=session-1 phase=session-ready durationMs=50 totalMs=50',
      '[session/replay] sessionId=session-1 phase=read durationMs=0 messages=1',
      '[session/replay] sessionId=session-1 phase=publish durationMs=1 totalMs=1 messages=1',
      '[session/load] sessionId=session-1 phase=replay durationMs=1 totalMs=52',
    ];
    expect(unexpectedStderrLines(timings.join('\n'))).toEqual([]);
    expect(unexpectedStderrLines(`${timings[0]!} token=secret`)).toEqual([
      `${timings[0]!} token=secret`,
    ]);
    expect(unexpectedStderrLines(timings[2]!.replace('messages=1', 'messages=many'))).toEqual([
      timings[2]!.replace('messages=1', 'messages=many'),
    ]);
  });

  it('still reports anything that is not that line', () => {
    // The point of the check: a crash, a warning, or a leaked credential in the
    // agent's stderr must fail the gate exactly as an empty-string assertion did.
    expect(
      unexpectedStderrLines('TypeError: input.allowed_domains.join is not a function'),
    ).toEqual(['TypeError: input.allowed_domains.join is not a function']);
    const query = '[session/query] sessionId=c9646f83 resume=none apiType=native baseUrl=native';
    expect(unexpectedStderrLines(`${query}\nError: not fine\n${query}\n`)).toEqual([
      'Error: not fine',
    ]);
    // The tolerated shape is one specific line, not the namespaced-log family:
    // a failure wearing the same brackets is exactly what this gate is for.
    expect(unexpectedStderrLines('[session/error] upstream refused')).toEqual([
      '[session/error] upstream refused',
    ]);
    expect(unexpectedStderrLines('[session/query] no session id here')).toEqual([
      '[session/query] no session id here',
    ]);
    // Nothing may ride along on the tolerated line — a credential appended to
    // it, or carried in the base URL, would otherwise leave stderr unreported.
    expect(unexpectedStderrLines(`${query} token=sk-live`)).toEqual([`${query} token=sk-live`]);
    const withKey = query.replace('baseUrl=native', 'baseUrl=https://gateway.example?key=sk-live');
    expect(unexpectedStderrLines(withKey)).toEqual([withKey]);
    const withUserinfo = query.replace(
      'baseUrl=native',
      'baseUrl=https://key:sk-live@gateway.example/v1',
    );
    expect(unexpectedStderrLines(withUserinfo)).toEqual([withUserinfo]);
    const withPath = query.replace('baseUrl=native', 'baseUrl=https://gateway.example/v1/sk-live');
    expect(unexpectedStderrLines(withPath)).toEqual([withPath]);
    // A bare origin is still the shape the adapter may print — that is what the
    // local egress connector's base URL looks like.
    expect(
      unexpectedStderrLines(query.replace('baseUrl=native', 'baseUrl=http://127.0.0.1:47821')),
    ).toEqual([]);
    expect(unexpectedStderrLines('[session/query]')).toEqual(['[session/query]']);
    expect(unexpectedStderrLines('[error] upstream unavailable')).toEqual([
      '[error] upstream unavailable',
    ]);
  });
});
