// End-to-end cover for the seam no other meeting-audio test spans.
//
// `server.test.ts` exercises the route against a stub transcriber, and
// `scripts/verity-transcribe-meeting.test.ts` exercises the bundled script against a
// stub backend — so each half is verified against a fake of the other. This test
// runs the REAL script (deploy/bin, resolved off PATH the way the deployed image
// resolves it) from the REAL route against a stub transcription HTTP endpoint, which is
// what catches drift in the contract between them: the argv shape the route
// invokes with (`--json --diarize <path>`), the `VERITY_AUDIO_FILE` env hand-off,
// and the JSON envelope the route parses back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryEventBus } from '@verity/session';
import type { Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const DEPLOY_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/bin');

let ctx: TestDb;
let bus: InMemoryEventBus;
let worktree: string;
const cleanup: (() => Promise<void> | void)[] = [];

// The route reads its transcriber configuration from the process environment, so
// each test mutates it and restores it here rather than leaking into the suite.
const ENV_KEYS = [
  'PATH',
  'VERITY_MEETING_TRANSCRIBE_COMMAND',
  'VERITY_TRANSCRIBE_BASE_URL',
  'VERITY_TRANSCRIBE_RETRIES',
  'VERITY_MEETING_CHUNK_SECONDS',
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function useBundledTranscriber(transcriptionBaseUrl: string): void {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  // No VERITY_MEETING_TRANSCRIBE_COMMAND: take the route's default path, which
  // execs the bare `verity-transcribe-meeting` name off PATH.
  delete process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
  process.env.PATH = `${DEPLOY_BIN}${delimiter}${savedEnv.PATH ?? ''}`;
  process.env.VERITY_TRANSCRIBE_BASE_URL = transcriptionBaseUrl;
  process.env.VERITY_TRANSCRIBE_RETRIES = '0';
  process.env.VERITY_MEETING_CHUNK_SECONDS = '0';
}

function listenTranscriptionApi(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  bus = new InMemoryEventBus();
  worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-e2e-'));
  await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  rmSync(worktree, { recursive: true, force: true });
});

function meetingServer() {
  const app = buildServer({
    eventStore: ctx.store,
    bus,
    conductor: {} as unknown as Conductor,
  });
  cleanup.push(() => app.close());
  return app;
}

async function uploadAudio(app: ReturnType<typeof meetingServer>, fileName = 'weekly-sync.m4a') {
  return app.inject({
    method: 'POST',
    url: '/sessions/s1/meetings/transcripts',
    payload: {
      fileName,
      mediaType: 'audio/mp4',
      data: Buffer.from('fake m4a bytes').toString('base64'),
    },
  });
}

async function notices(): Promise<string[]> {
  const events = await ctx.store.getEvents('s1');
  return events.flatMap((event) => (event.t === 'notice' ? [event.text] : []));
}

describe('meeting audio via the bundled transcriber', () => {
  it('carries diarized transcription API output into a committed markdown transcript', async () => {
    let uploadedContentType = '';
    let uploadedBody = '';
    const baseUrl = await listenTranscriptionApi((req, res) => {
      uploadedContentType = req.headers['content-type'] ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        uploadedBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            language: 'de',
            duration: 91.5,
            segments: [
              {
                speaker: 'Speaker 1',
                start: 0,
                end: 12,
                text: 'Wir aktivieren die Transkription.',
              },
              { speaker: 'Speaker 2', start: 74, end: 91, text: 'Und testen sie einmal komplett.' },
            ],
          }),
        );
      });
    });
    useBundledTranscriber(baseUrl);

    const res = await uploadAudio(meetingServer());

    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; title: string; segments: number }>();
    expect(body).toMatchObject({ title: 'weekly sync', segments: 2 });
    expect(body.path).toMatch(/^docs\/meetings\/\d{4}-\d{2}-\d{2}-weekly-sync-[a-f0-9]{8}\.md$/);

    // The script must have posted a real multipart upload with the audio the route
    // handed it, not an empty or re-encoded body.
    expect(uploadedContentType).toContain('multipart/form-data');
    expect(uploadedBody).toContain('name="model"');
    expect(uploadedBody).toContain('name="response_format"');
    expect(uploadedBody).toContain('verbose_json');
    expect(uploadedBody).toContain('fake m4a bytes');

    const transcript = readFileSync(join(worktree, body.path), 'utf8');
    expect(transcript).toContain('# weekly sync');
    expect(transcript).toContain('- Language: de');
    expect(transcript).toContain('- Duration: 01:31');
    expect(transcript).toContain('**Speaker 1** (00:00): Wir aktivieren die Transkription.');
    expect(transcript).toContain('**Speaker 2** (01:14): Und testen sie einmal komplett.');

    const fileName = body.path.split('/').at(-1) ?? '';
    expect(readFileSync(join(worktree, 'docs/meetings/index.md'), 'utf8')).toContain(
      `- [weekly sync](${fileName})`,
    );

    expect(await notices()).toEqual([
      'Please transcribe meeting audio:\nweekly-sync.m4a',
      'Transcribing meeting audio\nweekly-sync.m4a',
      expect.stringContaining(`Meeting transcript saved: [${body.path}](${body.path})`),
    ]);
  });

  it('normalizes a plain-text transcription API answer into one speaker segment', async () => {
    const baseUrl = await listenTranscriptionApi((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: 'Single block of speech.' }));
      });
    });
    useBundledTranscriber(baseUrl);

    const res = await uploadAudio(meetingServer());

    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; segments: number }>();
    expect(body.segments).toBe(1);
    expect(readFileSync(join(worktree, body.path), 'utf8')).toContain(
      '**Speaker 1:** Single block of speech.',
    );
  });

  it('tells the operator which backend is unreachable instead of a generic failure', async () => {
    // Port 1 has no listener: the connection is refused immediately, so this
    // asserts the real ECONNREFUSED wording travels script → route → chat notice.
    useBundledTranscriber('http://127.0.0.1:1/v1');

    const res = await uploadAudio(meetingServer());

    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toBe('meeting transcription failed');
    const failure = (await notices()).at(-1) ?? '';
    expect(failure).toContain('Could not transcribe meeting audio\nweekly-sync.m4a');
    expect(failure).toContain('Could not reach the transcription API at');
    expect(failure).toContain('http://127.0.0.1:1/v1/audio/transcriptions');
  });

  it('reports an unusable transcription API response rather than writing an empty transcript', async () => {
    const baseUrl = await listenTranscriptionApi((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = 500;
        res.end('model failed to load');
      });
    });
    useBundledTranscriber(baseUrl);

    const res = await uploadAudio(meetingServer());

    expect(res.statusCode).toBe(502);
    const failure = (await notices()).at(-1) ?? '';
    expect(failure).toContain('Transcription API request failed with HTTP 500');
    expect(failure).toContain('model failed to load');
  });
});
