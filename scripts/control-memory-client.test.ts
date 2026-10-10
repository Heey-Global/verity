import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const client = 'deploy/bin/verity-control-plane-memory';

it('appends Control memory with the current turn bearer and surfaces broker rejection', async () => {
  const received: { url: string | undefined; authorization: string | undefined; body: string }[] =
    [];
  let status = 200;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      received.push({ url: request.url, authorization: request.headers.authorization, body });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(status === 200 ? { ok: true, length: 24 } : { error: 'unauthorized' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing test address');
  const env = {
    ...process.env,
    VERITY_CONTROL_MEMORY_URL: `http://127.0.0.1:${address.port}/internal/control-plane/memory`,
    VERITY_CONTROL_MEMORY_TOKEN: 'current-turn-bearer',
  };
  try {
    const result = await exec(process.execPath, [client, 'append', 'Remember this'], { env });
    expect(result.stderr).toContain('saved to Control memory');
    expect(received).toEqual([
      {
        url: '/internal/control-plane/memory',
        authorization: 'Bearer current-turn-bearer',
        body: JSON.stringify({ text: 'Remember this' }),
      },
    ]);
    status = 401;
    await expect(
      exec(process.execPath, [client, 'append', 'Another note'], { env }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('HTTP 401') });
    await expect(
      exec(process.execPath, [client, 'append', 'Another note'], {
        env: { ...env, VERITY_CONTROL_MEMORY_TOKEN: '' },
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('active Control turn') });
    await expect(exec(process.execPath, [client, 'append', '   '], { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('empty memory'),
    });
    expect(received).toHaveLength(2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

// A working source helper is unavailable to Control unless the image installs it.
it('installs the Control memory helper as an executable', async () => {
  const dockerfile = await readFile('deploy/Dockerfile', 'utf8');
  expect(dockerfile).toContain(
    'COPY deploy/bin/verity-control-plane-memory /usr/local/bin/verity-memory',
  );
  expect(dockerfile).toMatch(/chmod 0755 [^\n]*\/usr\/local\/bin\/verity-memory/u);
});
