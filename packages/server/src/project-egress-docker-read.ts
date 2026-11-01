import { request } from 'node:http';

/** Read-only compatibility for the fixed inspection forms used by the host.
 * No project request chooses a socket, HTTP method or arbitrary daemon path. */
export async function readProjectEgressDocker(
  args: readonly string[],
  socketPath = '/var/run/docker.sock',
  timeoutMs = 1000,
): Promise<string | undefined> {
  let path: string;
  let runtimes = false;
  let array = true;
  const value = args.at(-1) ?? '';
  const id = /^[a-f0-9]{64}$/u.test(value);
  if (args.length === 3 && args[0] === 'container' && args[1] === 'inspect' && id)
    path = `/containers/${value}/json`;
  else if (args.length === 2 && args[0] === 'inspect' && id) path = `/containers/${value}/json`;
  else if (args.length === 3 && args[0] === 'network' && args[1] === 'inspect' && id)
    path = `/networks/${value}`;
  else if (
    args.length === 3 &&
    args[1] === 'inspect' &&
    ['image', 'volume'].includes(args[0]!) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,1023}$/u.test(value) &&
    value !== '..'
  )
    path = `/${args[0] === 'image' ? 'images' : 'volumes'}/${encodeURIComponent(value)}${args[0] === 'image' ? '/json' : ''}`;
  else if (
    args.length === 3 &&
    args[0] === 'info' &&
    args[1] === '--format' &&
    ['{{json .}}', '{{json .Runtimes}}'].includes(value)
  ) {
    path = '/info';
    array = false;
    runtimes = value === '{{json .Runtimes}}';
  } else return undefined;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const req = request({ socketPath, path, method: 'GET', agent: false }, (response) => {
      if (response.statusCode !== 200) {
        finish(new Error(`Host Docker inspection returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) finish(new Error('Oversized host Docker inspection'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => finish(error));
      response.once('aborted', () => finish(new Error('Truncated host Docker inspection')));
      response.once('end', () => {
        try {
          if (!response.complete) throw new Error('Truncated host Docker inspection');
          const body: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
          if (body === null || typeof body !== 'object' || Array.isArray(body))
            throw new Error('Invalid host Docker inspection object');
          const selected = runtimes ? (body as Record<string, unknown>).Runtimes : body;
          if (selected === undefined) throw new Error('Missing host Docker runtimes');
          finish(undefined, JSON.stringify(array ? [selected] : selected));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Invalid host Docker inspection'));
        }
      });
    });
    const timer = setTimeout(
      () => finish(new Error('Host Docker inspection timed out')),
      timeoutMs,
    );
    req.once('error', (error) => finish(error));
    req.end();
  });
}
