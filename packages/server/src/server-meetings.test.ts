import { SealedError } from '@verity/store';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { app, bus, conductor, ctx, worktreeRoot } from './server-fixture.test-helper.js';
import {
  appendMeetingIndex,
  buildServer,
  CommandMeetingTranscriber,
  meetingTranscriptionSettingsWhileSealed,
  removeCancelledMeetingTranscript,
  type MeetingTranscriber,
  type MeetingTranscriptResult,
} from './server.js';

describe('CommandMeetingTranscriber settings', () => {
  it('terminates the transcriber child process when the request is aborted', async () => {
    const commandDir = mkdtempSync(join(tmpdir(), 'verity-transcriber-abort-'));
    const command = join(commandDir, 'transcriber');
    const marker = join(commandDir, 'completed');
    // The bundled client refuses to run without a configured backend, so this
    // case has to reach the child process through a configured one.
    const previousBaseUrl = process.env.VERITY_TRANSCRIBE_BASE_URL;
    process.env.VERITY_TRANSCRIBE_BASE_URL = 'https://environment.test/v1';
    writeFileSync(
      command,
      `#!${process.execPath}\nsetTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 1000);\n`,
    );
    chmodSync(command, 0o755);
    const controller = new AbortController();
    const transcriber = new CommandMeetingTranscriber(command, async () => ({
      transcribeBackendMode: 'external',
      transcribeBaseUrl: 'https://settings.test/v1',
      transcribeApiKey: null,
      transcribeModel: 'test-model',
    }));
    try {
      const running = transcriber.transcribe({
        audio: Buffer.from('audio'),
        mediaType: 'audio/mp4',
        fileName: 'meeting.m4a',
        signal: controller.signal,
      });
      controller.abort();
      await expect(running).rejects.toThrow('meeting transcription was stopped');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.VERITY_TRANSCRIBE_BASE_URL;
      else process.env.VERITY_TRANSCRIBE_BASE_URL = previousBaseUrl;
      rmSync(commandDir, { recursive: true, force: true });
    }
  });

  it('reports meeting transcription unavailable when no backend is configured', async () => {
    const previousBaseUrl = process.env.VERITY_TRANSCRIBE_BASE_URL;
    const previousCommand = process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
    delete process.env.VERITY_TRANSCRIBE_BASE_URL;
    delete process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
    try {
      const transcriber = new CommandMeetingTranscriber(
        'verity-transcribe-meeting',
        async () => undefined,
      );
      // Unavailable, not failed: the route answers 503 "not configured" instead
      // of accepting the recording and reporting a transcription failure.
      await expect(
        transcriber.transcribe({
          audio: Buffer.from('audio'),
          mediaType: 'audio/mp4',
          fileName: 'meeting.m4a',
        }),
      ).rejects.toThrow('meeting transcription is not configured');
    } finally {
      if (previousBaseUrl === undefined) delete process.env.VERITY_TRANSCRIBE_BASE_URL;
      else process.env.VERITY_TRANSCRIBE_BASE_URL = previousBaseUrl;
      if (previousCommand === undefined) delete process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
      else process.env.VERITY_MEETING_TRANSCRIBE_COMMAND = previousCommand;
    }
  });

  it('keeps a stored local mode credential-free and fails external mode closed while sealed', () => {
    expect(
      meetingTranscriptionSettingsWhileSealed({
        transcribeBackendMode: 'local',
        transcribeBaseUrl: 'https://stale-cloud.example.test/v1',
        transcribeApiKey: 'encrypted-value',
        transcribeModel: 'stale-model',
      }),
    ).toEqual({
      transcribeBackendMode: 'local',
      transcribeBaseUrl: null,
      transcribeApiKey: null,
      transcribeModel: null,
    });
    expect(() =>
      meetingTranscriptionSettingsWhileSealed({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://cloud.example.test/v1',
        transcribeApiKey: 'encrypted-value',
        transcribeModel: 'cloud-model',
      }),
    ).toThrow(SealedError);
  });

  it('reports a stored local choice unavailable instead of using an inherited cloud URL', async () => {
    const original = {
      command: process.env.VERITY_MEETING_TRANSCRIBE_COMMAND,
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
    };
    const script =
      'console.log(JSON.stringify({segments:[{text:process.env.VERITY_TRANSCRIBE_BASE_URL}]}))';
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    process.env.VERITY_MEETING_TRANSCRIBE_COMMAND = command;
    process.env.VERITY_TRANSCRIBE_BASE_URL = 'https://cloud.example.test/v1';
    try {
      const transcriber = new CommandMeetingTranscriber(command, async () => ({
        transcribeBackendMode: 'local',
        transcribeBaseUrl: 'https://stored-cloud.example.test/v1',
        transcribeApiKey: 'stored-key',
        transcribeModel: 'stored-model',
      }));
      // The bundled local backend is gone. A recording chosen for it must not be
      // shipped to whichever remote backend the deployment happens to carry.
      await expect(
        transcriber.transcribe({
          audio: Buffer.from('audio'),
          mediaType: 'audio/mp4',
          fileName: 'meeting.m4a',
        }),
      ).rejects.toThrow('meeting transcription is not configured');
    } finally {
      const envNames = {
        command: 'VERITY_MEETING_TRANSCRIBE_COMMAND',
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  it('ignores a deployment-supplied transcriber command', async () => {
    const original = {
      command: process.env.VERITY_MEETING_TRANSCRIBE_COMMAND,
      baseUrl: process.env.VERITY_TRANSCRIBE_BASE_URL,
      apiKey: process.env.VERITY_TRANSCRIBE_API_KEY,
      model: process.env.VERITY_TRANSCRIBE_MODEL,
    };
    const script = "console.log(JSON.stringify({segments:[{text:'custom-command-transcript'}]}))";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    // The deployment shape from the finding: its own transcriber command and no
    // OpenAI-compatible endpoint anywhere.
    process.env.VERITY_MEETING_TRANSCRIBE_COMMAND = command;
    delete process.env.VERITY_TRANSCRIBE_BASE_URL;
    delete process.env.VERITY_TRANSCRIBE_API_KEY;
    delete process.env.VERITY_TRANSCRIBE_MODEL;
    const externalWithoutEndpoint = async () => ({
      transcribeBackendMode: 'external' as const,
      transcribeBaseUrl: null,
      transcribeApiKey: null,
      transcribeModel: null,
    });
    try {
      // A deployment variable must not restore the retired arbitrary-command
      // path. Only encrypted Settings can make transcription ready.
      const withCommand = new CommandMeetingTranscriber(command, externalWithoutEndpoint);
      await expect(
        withCommand.transcribe({
          audio: Buffer.from('audio'),
          mediaType: 'audio/mp4',
          fileName: 'meeting.m4a',
        }),
      ).rejects.toThrow('External meeting transcription is not configured');

      // The inverse still fails closed: no command and no endpoint means the
      // recording has nowhere to go, and saying so beats uploading it first.
      delete process.env.VERITY_MEETING_TRANSCRIBE_COMMAND;
      const withoutCommand = new CommandMeetingTranscriber(
        'verity-transcribe-meeting',
        externalWithoutEndpoint,
      );
      await expect(
        withoutCommand.transcribe({
          audio: Buffer.from('audio'),
          mediaType: 'audio/mp4',
          fileName: 'meeting.m4a',
        }),
      ).rejects.toThrow('External meeting transcription is not configured');
    } finally {
      const envNames = {
        command: 'VERITY_MEETING_TRANSCRIBE_COMMAND',
        baseUrl: 'VERITY_TRANSCRIBE_BASE_URL',
        apiKey: 'VERITY_TRANSCRIBE_API_KEY',
        model: 'VERITY_TRANSCRIBE_MODEL',
      } as const;
      for (const [key, value] of Object.entries(original)) {
        const envName = envNames[key as keyof typeof envNames];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });
});

describe('POST /sessions/:id/meetings/transcripts', () => {
  it('404s unknown sessions before transcription', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/missing/meetings/transcripts',
      payload: {
        fileName: 'planning.m4a',
        mediaType: 'audio/mp4',
        data: Buffer.from('audio').toString('base64'),
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('transcribes meeting audio into a markdown file and index entry', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-test-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'verity-meeting-knowledge-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      dataRoot,
      meetingTranscriber: {
        transcribe: async (input) => {
          expect(input.fileName).toBe('planning.m4a');
          expect(input.mediaType).toBe('audio/mp4');
          expect(input.audio.toString('utf8')).toBe('audio');
          return {
            language: 'en',
            duration: 125,
            segments: [
              { speaker: 'Alice', start: 0, text: 'Ship the RAG recovery.' },
              { speaker: 'Bob', start: 62, text: 'Keep the index updated.' },
            ],
          };
        },
      },
    });
    try {
      await ctx.store.upsertProject({
        id: 'meeting-project',
        owner: 'test',
        repo: 'meeting',
        containerName: 'meeting-project',
        state: 'active',
      });
      await ctx.store.createSession({
        sessionId: 's1',
        worktree,
        model: 'm',
        projectId: 'meeting-project',
      });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
          title: 'Planning Sync',
          clientRequestId: 'upload-1',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ path: string; title: string; segments: number }>();
      expect(body).toMatchObject({
        title: 'Planning Sync',
        segments: 2,
      });
      expect(body.path).toMatch(
        /^sources\/meetings\/\d{4}-\d{2}-\d{2}-planning-sync-[a-f0-9]{8}\.md$/,
      );
      const knowledgeRoot = join(dataRoot, 'knowledge', 'meeting-project');
      const transcript = readFileSync(join(knowledgeRoot, body.path), 'utf8');
      expect(transcript).toContain('# Planning Sync');
      expect(transcript).toContain('- Language: en');
      expect(transcript).toContain('**Alice** (00:00): Ship the RAG recovery.');
      expect(transcript).toContain('**Bob** (01:02): Keep the index updated.');
      const fileName = body.path.split('/').at(-1) ?? '';
      expect(fileName).not.toBe('');
      expect(readFileSync(join(knowledgeRoot, 'sources/meetings', 'index.md'), 'utf8')).toContain(
        `- [Planning Sync](${fileName})`,
      );
      const audioName = fileName.replace(/\.md$/u, '.m4a');
      expect(readFileSync(join(knowledgeRoot, 'sources/meetings', audioName), 'utf8')).toBe(
        'audio',
      );
      expect(lstatSync(join(knowledgeRoot, 'sources/meetings', audioName)).mode & 0o777).toBe(
        0o644,
      );
      expect(
        readFileSync(join(knowledgeRoot, '.text', 'sources/meetings', `${audioName}.md`), 'utf8'),
      ).toContain('Ship the RAG recovery.');
      const events = await ctx.store.getEvents('s1');
      expect(events.filter((event) => event.t === 'notice')).toEqual([
        {
          t: 'notice',
          role: 'operator',
          clientRequestId: 'upload-1',
          text: 'Please transcribe meeting audio:\nplanning.m4a',
        },
        {
          t: 'notice',
          role: 'agent',
          text: 'Transcribing meeting audio\nplanning.m4a',
        },
        {
          t: 'notice',
          role: 'agent',
          text: expect.stringContaining(`Meeting transcript saved: [${body.path}](${body.path})`),
        },
      ]);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('files an ended live meeting into project knowledge and links it in the session', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-live-meeting-test-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'verity-live-meeting-knowledge-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      dataRoot,
    });
    const url = '/sessions/s1/live-meetings/live-1';
    const meeting = {
      title: 'Pricing [sync]',
      engine: 'fluid-nemotron',
      startedAt: Date.UTC(2026, 9, 1, 9, 30),
      endedAt: Date.UTC(2026, 9, 1, 9, 45),
      state: 'ended',
      transcript: 'We ship on Friday.',
      timedWords: [{ text: 'We ship on Friday.', start: 4, end: 6 }],
      speakerTurns: [
        { speaker: 0, start: 3, end: 7 },
        { speaker: 1, start: 8, end: 9 },
      ],
      speakerMerges: { '1': 0 },
      captureStatus: 'listening',
      ownerToken: 'o'.repeat(64),
      revision: 2,
    };
    try {
      await ctx.store.upsertProject({
        id: 'meeting-project',
        owner: 'test',
        repo: 'meeting',
        containerName: 'meeting-project',
        state: 'active',
      });
      await ctx.store.createSession({
        sessionId: 's1',
        worktree,
        model: 'm',
        projectId: 'meeting-project',
      });
      expect((await meetingApp.inject({ method: 'PUT', url, payload: meeting })).statusCode).toBe(
        200,
      );
      expect(
        (
          await meetingApp.inject({
            method: 'PUT',
            url: `${url}/notes/n1`,
            payload: { atSeconds: 5, text: 'Friday release', revision: 1 },
          })
        ).statusCode,
      ).toBe(200);

      const notices = async () =>
        (await ctx.store.getEvents('s1')).filter((event) => event.t === 'notice');
      await vi.waitFor(async () => expect((await notices()).length).toBeGreaterThanOrEqual(1));
      const [notice] = await notices();
      expect(notice?.t === 'notice' && notice.text).toContain('[Pricing \\[sync\\]]');
      const details = JSON.parse(
        (notice?.t === 'notice' ? notice.text : '')
          .split('<!-- verity-meeting: ')[1]!
          .split(' -->')[0]!,
      );
      expect(details).toMatchObject({
        sessionId: 's1',
        meetingId: 'live-1',
        durationMinutes: 15,
        people: 1,
        answers: 0,
      });
      const link = /\]\((\/knowledge\/sources\/meetings\/[^)]+\.md)\)/.exec(
        notice?.t === 'notice' ? notice.text : '',
      )?.[1];
      expect(link).toMatch(
        /^\/knowledge\/sources\/meetings\/2026-10-01-live-meeting-[a-f0-9]{8}\.md$/,
      );
      const knowledgeRoot = join(dataRoot, 'knowledge', 'meeting-project');
      const filed = join(knowledgeRoot, link!.slice('/knowledge/'.length));
      // The last note reaches the server after the ended meeting and still lands in the file.
      await vi.waitFor(() =>
        expect(readFileSync(filed, 'utf8')).toContain('(00:05) Friday release'),
      );
      expect(readFileSync(filed, 'utf8')).toContain('**Speaker 1** (00:04): We ship on Friday.');
      expect(readFileSync(join(knowledgeRoot, 'sources/meetings/index.md'), 'utf8')).toContain(
        `- [Pricing \\[sync\\]](${link!.split('/').at(-1)})`,
      );

      // Late edits must refresh the card as well as the filed document.
      await meetingApp.inject({
        method: 'PUT',
        url,
        payload: { ...meeting, speakerNames: { '0': 'Anna' }, speakerMerges: {}, revision: 3 },
      });
      await vi.waitFor(() =>
        expect(readFileSync(filed, 'utf8')).toContain('**Anna** (00:04): We ship on Friday.'),
      );
      await vi.waitFor(async () => {
        const latest = (await notices()).at(-1)!;
        expect(latest.t === 'notice' && latest.text).toContain('"people":2');
        expect(latest.t === 'notice' && latest.text).toContain('"notes":1');
      });
      const count = (await notices()).length;
      await meetingApp.inject({
        method: 'PUT',
        url: `${url}/notes/n1`,
        payload: { atSeconds: 5, text: 'Friday release', revision: 2 },
      });
      await vi.waitFor(() => expect(readFileSync(filed, 'utf8')).toContain('Friday release'));
      expect(await notices()).toHaveLength(count);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('streams long audio and continues transcription after returning 202', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-stream-test-'));
    let finishTranscription!: (value: MeetingTranscriptResult) => void;
    const transcription = new Promise<MeetingTranscriptResult>((resolve) => {
      finishTranscription = resolve;
    });
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      meetingTranscriber: {
        transcribe: async (input) => {
          expect(input.audio).toHaveLength(0);
          expect(input.audioPath).toBeTruthy();
          expect(readFileSync(input.audioPath!, 'utf8')).toBe('long audio');
          return transcription;
        },
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 'streamed', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/streamed/meetings/transcripts/stream',
        headers: {
          'content-type': 'application/octet-stream',
          'x-verity-meeting-file-name': 'planning.m4a',
          'x-verity-meeting-media-type': 'audio%2Fmp4',
          'x-verity-meeting-title': 'Planning',
          'x-verity-meeting-client-request-id': 'stream-upload-1',
        },
        payload: Buffer.from('long audio'),
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true });
      expect((await meetingApp.inject('/sessions/streamed/activity')).json().busy).toBe(true);
      expect(await ctx.store.getEvents('streamed')).toContainEqual({
        t: 'notice',
        role: 'operator',
        clientRequestId: 'stream-upload-1',
        text: 'Please transcribe meeting audio:\nplanning.m4a',
      });

      finishTranscription({ segments: [{ speaker: 'Alice', text: 'Background complete.' }] });
      await vi.waitFor(() => {
        const files = readdirSync(join(worktree, 'docs/meetings'));
        const transcript = files.find((file) => file.endsWith('.md') && file !== 'index.md');
        expect(transcript).toBeTruthy();
        expect(readFileSync(join(worktree, 'docs/meetings', transcript!), 'utf8')).toContain(
          'Background complete.',
        );
      });
      await vi.waitFor(async () => {
        expect((await meetingApp.inject('/sessions/streamed/activity')).json().busy).toBe(false);
      });
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // Same wire problem as session-file uploads: expo/fetch puts the picked audio
  // file's own MIME type on the request in place of the octet-stream the client
  // asked for. The route takes the real media type from its own header anyway.
  it('streams audio uploaded under the media type the picked file carries', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-mime-test-'));
    let staged = '';
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      meetingTranscriber: {
        transcribe: async (input) => {
          staged = readFileSync(input.audioPath!, 'utf8');
          return { segments: [{ speaker: 'Alice', text: 'Done.' }] };
        },
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 'typed-audio', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/typed-audio/meetings/transcripts/stream',
        headers: {
          'content-type': 'audio/mp4',
          'x-verity-meeting-file-name': 'planning.m4a',
          'x-verity-meeting-media-type': 'audio%2Fmp4',
          'x-verity-meeting-title': 'Planning',
          'x-verity-meeting-client-request-id': 'typed-audio-1',
        },
        payload: Buffer.from('typed audio'),
      });

      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => {
        expect(staged).toBe('typed audio');
      });
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('stops background transcription server-side without leaving transcript artifacts', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-cancel-test-'));
    let observedAbort = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: (input) =>
          new Promise<MeetingTranscriptResult>((_resolve, reject) => {
            markStarted();
            input.signal?.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 'cancel-meeting', worktree, model: 'm' });
      const upload = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/cancel-meeting/meetings/transcripts/stream',
        headers: {
          'content-type': 'application/octet-stream',
          'x-verity-meeting-file-name': 'planning.m4a',
          'x-verity-meeting-media-type': 'audio%2Fmp4',
        },
        payload: Buffer.from('long audio'),
      });
      expect(upload.statusCode).toBe(202);
      await started;
      expect((await meetingApp.inject('/sessions/cancel-meeting/activity')).json().busy).toBe(true);

      const stopped = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/cancel-meeting/cancel',
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toMatchObject({ cancelled: true, droppedQueued: [] });
      await vi.waitFor(() => expect(observedAbort).toBe(true));
      await vi.waitFor(async () => {
        expect((await meetingApp.inject('/sessions/cancel-meeting/activity')).json().busy).toBe(
          false,
        );
      });
      const meetingDir = join(worktree, 'docs', 'meetings');
      expect(readdirSync(meetingDir).filter((file) => file.endsWith('.md'))).toEqual([]);
      expect(await ctx.store.getEvents('cancel-meeting')).toContainEqual({
        t: 'notice',
        role: 'agent',
        text: 'Meeting transcription stopped\nplanning.m4a',
      });
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('rejects unsupported meeting uploads before transcription', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-missing-'));
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          data: Buffer.from('audio').toString('base64'),
        },
      });
      expect(res.statusCode).toBe(415);
      expect(await ctx.store.getEvents('s1')).toEqual([
        {
          t: 'notice',
          role: 'operator',
          text: 'Please transcribe meeting audio:\nnotes.txt',
        },
        {
          t: 'notice',
          role: 'agent',
          text: expect.stringContaining('Unsupported audio file.'),
        },
      ]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('uses the bundled meeting transcriber command by default', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-default-command-'));
    const commandDir = mkdtempSync(join(tmpdir(), 'verity-meeting-command-bin-'));
    const command = join(commandDir, 'verity-transcribe-meeting');
    writeFileSync(
      command,
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({',
        '  segments: [{ speaker: "Speaker 1", text: "Default local transcript.", start: 2 }],',
        '  language: "en",',
        '  duration: 5',
        '}));',
      ].join('\n'),
    );
    chmodSync(command, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${commandDir}${delimiter}${previousPath ?? ''}`;
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
    });
    try {
      await ctx.store.updateVeritySettings({
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://settings.test/v1',
        transcribeApiKey: null,
        transcribeModel: 'test-model',
      });
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'default.mp3',
          mediaType: 'audio/mpeg',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ path: string; segments: number }>();
      expect(body.segments).toBe(1);
      const transcript = readFileSync(join(worktree, body.path), 'utf8');
      expect(transcript).toContain('- Language: en');
      expect(transcript).toContain('- Duration: 00:05');
      expect(transcript).toContain('**Speaker 1** (00:02): Default local transcript.');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
      rmSync(commandDir, { recursive: true, force: true });
    }
  });

  it('can suppress the operator request notice for spawn-seeded meeting uploads', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-suppress-request-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      meetingTranscriber: {
        transcribe: async () => ({
          segments: [{ speaker: 'Alice', text: 'Spawn upload transcript.' }],
        }),
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'spawn.mp3',
          mediaType: 'audio/mpeg',
          data: Buffer.from('audio').toString('base64'),
          announceRequest: false,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(await ctx.store.getEvents('s1')).toEqual([
        {
          t: 'notice',
          role: 'agent',
          text: 'Transcribing meeting audio\nspawn.mp3',
        },
        {
          t: 'notice',
          role: 'agent',
          text: expect.stringContaining('Meeting transcript saved:'),
        },
      ]);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('accepts known audio extensions when the media type is generic', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-extension-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: async () => ({
          duration: 3661,
          segments: [{ speaker: '  ', start: -2, text: 'Generic media type accepted.' }],
        }),
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: '---.mp3',
          mediaType: 'application/octet-stream',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ path: string; title: string }>();
      expect(body.title).toBe('Meeting');
      const transcript = readFileSync(join(worktree, body.path), 'utf8');
      expect(transcript).toContain('- Duration: 1:01:01');
      expect(transcript).toContain('**Speaker** (00:00): Generic media type accepted.');
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it.each(['wav', 'aac', 'ogg', 'opus', 'webm', 'flac'])(
    'accepts .%s meeting audio uploads with a generic media type',
    async (ext) => {
      const worktree = mkdtempSync(join(tmpdir(), `verity-meeting-${ext}-`));
      const transcribe = vi.fn<MeetingTranscriber['transcribe']>(async (input) => {
        expect(input.fileName).toBe(`sample.${ext}`);
        expect(input.mediaType).toBe('application/octet-stream');
        expect(input.audio.toString('utf8')).toBe(`audio-${ext}`);
        return {
          segments: [{ speaker: 'Alice', text: `Generic ${ext} upload accepted.` }],
        };
      });
      const meetingApp = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        meetingTranscriber: { transcribe },
      });
      try {
        await ctx.store.createSession({ sessionId: `s-${ext}`, worktree, model: 'm' });
        const res = await meetingApp.inject({
          method: 'POST',
          url: `/sessions/s-${ext}/meetings/transcripts`,
          payload: {
            fileName: `sample.${ext}`,
            mediaType: 'application/octet-stream',
            data: Buffer.from(`audio-${ext}`).toString('base64'),
          },
        });

        expect(res.statusCode).toBe(200);
        expect(transcribe).toHaveBeenCalledOnce();
      } finally {
        await meetingApp.close();
        rmSync(worktree, { recursive: true, force: true });
      }
    },
  );

  it('rejects transcriptions that return no usable text', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-empty-transcript-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: async () => ({
          segments: [{ speaker: 'Alice', text: '   ' }],
        }),
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'empty.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'meeting transcription returned no text' });
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('rejects empty meeting audio uploads', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-empty-audio-'));
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'empty.m4a',
          mediaType: 'audio/mp4',
          data: '====',
        },
      });

      expect(res.statusCode).toBe(400);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated meeting transcript uploads', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-duplicate-'));
    const transcribe = vi.fn().mockResolvedValue({
      segments: [{ speaker: 'Alice', text: 'Same audio can be retried.' }],
    });
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: { transcribe },
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const payload = {
        fileName: 'planning.m4a',
        mediaType: 'audio/mp4',
        data: Buffer.from('audio').toString('base64'),
        title: 'Planning Sync',
      };

      const first = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload,
      });
      const second = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstBody = first.json<{ path: string }>();
      const secondBody = second.json<{ path: string; segments: number }>();
      expect(secondBody.path).toBe(firstBody.path);
      expect(secondBody.segments).toBe(1);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(readFileSync(join(worktree, firstBody.path), 'utf8')).toContain(
        'Same audio can be retried.',
      );
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('repairs the meeting index when a duplicate transcript already exists', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-index-repair-'));
    const transcribe = vi.fn().mockResolvedValue({
      segments: [{ speaker: 'Alice', text: 'This should already exist.' }],
    });
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: { transcribe },
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
      const first = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
          title: 'Planning Sync',
        },
      });
      expect(first.statusCode).toBe(200);
      rmSync(join(worktree, 'docs', 'meetings', 'index.md'), { force: true });

      const second = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
          title: 'Planning Sync',
        },
      });

      expect(second.statusCode).toBe(200);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(readFileSync(join(worktree, 'docs', 'meetings', 'index.md'), 'utf8')).toContain(
        '- [Planning Sync](',
      );
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('does not write meeting transcripts through a symlinked meeting directory', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'verity-meeting-outside-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: async () => ({
          segments: [{ speaker: 'Alice', text: 'Do not write outside.' }],
        }),
      },
    });
    try {
      mkdirSync(join(worktree, 'docs'), { recursive: true });
      symlinkSync(outside, join(worktree, 'docs', 'meetings'));
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(500);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not write meeting transcripts through a meeting directory symlink inside the worktree', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-inner-symlink-'));
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: async () => ({
          segments: [{ speaker: 'Alice', text: 'Do not write at root.' }],
        }),
      },
    });
    try {
      mkdirSync(join(worktree, 'docs'), { recursive: true });
      symlinkSync(worktree, join(worktree, 'docs', 'meetings'));
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(500);
      expect(readdirSync(worktree).sort()).toEqual(['docs']);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('does not update a symlinked meeting index', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-index-symlink-'));
    const outside = join(worktree, 'outside-index.md');
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: async () => ({
          segments: [{ speaker: 'Alice', text: 'Do not touch the symlink target.' }],
        }),
      },
    });
    try {
      mkdirSync(join(worktree, 'docs', 'meetings'), { recursive: true });
      writeFileSync(outside, 'outside\n');
      symlinkSync(outside, join(worktree, 'docs', 'meetings', 'index.md'));
      await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

      const res = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'planning.m4a',
          mediaType: 'audio/mp4',
          data: Buffer.from('audio').toString('base64'),
        },
      });

      expect(res.statusCode).toBe(500);
      expect(readFileSync(outside, 'utf8')).toBe('outside\n');
      expect(existsSync(join(worktree, 'docs', 'meetings', 'index.md'))).toBe(true);
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

it('removes a cancelled transcript and its punctuated title from the meeting index', async () => {
  const meetingDir = mkdtempSync(join(tmpdir(), 'verity-meeting-index-'));
  const title = String.raw`Planning [Q1] \ review`;
  try {
    writeFileSync(join(meetingDir, 'removed.md'), '# Transcript');
    await appendMeetingIndex(meetingDir, 'removed.md', title);
    await appendMeetingIndex(meetingDir, 'kept.md', 'Another meeting');
    expect(readFileSync(join(meetingDir, 'index.md'), 'utf8')).toContain('(removed.md)');
    await removeCancelledMeetingTranscript({ meetingDir, relPath: 'removed.md', title });
    expect(existsSync(join(meetingDir, 'removed.md'))).toBe(false);
    const index = readFileSync(join(meetingDir, 'index.md'), 'utf8');
    expect(index).not.toContain('(removed.md)');
    expect(index).toContain('(kept.md)');
  } finally {
    rmSync(meetingDir, { recursive: true, force: true });
  }
});

it('replaces a meeting index entry by transcript path when the title changes', async () => {
  const meetingDir = mkdtempSync(join(tmpdir(), 'verity-meeting-index-title-'));
  try {
    await appendMeetingIndex(meetingDir, 'meeting.md', 'Original title');
    await appendMeetingIndex(meetingDir, 'other.md', 'Other meeting');
    await appendMeetingIndex(meetingDir, 'meeting.md', 'Updated [title]');
    const index = readFileSync(join(meetingDir, 'index.md'), 'utf8');
    expect(index.match(/\]\(meeting\.md\)/g)).toHaveLength(1);
    expect(index).not.toContain('Original title');
    expect(index).toContain('Updated');
    expect(index).toContain('(other.md)');
  } finally {
    rmSync(meetingDir, { recursive: true, force: true });
  }
});
