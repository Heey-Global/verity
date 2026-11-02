import { request } from 'node:http';
import { z } from 'zod';

const objectId = /^[a-f0-9]{64}$/u;
const objectName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u;
const imageName = /^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u;
const API = '/v1.47';
/** No caller-selected method, socket, query, redirect or arbitrary API path. */
export async function readEgressDockerObject(
  kind: 'container' | 'network' | 'image' | 'volume' | 'info' | 'networks',
  id?: string,
): Promise<unknown> {
  z.enum(['container', 'network', 'image', 'volume', 'info', 'networks']).parse(kind);
  if (
    kind === 'info' || kind === 'networks'
      ? id !== undefined
      : !id ||
        !(
          kind === 'container' || kind === 'network'
            ? objectId
            : kind === 'image'
              ? imageName
              : objectName
        ).test(id)
  )
    throw new Error('Invalid host Docker inspection identity');
  const path =
    kind === 'info' || kind === 'networks'
      ? '/' + kind
      : `/${kind}s/${encodeURIComponent(id!)}${kind === 'container' || kind === 'image' ? '/json' : ''}`;
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: '/var/run/docker.sock', method: 'GET', path: API + path, agent: false },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error('Host Docker inspection refused or API 1.47 unsupported'));
          response.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error('Oversized host Docker inspection'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Truncated host Docker inspection')));
        response.on('end', () => {
          try {
            if (!response.complete) throw new Error('Truncated host Docker inspection');
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
            );
            if (kind === 'container' || kind === 'network')
              z.object({ Id: z.literal(id!) }).parse(value);
            resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Invalid host Docker inspection'));
          }
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error('Host Docker inspection timed out')),
      1000,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timeout));
    req.end();
  });
}

/** Compatibility reader for existing validators; only bounded inspection forms are accepted. */
export async function readEgressDocker(...args: string[]): Promise<string> {
  if (args[0] === 'info' && args[1] === '--format' && args.length === 3) {
    const value = await readEgressDockerObject('info');
    if (args[2] === '{{json .}}') return JSON.stringify(value);
    if (args[2] === '{{json .Runtimes}}')
      return JSON.stringify(z.object({ Runtimes: z.unknown() }).parse(value).Runtimes);
  }
  if (JSON.stringify(args) === JSON.stringify(['network', 'ls', '-q', '--no-trunc']))
    return z
      .array(z.object({ Id: z.string().regex(objectId) }))
      .max(10000)
      .parse(await readEgressDockerObject('networks'))
      .map((value) => value.Id)
      .join('\n');
  const kind = args[0];
  if (
    ['container', 'network', 'image', 'volume'].includes(kind!) &&
    args[1] === 'inspect' &&
    args.length >= 3 &&
    args.length <= 66
  ) {
    const type = z.enum(['container', 'network', 'image', 'volume']).parse(kind);
    const values: unknown[] = [];
    for (const id of args.slice(2)) values.push(await readEgressDockerObject(type, id));
    const encoded = JSON.stringify(values);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
      throw new Error('Oversized host Docker inspection batch');
    return encoded;
  }
  if (args[0] === 'inspect' && args.length === 2)
    return JSON.stringify([await readEgressDockerObject('container', args[1])]);
  throw new Error('Unsupported host Docker inspection command');
}
