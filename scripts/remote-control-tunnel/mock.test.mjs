import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import http2 from 'node:http2';
import { Duplex } from 'node:stream';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, createWebSocketStream } from 'ws';
import { startFixture } from './mock.mjs';

for (const protocol of ['h1', 'h2']) {
  await test(
    `TLS remains end-to-end through the ${protocol} test WSS relay`,
    { timeout: 20000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'verity-tunnel-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=core.test',
          '-addext',
          'subjectAltName=DNS:core.test,IP:127.0.0.1',
          '-keyout',
          join(dir, 'key'),
          '-out',
          join(dir, 'cert'),
        ],
        { stdio: 'ignore' },
      );
      const cert = await readFile(join(dir, 'cert'));
      const fixture = await startFixture({ key: await readFile(join(dir, 'key')), cert, protocol });
      t.after(() => fixture.close());
      const pin = new X509Certificate(cert).fingerprint256;
      const outer = () =>
        new WebSocket(`wss://127.0.0.1:${fixture.relayPort}/tunnel`, { ca: cert });
      /** @param {{ badCA?: boolean, hostname?: string, pin?: string }} options */
      async function connect(options = {}) {
        const ws = outer();
        await once(ws, 'open');
        const stream = createWebSocketStream(ws);
        stream.on('error', () => {});
        const socket = tls.connect({
          socket: stream,
          ca: options.badCA ? undefined : cert,
          servername: options.hostname ?? 'core.test',
          checkServerIdentity(host, peer) {
            return (
              tls.checkServerIdentity(host, peer) ??
              (peer.fingerprint256 !== (options.pin ?? pin) ? new Error('pin mismatch') : undefined)
            );
          },
        });
        socket.once('close', () => ws.terminate());
        socket.on('error', () => {});
        try {
          await once(socket, 'secureConnect');
        } catch (error) {
          socket.destroy();
          ws.terminate();
          throw error;
        }
        return socket;
      }
      async function request(body = '') {
        const socket = await connect();
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.write(
          body
            ? `POST /echo HTTP/1.1\r\nHost: core.test\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
            : 'GET / HTTP/1.1\r\nHost: core.test\r\nConnection: close\r\n\r\n',
        );
        await once(socket, 'end');
        socket.destroy();
        return Buffer.concat(chunks).toString();
      }
      assert.match(await request(), /core-ok/);
      const payloadMarker = 'synthetic-private-body-91b79';
      assert.match(await request(payloadMarker), new RegExp(payloadMarker));
      assert.equal(fixture.stats.captured.includes(Buffer.from(payloadMarker)), false);
      await assert.rejects(connect({ hostname: 'wrong.test' }), /Hostname\/IP does not match/);
      await assert.rejects(connect({ pin: 'wrong' }), /pin mismatch/);
      await assert.rejects(connect({ badCA: true }), /self-signed certificate/);
      const waiting = await connect();
      waiting.write('GET /slow HTTP/1.1\r\nHost: core.test\r\n\r\n');
      waiting.destroy();
      assert.match(await request(), /core-ok/);
      const socket = await connect();
      const echo = new WebSocket('wss://core.test/socket', { createConnection: () => socket });
      await once(echo, 'open');
      echo.send(payloadMarker);
      const textEvent = /** @type {unknown[]} */ (await once(echo, 'message'));
      const [message, binary] = textEvent;
      assert.ok(Buffer.isBuffer(message));
      assert.equal(message.toString(), payloadMarker);
      assert.equal(binary, false);
      echo.send(Buffer.from([0, 1, 255]));
      const binaryEvent = /** @type {unknown[]} */ (await once(echo, 'message'));
      const [bytes, isBinary] = binaryEvent;
      assert.deepEqual(bytes, Buffer.from([0, 1, 255]));
      assert.equal(isBinary, true);
      echo.terminate();
      socket.destroy();
      // Exercise the framed fixture used by the production Apple tunnel, not just the raw spike.
      const framed = new WebSocket(`wss://127.0.0.1:${fixture.relayPort}/data`, { ca: cert });
      await once(framed, 'open');
      const attached = once(framed, 'message');
      framed.send(JSON.stringify({ type: 'attach', ticket: 'fixture-ticket' }));
      const attachedEvent = /** @type {unknown[]} */ (await attached);
      assert.ok(Buffer.isBuffer(attachedEvent[0]));
      assert.deepEqual(JSON.parse(attachedEvent[0].toString()), {
        type: 'attached',
        sessionId: 'fixture-session',
        capability: 'remote-control-v1',
      });
      let sequence = 0;
      let receivedSequence = 0;
      const pipe = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          assert.ok(Buffer.isBuffer(chunk));
          framed.send(
            JSON.stringify({
              type: 'stream.data',
              streamId: 'test',
              seq: sequence++,
              payload: chunk.toString('base64'),
            }),
            callback,
          );
        },
        final(callback) {
          framed.send(JSON.stringify({ type: 'stream.end', streamId: 'test' }), callback);
        },
      });
      framed.on('message', (raw) => {
        assert.ok(Buffer.isBuffer(raw));
        /** @type {unknown} */
        const parsed = JSON.parse(raw.toString());
        assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
        const frame = /** @type {Record<string, unknown>} */ (parsed);
        if (frame.type === 'stream.data') {
          assert.equal(frame.seq, receivedSequence++);
          assert.equal(typeof frame.payload, 'string');
          pipe.push(Buffer.from(/** @type {string} */ (frame.payload), 'base64'));
        } else if (frame.type === 'stream.end') pipe.push(null);
        else pipe.destroy(new Error('Unexpected frame'));
      });
      framed.send(
        JSON.stringify({ type: 'stream.open', streamId: 'test', channel: 'remote', meta: {} }),
      );
      const framedTLS = tls.connect({
        socket: pipe,
        ca: cert,
        servername: 'core.test',
        ALPNProtocols: protocol === 'h2' ? ['h2'] : ['http/1.1'],
      });
      await once(framedTLS, 'secureConnect');
      assert.equal(framedTLS.alpnProtocol, protocol === 'h2' ? 'h2' : 'http/1.1');
      if (protocol === 'h2') {
        const session = http2.connect('https://core.test', { createConnection: () => framedTLS });
        session.on('error', () => {});
        const held = session.request({ ':path': '/slow' });
        held.on('error', () => {});
        held.end();
        const sibling = session.request({ ':path': '/echo', ':method': 'POST' });
        const body = Buffer.alloc(96 * 1024, 0x61);
        const chunks = [];
        sibling.on('data', (chunk) => chunks.push(chunk));
        sibling.end(body);
        held.close(http2.constants.NGHTTP2_CANCEL);
        await once(sibling, 'end');
        assert.deepEqual(Buffer.concat(chunks), body);
        const next = session.request({ ':path': '/healthz' });
        const nextChunks = [];
        next.on('data', (chunk) => nextChunks.push(chunk));
        next.end();
        await once(next, 'end');
        assert.equal(Buffer.concat(nextChunks).toString(), 'core-ok');
        session.destroy();
      } else {
        const framedChunks = [];
        framedTLS.on('data', (chunk) => framedChunks.push(chunk));
        framedTLS.write('GET /healthz HTTP/1.1\r\nHost: core.test\r\nConnection: close\r\n\r\n');
        await once(framedTLS, 'end');
        assert.match(Buffer.concat(framedChunks).toString(), /core-ok/);
      }
      framedTLS.destroy();
      framed.terminate();
      const oversized = outer();
      oversized.on('error', () => {});
      await once(oversized, 'open');
      oversized.send(Buffer.alloc(65537));
      const closeEvent = /** @type {unknown[]} */ (await once(oversized, 'close'));
      const [code] = closeEvent;
      assert.equal(code, 1009);
      assert.ok(fixture.stats.captured.length <= 128 * 1024);
      assert.match(await request(), /core-ok/);
    },
  );
}
