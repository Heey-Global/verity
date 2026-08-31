/**
 * Split an async stream of arbitrary string chunks (e.g. a process's stdout)
 * into complete newline-delimited lines. A line may span multiple chunks; a
 * trailing chunk with no final newline is still yielded. The `\r` of a `\r\n`
 * pair is left on the line — downstream `parseLine` trims it.
 *
 * Assumes stream-json's one-JSON-object-per-line framing: there is no max-line
 * guard, so it must not be pointed at arbitrary input that may never emit `\n`.
 */
export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
