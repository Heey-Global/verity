import { request } from 'node:http';
import { Buffer } from 'node:buffer';

const limit = 2 * 1024 * 1024;
/** Read-only host daemon facts; never a project-supplied Docker endpoint. */
export function createProjectEgressDockerInspector(socketPath = '/var/run/docker.sock') {
  const read = (path: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath, path: `/v1.52${path}`, method: 'GET', agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) {
              req.destroy(new Error('Oversized Docker inspection'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Docker inspection HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
            } catch {
              reject(new Error('Invalid Docker inspection JSON'));
            }
          });
        },
      );
      // Wall-clock bound, including connection setup and a peer trickling a reply.
      const timer = setTimeout(() => req.destroy(new Error('Docker inspection timed out')), 1000);
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
      req.end();
    });
  return async (args: readonly string[]): Promise<string | undefined> => {
    if (
      args.length === 3 &&
      args[0] === 'info' &&
      args[1] === '--format' &&
      args[2] === '{{json .Runtimes}}'
    ) {
      const info = await read('/info');
      if (!info || typeof info !== 'object' || !('Runtimes' in info))
        throw new Error('Missing Docker runtimes');
      return JSON.stringify(info.Runtimes);
    }
    const [kind, id] =
      args.length === 2 && args[0] === 'inspect'
        ? ['container', args[1]]
        : args.length === 3 && args[1] === 'inspect'
          ? [args[0], args[2]]
          : [];
    if (!kind || !id || !['container', 'network', 'image', 'volume'].includes(kind))
      return undefined;
    if ((kind === 'container' || kind === 'network') && !/^[a-f0-9]{64}$/u.test(id))
      throw new Error('Invalid Docker inspection identity');
    const paths: Record<string, string> = {
      container: 'containers',
      network: 'networks',
      image: 'images',
      volume: 'volumes',
    };
    const suffix = kind === 'container' || kind === 'image' ? '/json' : '';
    return JSON.stringify([await read(`/${paths[kind]}/${encodeURIComponent(id)}${suffix}`)]);
  };
}
export const inspectProjectEgressDocker = createProjectEgressDockerInspector();
