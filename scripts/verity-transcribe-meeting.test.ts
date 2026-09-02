import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'deploy/bin/verity-transcribe-meeting');
const execFileAsync = promisify(execFile);
let tmp: string | undefined;

function testEnv(): NodeJS.ProcessEnv {
  return { ...process.env, VERITY_MEETING_CHUNK_SECONDS: '0' };
}

function makeTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'verity-transcribe-test-'));
  return tmp;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('verity-transcribe-meeting', () => {
  it('keeps a directly configured legacy environment working during migration', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    const server = await listen(async (req, res) => {
      expect(req.url).toBe('/v1/audio/transcriptions');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'legacy configuration still works' }));
    });
    try {
      const env = testEnv();
      for (const name of Object.keys(env)) {
        if (name.startsWith('VERITY_TRANSCRIBE_')) delete env[name];
      }
      const { stdout } = await execFileAsync(process.execPath, [script, audio], {
        env: {
          ...env,
          VERITY_TRANSCRIBE_BASE_URL: '',
          VERITY_PARAKEET_BASE_URL: server.baseUrl,
          VERITY_PARAKEET_MODEL: 'whisper-1',
          VERITY_PARAKEET_RESPONSE_FORMAT: 'json',
        },
      });
      expect(JSON.parse(stdout)).toMatchObject({
        segments: [{ text: 'legacy configuration still works' }],
      });
    } finally {
      await server.close();
    }
  });

  it('aborts an in-flight transcription request on SIGTERM', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      requestClosed = resolve;
    });
    const server = await listen(async (req) => {
      requestStarted();
      req.once('close', requestClosed);
      await closed;
    });
    try {
      const child = spawn(process.execPath, [script, audio], {
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
        },
      });
      await started;
      child.kill('SIGTERM');
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      await expect(exit).resolves.toMatchObject({ code: 1 });
      await closed;
    } finally {
      await server.close();
    }
  });

  it('force-kills an audio preparation child that ignores SIGTERM', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    const stubbornProbe = join(dir, 'stubborn-ffprobe');
    const probeStarted = join(dir, 'stubborn-ffprobe.started');
    writeFileSync(audio, 'audio');
    writeFileSync(
      stubbornProbe,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => undefined); writeFileSync(process.env.VERITY_TEST_PROBE_STARTED, ''); setInterval(() => undefined, 1000);\n`,
    );
    chmodSync(stubbornProbe, 0o755);
    const child = spawn(process.execPath, [script, audio], {
      env: {
        ...testEnv(),
        // Never reached — the probe hangs first — but the client refuses to run
        // at all without a configured backend.
        VERITY_TRANSCRIBE_BASE_URL: 'http://127.0.0.1:1/v1',
        VERITY_MEETING_CHUNK_SECONDS: '300',
        VERITY_MEETING_FFPROBE_COMMAND: stubbornProbe,
        VERITY_TEST_PROBE_STARTED: probeStarted,
      },
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      await expect.poll(() => existsSync(probeStarted), { timeout: 2_000 }).toBe(true);
      const startedAt = Date.now();
      child.kill('SIGTERM');
      await expect(exit).resolves.toMatchObject({ code: 1 });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
  });

  it('posts audio to the configured transcription API and normalizes verbose JSON', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let requestBody = '';
    const server = await listen(async (req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/audio/transcriptions');
      expect(req.headers.authorization).toBe('Bearer local-token');
      requestBody = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          language: 'de',
          duration: 3,
          segments: [{ start: 1.5, end: 3, text: ' Lokale Transkription. ' }],
        }),
      );
    });
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [script, '--json', '--diarize', audio],
        {
          encoding: 'utf8',
          env: {
            ...testEnv(),
            VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
            VERITY_TRANSCRIBE_API_KEY: 'local-token',
            VERITY_TRANSCRIBE_MODEL: 'whisper-1',
            VERITY_TRANSCRIBE_RESPONSE_FORMAT: 'verbose_json',
            VERITY_TRANSCRIBE_LANGUAGE: 'de',
            VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
          },
        },
      );

      expect(requestBody).toContain('name="model"');
      expect(requestBody).toContain('whisper-1');
      expect(requestBody).toContain('name="response_format"');
      expect(requestBody).toContain('verbose_json');
      expect(requestBody).toContain('filename="meeting.mp3"');
      expect(JSON.parse(stdout)).toEqual({
        language: 'de',
        duration: 3,
        segments: [
          {
            speaker: 'Speaker 1',
            text: 'Lokale Transkription.',
            start: 1.5,
            end: 3,
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('retries while the transcription backend is briefly unreachable', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let attempts = 0;
    const server = await listen(async (_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('warming up');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'Retried local transcript.' }));
    });
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_TRANSCRIBE_RETRIES: '12',
          VERITY_TRANSCRIBE_HTTP_RETRIES: '1',
          VERITY_TRANSCRIBE_RETRY_DELAY_MS: '1',
          VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
        },
      });

      expect(attempts).toBe(2);
      expect(JSON.parse(stdout)).toEqual({
        segments: [{ speaker: 'Speaker 1', text: 'Retried local transcript.' }],
      });
    } finally {
      await server.close();
    }
  });

  it('surfaces the real connection failure, not a stale retriable status, on a mid-retry drop', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let attempts = 0;
    const server = await listen(async (req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('warming up');
        return;
      }
      // Second attempt: drop the connection instead of responding.
      req.socket.destroy();
    });
    let stderr = '';
    try {
      await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_TRANSCRIBE_RETRIES: '12',
          VERITY_TRANSCRIBE_HTTP_RETRIES: '1',
          VERITY_TRANSCRIBE_RETRY_DELAY_MS: '1',
          VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
        },
      });
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? '';
    } finally {
      await server.close();
    }

    expect(attempts).toBe(2);
    // The wrapper must surface the second attempt's connection error, not the
    // stale retriable response from the first attempt.
    expect(stderr).toContain('Could not reach the transcription API');
    expect(stderr).not.toContain('warming up');
    expect(stderr).not.toContain('HTTP 503');
  });

  it('does not retry by default', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let attempts = 0;
    const server = await listen(async (_req, res) => {
      attempts += 1;
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('warming up');
    });
    try {
      await expect(
        execFileAsync(process.execPath, [script, audio], {
          encoding: 'utf8',
          env: {
            ...testEnv(),
            VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
            VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
          },
        }),
      ).rejects.toThrow(/warming up/);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('does not spend the connection retry budget on HTTP inference failures', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let attempts = 0;
    const server = await listen(async (_req, res) => {
      attempts += 1;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('inference failed');
    });
    try {
      await expect(
        execFileAsync(process.execPath, [script, audio], {
          encoding: 'utf8',
          env: {
            ...testEnv(),
            VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
            VERITY_TRANSCRIBE_RETRIES: '12',
            VERITY_TRANSCRIBE_HTTP_RETRIES: '0',
            VERITY_TRANSCRIBE_RETRY_DELAY_MS: '1',
          },
        }),
      ).rejects.toThrow(/inference failed/);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('never retries a timed-out inference request', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    let attempts = 0;
    const server = await listen(async (req) => {
      attempts += 1;
      // Never answer. The client's own timeout is what ends this request, so
      // the test does not depend on a sleep here outlasting that timeout — and
      // waiting for the close is also what lets `server.close()` return.
      await new Promise<void>((resolve) => req.once('close', resolve));
    });
    try {
      await expect(
        execFileAsync(process.execPath, [script, audio], {
          encoding: 'utf8',
          env: {
            ...testEnv(),
            VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
            VERITY_TRANSCRIBE_RETRIES: '12',
            // Deliberately far longer than a loopback request needs. The
            // assertion below is that the request was made exactly once, which
            // it can only observe if the request arrives before the abort: at
            // 20 ms the timer could expire during connect on a loaded runner,
            // leaving `attempts` at 0 and failing a correct implementation for
            // being observed too early. Nothing here waits out this budget —
            // the abort ends the request the moment it fires.
            VERITY_TRANSCRIBE_TIMEOUT_MS: '500',
            VERITY_TRANSCRIBE_RETRY_DELAY_MS: '1',
          },
        }),
      ).rejects.toThrow(/timed out/);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('maps transcription API text responses to a single speaker segment', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    const server = await listen(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Plain local transcript.');
    });
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_TRANSCRIBE_RESPONSE_FORMAT: 'text',
          VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
        },
      });

      expect(JSON.parse(stdout)).toEqual({
        segments: [{ speaker: 'Speaker 1', text: 'Plain local transcript.' }],
      });
    } finally {
      await server.close();
    }
  });

  it('compresses oversized audio locally before posting to the backend', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'large.wav');
    const ffmpeg = join(dir, 'ffmpeg');
    writeFileSync(audio, 'audio');
    writeFileSync(
      ffmpeg,
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('node:fs');",
        'if (!process.argv.includes("24k")) process.exit(2);',
        'writeFileSync(process.argv.at(-1), "mp3");',
      ].join('\n'),
    );
    chmodSync(ffmpeg, 0o755);
    let requestBody = '';
    const server = await listen(async (req, res) => {
      requestBody = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'Compressed local transcript.' }));
    });
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_TRANSCRIBE_MAX_UPLOAD_BYTES: '4',
          VERITY_MEETING_FFMPEG_COMMAND: ffmpeg,
        },
      });

      expect(requestBody).toContain('filename="meeting.mp3"');
      expect(requestBody).toContain('mp3');
      expect(JSON.parse(stdout)).toEqual({
        segments: [{ speaker: 'Speaker 1', text: 'Compressed local transcript.' }],
      });
    } finally {
      await server.close();
    }
  });

  it('transcribes long audio as sequential chunks and restores timeline offsets', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'long.wav');
    const ffmpeg = join(dir, 'ffmpeg');
    const ffprobe = join(dir, 'ffprobe');
    writeFileSync(audio, 'audio');
    writeFileSync(
      ffmpeg,
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('node:fs');",
        "const { basename } = require('node:path');",
        'if (!process.argv.includes("pcm_s16le")) process.exit(3);',
        'if (process.argv.includes("-b:a")) process.exit(4);',
        'const output = process.argv.at(-1);',
        'writeFileSync(output, basename(output));',
      ].join('\n'),
    );
    chmodSync(ffmpeg, 0o755);
    writeFileSync(ffprobe, ['#!/usr/bin/env node', 'process.stdout.write("1320\\n");'].join('\n'));
    chmodSync(ffprobe, 0o755);
    let requests = 0;
    const server = await listen(async (req, res) => {
      requests += 1;
      const body = await readBody(req);
      expect(body).toContain(`meeting-${String(requests - 1).padStart(4, '0')}.wav`);
      res.writeHead(200, { 'content-type': 'application/json' });
      const segments =
        requests === 1
          ? [{ start: 599, end: 601, text: 'Boundary phrase' }]
          : requests === 2
            ? [
                { start: 4, end: 6, text: 'Boundary phrase' },
                { start: 100, end: 101, text: 'Part 2' },
              ]
            : [{ start: 5, end: 6, text: 'Part 3' }];
      res.end(
        JSON.stringify({
          language: 'de',
          segments,
        }),
      );
    });
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
          VERITY_MEETING_CHUNK_SECONDS: '600',
          VERITY_MEETING_CHUNK_OVERLAP_SECONDS: '5',
          VERITY_MEETING_FFMPEG_COMMAND: ffmpeg,
          VERITY_MEETING_FFPROBE_COMMAND: ffprobe,
        },
      });

      expect(requests).toBe(3);
      expect(JSON.parse(stdout)).toEqual({
        language: 'de',
        duration: 1320,
        segments: [
          { speaker: 'Speaker 1', text: 'Boundary phrase', start: 599, end: 601 },
          { speaker: 'Speaker 1', text: 'Part 2', start: 695, end: 696 },
          { speaker: 'Speaker 1', text: 'Part 3', start: 1200, end: 1201 },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('times out stuck local ffmpeg compression before the server turn timeout', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'large.wav');
    const ffmpeg = join(dir, 'ffmpeg');
    writeFileSync(audio, 'audio');
    writeFileSync(
      ffmpeg,
      ['#!/usr/bin/env node', 'setTimeout(() => undefined, 10_000);'].join('\n'),
    );
    chmodSync(ffmpeg, 0o755);

    await expect(
      execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          // Never reached — audio preparation stalls first — but the client
          // refuses to run at all without a configured backend.
          VERITY_TRANSCRIBE_BASE_URL: 'http://127.0.0.1:1/v1',
          VERITY_TRANSCRIBE_MAX_UPLOAD_BYTES: '4',
          VERITY_MEETING_FFMPEG_COMMAND: ffmpeg,
          VERITY_MEETING_FFMPEG_TIMEOUT_MS: '50',
        },
      }),
    ).rejects.toThrow(/ffmpeg timed out while preparing meeting audio/);
  });

  it('reports an unreachable transcription API with a clear, actionable message', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');

    let stderr = '';
    try {
      await execFileAsync(process.execPath, [script, audio], {
        encoding: 'utf8',
        env: {
          ...testEnv(),
          // Port 1 has no listener, so the connection is deterministically refused
          // (no ephemeral-port-reuse race from binding then releasing a real port).
          VERITY_TRANSCRIBE_BASE_URL: 'http://127.0.0.1:1/v1',
          VERITY_TRANSCRIBE_RETRIES: '0',
          VERITY_TRANSCRIBE_TIMEOUT_MS: '5000',
        },
      });
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? '';
    }

    expect(stderr).toContain('Could not reach the transcription API');
    expect(stderr).toContain('/audio/transcriptions');
    // Node's bare "fetch failed" must not be the whole story.
    expect(stderr.trim()).not.toBe('fetch failed');
  });

  it('redacts the API credential from remote error bodies', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    const apiKey = 'remote-secret-key';
    const server = await listen(async (_req, res) => {
      res.statusCode = 401;
      res.end(`credential rejected: ${apiKey}`);
    });
    try {
      let stderr = '';
      try {
        await execFileAsync(process.execPath, [script, audio], {
          encoding: 'utf8',
          env: {
            ...testEnv(),
            VERITY_TRANSCRIBE_BASE_URL: server.baseUrl,
            VERITY_TRANSCRIBE_API_KEY: apiKey,
          },
        });
      } catch (error) {
        stderr = (error as { stderr?: string }).stderr ?? '';
      }
      expect(stderr).toContain('credential rejected: [REDACTED]');
      expect(stderr).not.toContain(apiKey);
    } finally {
      await server.close();
    }
  });

  it('refuses to run when no transcription backend is configured', async () => {
    const dir = makeTmp();
    const audio = join(dir, 'meeting.mp3');
    writeFileSync(audio, 'audio');
    const env = testEnv();
    // Verity bundles no transcription service, so an unset base URL must fail
    // fast and say so — never fall back to a localhost sidecar that no longer
    // exists and time out against it.
    delete env.VERITY_TRANSCRIBE_BASE_URL;

    let stderr = '';
    try {
      await execFileAsync(process.execPath, [script, audio], { encoding: 'utf8', env });
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? '';
    }

    expect(stderr).toContain('No meeting transcription backend is configured');
    expect(stderr).toContain('VERITY_TRANSCRIBE_BASE_URL');
    expect(stderr).not.toContain('127.0.0.1:5092');
  });
});
