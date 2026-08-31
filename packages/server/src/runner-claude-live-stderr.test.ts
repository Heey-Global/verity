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
