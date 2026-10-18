import { once } from 'node:events';
import { expect, it } from 'vitest';
import { FrameGate } from './frame-gate.ts';

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 0x81;
  header[1] = 0xfe;
  header.writeUInt16BE(payload.length, 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, 4);
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, payload]);
}
const upgrade = Buffer.from('GET /data HTTP/1.1\r\nHost: localhost\r\n\r\n');
const data = frame(JSON.stringify({ type: 'stream.data', payload: 'x'.repeat(8192) }));
it('holds a real frame suffix across split input and releases all bytes in order', async () => {
  let held = false;
  const gate = new FrameGate(() => {
    held = true;
  });
  const chunks: Buffer[] = [];
  gate.on('data', (chunk: Buffer) => chunks.push(chunk));
  gate.arm();
  const following = frame('{"type":"ping"}');
  const input = Buffer.concat([upgrade, data, following]);
  gate.write(input.subarray(0, 7));
  gate.write(input.subarray(7, 51));
  gate.write(input.subarray(51));
  expect(held).toBe(true);
  expect(Buffer.concat(chunks)).toEqual(input.subarray(0, upgrade.length + data.length - 295));
  gate.release();
  gate.end();
  await once(gate, 'end');
  expect(Buffer.concat(chunks)).toEqual(input);
  expect(gate.intercepted).toBe(1);
  expect(gate.released).toBe(1);
});
it('aborts without releasing the missing suffix', async () => {
  const gate = new FrameGate(() => undefined);
  const chunks: Buffer[] = [];
  gate.on('data', (chunk: Buffer) => chunks.push(chunk));
  gate.on('error', () => undefined);
  gate.arm();
  gate.write(Buffer.concat([upgrade, data]));
  const closed = new Promise<void>((resolve) => gate.once('close', resolve));
  gate.destroy();
  await closed;
  expect(Buffer.concat(chunks).length).toBe(upgrade.length + data.length - 295);
  expect(gate.released).toBe(0);
});
it('passes unarmed frames without changing their contents', async () => {
  const gate = new FrameGate(() => {
    throw new Error('Unexpected interception');
  });
  const chunks: Buffer[] = [];
  gate.on('data', (chunk: Buffer) => chunks.push(chunk));
  gate.end(Buffer.concat([upgrade, data]));
  await once(gate, 'end');
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([upgrade, data]));
});

it('holds DATA before real WSS decoding while reverse traffic remains usable', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { createServer } = await import('node:https');
  const { default: WebSocket, WebSocketServer } = await import('ws');
  const { createFrameProxy } = await import('./tls-frame-proxy.ts');
  const directory = await mkdtemp(join(tmpdir(), 'frame-gate-'));
  execFileSync('bash', ['scripts/remote-control-integration/create-certificate.sh', directory]);
  const tls = {
    key: await readFile(join(directory, 'key.pem')),
    cert: await readFile(join(directory, 'cert.pem')),
  };
  const server = createServer(tls);
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const proxy = await createFrameProxy(new URL(`wss://127.0.0.1:${port}/data`), tls);
  const connected = once(wss, 'connection');
  const client = new WebSocket(proxy.dataURL, { ca: tls.cert });
  try {
    await once(client, 'open');
    const [peer] = (await connected) as [import('ws').WebSocket];
    const messages: string[] = [];
    peer.on('message', (bytes) =>
      messages.push(Buffer.isBuffer(bytes) ? bytes.toString() : 'unexpected frame type'),
    );
    proxy.arm();
    const message = JSON.stringify({ type: 'stream.data', payload: 'x'.repeat(8192) });
    client.send(message);
    const { vi } = await import('vitest');
    await vi.waitFor(() => expect(proxy.snapshot().held).toBe(true));
    expect(messages).toEqual([]);
    const reverse = once(client, 'message');
    peer.send('reverse-ok');
    expect(String((await reverse)[0])).toBe('reverse-ok');
    proxy.release();
    await vi.waitFor(() => expect(messages).toEqual([message]));
  } finally {
    client.terminate();
    await proxy.close();
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
