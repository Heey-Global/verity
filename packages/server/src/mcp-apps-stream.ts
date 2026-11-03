/** Rewrite individual JSON-RPC envelopes without buffering an entire SSE stream. */
export async function* transformMcpResponse(
  source: AsyncIterable<Uint8Array>,
  eventStream: boolean,
  transform: (message: unknown) => Promise<unknown>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  const rewrite = async (frame: string): Promise<string> => {
    const lines = frame.split('\n');
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return `${frame}\n\n`;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return `${frame}\n\n`;
    }
    const rewritten = JSON.stringify(await transform(message));
    return `${lines.filter((line) => !line.startsWith('data:')).join('\n')}\ndata: ${rewritten}\n\n`;
  };
  for await (const chunk of source) {
    buffered += decoder.decode(chunk, { stream: true });
    if (buffered.length > 16 * 1024 * 1024) throw new Error('MCP message too large');
    if (eventStream) {
      buffered = buffered.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffered.indexOf('\n\n')) !== -1) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        yield await rewrite(frame);
      }
    }
  }
  buffered += decoder.decode();
  if (eventStream) {
    if (buffered.trim()) yield await rewrite(buffered);
  } else if (buffered.trim()) {
    yield JSON.stringify(await transform(JSON.parse(buffered)));
  }
}
