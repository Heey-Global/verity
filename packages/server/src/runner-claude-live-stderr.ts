/**
 * claude-agent-acp owns stdout for the ACP protocol, so it routes its own
 * console logging to stderr rather than to a log file — 0.70.0 added a
 * per-query diagnostic line there. Verity drops stderr from a successful turn,
 * which makes that line noise rather than a finding, so the live smoke
 * tolerates it and nothing else.
 *
 * Matched as a whole line rather than by "looks like a namespaced log line":
 * `[session/error] …` wears the same brackets and is precisely what this gate
 * exists to catch, and a prefix match would swallow anything appended to the
 * tolerated line. A future benign line therefore turns the gate red until it is
 * allowed here on purpose, which is the direction the mistake should fall.
 *
 * Kept beside the smoke harness instead of inside it because the harness runs
 * itself on import and cannot be exercised from a test.
 */
const ADAPTER_QUERY_LINE =
  // Every field is constrained to what the adapter actually prints — opaque ids
  // and either `native` or a bare origin — rather than to any non-whitespace
  // run. A credential hiding in a path, a query string or userinfo therefore
  // fails the gate instead of riding along inside the one tolerated line.
  /^\[session\/query\] sessionId=[\w.-]+ resume=[\w.-]+ apiType=[\w.-]+ baseUrl=(?:[\w.-]+|https?:\/\/[\w.-]+(?::\d+)?\/?)$/u;

export function unexpectedStderrLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.trim().length > 0 && !ADAPTER_QUERY_LINE.test(line));
}
