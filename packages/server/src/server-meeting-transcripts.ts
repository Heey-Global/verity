import { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createWriteStream, constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import './fastify-augmentation.js';
import { writeKnowledgeExtraction } from './knowledge-file-ingest.js';
import { KNOWLEDGE_MEETINGS_DIR } from './knowledge-folder.js';
import { registerMeetingTranscriptRoutes } from './meeting-transcript-routes.js';
import {
  appendMeetingIndex,
  DEFAULT_MEETING_AUDIO_STREAM_BYTES,
  emitMeetingTranscriptCancelled,
  emitMeetingTranscriptFailed,
  emitMeetingTranscriptProgress,
  emitMeetingTranscriptRequest,
  emitMeetingTranscriptSaved,
  ensureLegacyMeetingDirectory,
  ensureMeetingDirectory,
  existingMeetingTranscript,
  isSupportedMeetingAudio,
  meetingAudioHash,
  MeetingAudioTooLargeError,
  type MeetingTranscriber,
  MeetingTranscriberUnavailableError,
  MeetingTranscriptionCancelledError,
  MeetingTranscriptionFailedError,
  type MeetingTranscriptResult,
  removeCancelledMeetingTranscript,
  renderMeetingTranscriptMarkdown,
  slugifyMeetingTitle,
  withMeetingTranscriptCommitLock,
  writeMeetingTranscript,
} from './meeting-transcription.js';
import type { ServerDeps } from './server-deps.js';
export function createMeetingTranscriptController(
  app: FastifyInstance,
  deps: Pick<ServerDeps, 'eventStore' | 'bus' | 'dataRoot'>,
  meetingTranscriber: MeetingTranscriber,
) {
  const backgroundMeetingJobs = new Set<Promise<void>>();

  const meetingJobsBySession = new Map<string, Set<AbortController>>();

  const cancellableMeetingJobsBySession = new Map<string, Set<AbortController>>();

  const maxConcurrentMeetingJobs = 2;

  let activeMeetingJobs = 0;

  const registerMeetingJob = (sessionId: string): AbortController => {
    const controller = new AbortController();
    const jobs = meetingJobsBySession.get(sessionId) ?? new Set<AbortController>();
    jobs.add(controller);
    meetingJobsBySession.set(sessionId, jobs);
    const cancellable = cancellableMeetingJobsBySession.get(sessionId) ?? new Set();
    cancellable.add(controller);
    cancellableMeetingJobsBySession.set(sessionId, cancellable);
    return controller;
  };

  const makeMeetingJobNonCancellable = (sessionId: string, controller: AbortController): void => {
    const jobs = cancellableMeetingJobsBySession.get(sessionId);
    jobs?.delete(controller);
    if (jobs?.size === 0) cancellableMeetingJobsBySession.delete(sessionId);
  };

  const releaseMeetingJob = (sessionId: string, controller: AbortController): void => {
    makeMeetingJobNonCancellable(sessionId, controller);
    const jobs = meetingJobsBySession.get(sessionId);
    jobs?.delete(controller);
    if (jobs?.size === 0) meetingJobsBySession.delete(sessionId);
  };

  const cancelMeetingJobs = (sessionId: string): boolean => {
    const jobs = cancellableMeetingJobsBySession.get(sessionId);
    if (!jobs || jobs.size === 0) return false;
    for (const controller of jobs) controller.abort();
    return true;
  };

  const hasMeetingJob = (sessionId: string): boolean =>
    (meetingJobsBySession.get(sessionId)?.size ?? 0) > 0;

  // A graceful deploy waits for accepted recordings instead of deleting their
  // staging files midway through transcription.
  app.addHook('onClose', async () => {
    await Promise.allSettled(backgroundMeetingJobs);
  });
  return {
    hasMeetingJob,
    cancelMeetingJobs,
    registerRoutes() {
      registerMeetingTranscriptRoutes(app, {
        save: async (request, reply, id, body) => {
          const session = await deps.eventStore.getSession(id);
          if (!session) {
            reply.code(404);
            return { error: `session ${id} not found` };
          }
          if (deps.dataRoot && !session.projectId) {
            reply.code(409);
            return { error: 'meeting knowledge storage requires a project session' };
          }
          if (body.announceRequest !== false) {
            await emitMeetingTranscriptRequest({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: body.fileName,
              ...(body.clientRequestId ? { clientRequestId: body.clientRequestId } : {}),
            });
          }
          if (!isSupportedMeetingAudio(body.mediaType, body.fileName)) {
            await emitMeetingTranscriptFailed({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: body.fileName,
              reason:
                'Unsupported audio file. Choose an audio recording such as MP3, M4A, WAV, AAC, OGG, OPUS, WEBM, or FLAC.',
            });
            reply.code(415);
            return { error: 'unsupported audio file' };
          }

          const audio = Buffer.from(body.data, 'base64');
          if (audio.length === 0) {
            await emitMeetingTranscriptFailed({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: body.fileName,
              reason: 'The selected audio file is empty.',
            });
            reply.code(400);
            return { error: 'audio file is empty' };
          }

          const now = new Date();
          const sourceTitle =
            body.title ??
            basename(body.fileName, extname(body.fileName)).replace(/[_-]+/g, ' ').trim() ??
            'Meeting';
          const title = sourceTitle || 'Meeting';
          const slug = slugifyMeetingTitle(title);
          const hash = createHash('sha256').update(audio).digest('hex').slice(0, 8);
          const knowledgeMeeting = deps.dataRoot !== undefined && session.projectId !== null;
          const meetingDir = knowledgeMeeting
            ? await ensureMeetingDirectory(deps.dataRoot!, session.projectId!)
            : await ensureLegacyMeetingDirectory(session.worktree);
          const baseName = `${now.toISOString().slice(0, 10)}-${slug}-${hash}`;
          const relPath = knowledgeMeeting
            ? `${KNOWLEDGE_MEETINGS_DIR}/${baseName}.md`
            : `docs/meetings/${baseName}.md`;
          const audioExtension = extname(body.fileName).replace(/[^A-Za-z0-9.]/g, '') || '.audio';
          if (knowledgeMeeting) {
            await writeFile(join(meetingDir, `${baseName}${audioExtension}`), audio, {
              flag: 'wx',
              mode: 0o644,
            }).catch((error: unknown) => {
              if ((error as { code?: string }).code !== 'EEXIST') throw error;
            });
            await chmod(join(meetingDir, `${baseName}${audioExtension}`), 0o644);
          }
          const existing = await existingMeetingTranscript(meetingDir, relPath);
          if (existing) {
            await appendMeetingIndex(meetingDir, existing.path, title);
            await emitMeetingTranscriptSaved({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              path: existing.path,
              title,
              segments: existing.segments,
            });
            return { path: existing.path, title, segments: existing.segments };
          }

          let result: MeetingTranscriptResult;
          const controller = registerMeetingJob(id);
          const abortOnDisconnect = () => controller.abort();
          request.raw.once('aborted', abortOnDisconnect);
          reply.raw.once('close', abortOnDisconnect);
          try {
            await emitMeetingTranscriptProgress({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: body.fileName,
            });
            if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
            result = await meetingTranscriber.transcribe({
              audio,
              mediaType: body.mediaType,
              fileName: body.fileName,
              signal: controller.signal,
            });
          } catch (error) {
            request.raw.off('aborted', abortOnDisconnect);
            reply.raw.off('close', abortOnDisconnect);
            releaseMeetingJob(id, controller);
            if (error instanceof MeetingTranscriptionCancelledError || controller.signal.aborted) {
              await emitMeetingTranscriptCancelled({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: body.fileName,
              });
              reply.code(409);
              return { error: 'meeting transcription stopped' };
            }
            if (error instanceof MeetingTranscriberUnavailableError) {
              await emitMeetingTranscriptFailed({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: body.fileName,
                reason:
                  'Meeting transcription is not available on this Verity server: no transcription ' +
                  'backend is configured, or the transcriber command was not found. Set the ' +
                  'transcription backend URL, API key and model in Settings and redeploy if the ' +
                  'bundled transcriber command is missing.',
              });
              reply.code(503);
              return { error: 'meeting transcription is not configured' };
            }
            request.log.error({ err: error }, 'verity: meeting transcription failed');
            // Surface the transcriber's own message (e.g. "Could not reach the transcription
            // API … (ECONNREFUSED)") so the user can act, instead of a generic
            // line that hides which environmental step failed. The default placeholder
            // message carries no signal, so fall back to the generic notice for it.
            const detail =
              error instanceof MeetingTranscriptionFailedError &&
              error.message.trim().length > 0 &&
              error.message.trim() !== 'meeting transcription failed'
                ? error.message.trim().slice(0, 1000)
                : '';
            await emitMeetingTranscriptFailed({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: body.fileName,
              reason: detail
                ? `The transcription client failed:\n\n${detail}`
                : 'The transcription client failed before producing a transcript.',
            });
            reply.code(502);
            return { error: 'meeting transcription failed' };
          }

          let createdTranscript = false;
          try {
            const segments = result.segments.filter((segment) => segment.text.trim().length > 0);
            if (segments.length === 0) {
              await emitMeetingTranscriptFailed({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: body.fileName,
                reason: 'The transcriber returned no speech text.',
              });
              reply.code(502);
              return { error: 'meeting transcription returned no text' };
            }
            if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
            await withMeetingTranscriptCommitLock(meetingDir, relPath, async () => {
              const written = await writeMeetingTranscript({
                meetingDir,
                relPath,
                markdown: renderMeetingTranscriptMarkdown({
                  title,
                  fileName: body.fileName,
                  mediaType: body.mediaType,
                  createdAt: now,
                  result: { ...result, segments },
                }),
              });
              createdTranscript = written.created;
              try {
                if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
                await appendMeetingIndex(meetingDir, relPath, title);
                if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
                makeMeetingJobNonCancellable(id, controller);
              } catch (error) {
                if (
                  createdTranscript &&
                  (error instanceof MeetingTranscriptionCancelledError || controller.signal.aborted)
                ) {
                  await removeCancelledMeetingTranscript({ meetingDir, relPath, title });
                  createdTranscript = false;
                }
                throw error;
              }
            });
            if (knowledgeMeeting)
              await writeKnowledgeExtraction(
                dirname(dirname(meetingDir)),
                `${KNOWLEDGE_MEETINGS_DIR}/${baseName}${audioExtension}`,
                await readFile(join(meetingDir, basename(relPath)), 'utf8'),
              );
            request.raw.off('aborted', abortOnDisconnect);
            reply.raw.off('close', abortOnDisconnect);
            await emitMeetingTranscriptSaved({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              path: relPath,
              title,
              segments: segments.length,
            });
            return { path: relPath, title, segments: segments.length };
          } catch (error) {
            if (error instanceof MeetingTranscriptionCancelledError || controller.signal.aborted) {
              await emitMeetingTranscriptCancelled({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: body.fileName,
              });
              reply.code(409);
              return { error: 'meeting transcription stopped' };
            }
            throw error;
          } finally {
            request.raw.off('aborted', abortOnDisconnect);
            reply.raw.off('close', abortOnDisconnect);
            releaseMeetingJob(id, controller);
          }
        },
        stream: async (request, reply, id, query) => {
          const maxBytes = DEFAULT_MEETING_AUDIO_STREAM_BYTES;
          const uploadTimeoutMs = 30 * 60 * 1000;
          const declaredSize = Number(request.headers['content-length']);
          if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
            reply.code(413);
            return { error: `audio file exceeds the ${maxBytes} byte limit` };
          }
          const session = await deps.eventStore.getSession(id);
          if (!session) {
            reply.code(404);
            return { error: `session ${id} not found` };
          }
          if (deps.dataRoot && !session.projectId) {
            reply.code(409);
            return { error: 'meeting knowledge storage requires a project session' };
          }
          if (!isSupportedMeetingAudio(query.mediaType, query.fileName)) {
            reply.code(415);
            return { error: 'unsupported audio file' };
          }
          if (activeMeetingJobs >= maxConcurrentMeetingJobs) {
            reply.code(429);
            return { error: 'meeting transcription capacity is busy; try again shortly' };
          }
          activeMeetingJobs += 1;

          let stagingDir: string;
          try {
            stagingDir = await mkdtemp(join(tmpdir(), 'verity-meeting-upload-'));
          } catch (error) {
            activeMeetingJobs -= 1;
            throw error;
          }
          const extension = extname(query.fileName).replace(/[^A-Za-z0-9.]/g, '') || '.audio';
          const audioPath = join(stagingDir, `meeting${extension}`);
          try {
            let receivedBytes = 0;
            const limiter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                receivedBytes += chunk.length;
                callback(
                  receivedBytes > maxBytes
                    ? new MeetingAudioTooLargeError(`audio file exceeds the ${maxBytes} byte limit`)
                    : undefined,
                  chunk,
                );
              },
            });
            await pipeline(
              request.body as NodeJS.ReadableStream,
              limiter,
              createWriteStream(audioPath, { flags: 'wx', mode: 0o600 }),
              { signal: AbortSignal.timeout(uploadTimeoutMs) },
            );
            if (receivedBytes === 0) {
              activeMeetingJobs -= 1;
              await rm(stagingDir, { recursive: true, force: true });
              reply.code(400);
              return { error: 'audio file is empty' };
            }
          } catch (error) {
            activeMeetingJobs -= 1;
            await rm(stagingDir, { recursive: true, force: true });
            if (error instanceof MeetingAudioTooLargeError) {
              reply.code(413);
              return { error: error.message };
            }
            if (error instanceof Error && error.name === 'AbortError') {
              reply.code(408);
              return { error: 'meeting audio upload timed out' };
            }
            throw error;
          }

          try {
            if (query.announceRequest !== 'false') {
              await emitMeetingTranscriptRequest({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: query.fileName,
                ...(query.clientRequestId ? { clientRequestId: query.clientRequestId } : {}),
              });
            }
            await emitMeetingTranscriptProgress({
              eventStore: deps.eventStore,
              bus: deps.bus,
              sessionId: id,
              fileName: query.fileName,
            });
          } catch (error) {
            activeMeetingJobs -= 1;
            await rm(stagingDir, { recursive: true, force: true });
            throw error;
          }

          const controller = registerMeetingJob(id);
          const job = (async () => {
            let createdTranscript:
              { meetingDir: string; relPath: string; title: string } | undefined;
            try {
              const now = new Date();
              const sourceTitle =
                query.title ??
                basename(query.fileName, extname(query.fileName)).replace(/[_-]+/g, ' ').trim();
              const title = sourceTitle || 'Meeting';
              const slug = slugifyMeetingTitle(title);
              const hash = await meetingAudioHash(audioPath);
              if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
              const knowledgeMeeting = deps.dataRoot !== undefined && session.projectId !== null;
              const meetingDir = knowledgeMeeting
                ? await ensureMeetingDirectory(deps.dataRoot!, session.projectId!)
                : await ensureLegacyMeetingDirectory(session.worktree);
              const baseName = `${now.toISOString().slice(0, 10)}-${slug}-${hash}`;
              const relPath = knowledgeMeeting
                ? `${KNOWLEDGE_MEETINGS_DIR}/${baseName}.md`
                : `docs/meetings/${baseName}.md`;
              if (knowledgeMeeting)
                await copyFile(
                  audioPath,
                  join(meetingDir, `${baseName}${extension}`),
                  fsConstants.COPYFILE_EXCL,
                ).catch((error: unknown) => {
                  if ((error as { code?: string }).code !== 'EEXIST') throw error;
                });
              if (knowledgeMeeting) await chmod(join(meetingDir, `${baseName}${extension}`), 0o644);
              const existing = await existingMeetingTranscript(meetingDir, relPath);
              if (existing) {
                if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
                makeMeetingJobNonCancellable(id, controller);
                await appendMeetingIndex(meetingDir, existing.path, title);
                await emitMeetingTranscriptSaved({
                  eventStore: deps.eventStore,
                  bus: deps.bus,
                  sessionId: id,
                  path: existing.path,
                  title,
                  segments: existing.segments,
                });
                return;
              }

              if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
              const result = await meetingTranscriber.transcribe({
                audio: Buffer.alloc(0),
                audioPath,
                mediaType: query.mediaType,
                fileName: query.fileName,
                signal: controller.signal,
              });
              if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
              const segments = result.segments.filter((segment) => segment.text.trim().length > 0);
              if (segments.length === 0) {
                throw new MeetingTranscriptionFailedError(
                  'the transcriber returned no speech text',
                );
              }
              await withMeetingTranscriptCommitLock(meetingDir, relPath, async () => {
                const written = await writeMeetingTranscript({
                  meetingDir,
                  relPath,
                  markdown: renderMeetingTranscriptMarkdown({
                    title,
                    fileName: query.fileName,
                    mediaType: query.mediaType,
                    createdAt: now,
                    result: { ...result, segments },
                  }),
                });
                if (written.created) createdTranscript = { meetingDir, relPath, title };
                try {
                  if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
                  await appendMeetingIndex(meetingDir, relPath, title);
                  if (controller.signal.aborted) throw new MeetingTranscriptionCancelledError();
                  makeMeetingJobNonCancellable(id, controller);
                } catch (error) {
                  if (
                    createdTranscript &&
                    (error instanceof MeetingTranscriptionCancelledError ||
                      controller.signal.aborted)
                  ) {
                    await removeCancelledMeetingTranscript(createdTranscript);
                    createdTranscript = undefined;
                  }
                  throw error;
                }
              });
              if (knowledgeMeeting)
                await writeKnowledgeExtraction(
                  dirname(dirname(meetingDir)),
                  `${KNOWLEDGE_MEETINGS_DIR}/${baseName}${extension}`,
                  await readFile(join(meetingDir, basename(relPath)), 'utf8'),
                );
              await emitMeetingTranscriptSaved({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                path: relPath,
                title,
                segments: segments.length,
              });
            } catch (error) {
              if (
                error instanceof MeetingTranscriptionCancelledError ||
                controller.signal.aborted
              ) {
                await emitMeetingTranscriptCancelled({
                  eventStore: deps.eventStore,
                  bus: deps.bus,
                  sessionId: id,
                  fileName: query.fileName,
                }).catch((noticeError: unknown) => {
                  request.log.error(
                    { err: noticeError },
                    'verity: meeting transcription cancellation notice failed',
                  );
                });
                return;
              }
              request.log.error({ err: error }, 'verity: background meeting transcription failed');
              const detail = error instanceof Error ? error.message.trim().slice(0, 1000) : '';
              await emitMeetingTranscriptFailed({
                eventStore: deps.eventStore,
                bus: deps.bus,
                sessionId: id,
                fileName: query.fileName,
                reason: detail
                  ? `The background transcriber failed:\n\n${detail}`
                  : 'The background transcriber failed before producing a transcript.',
              }).catch((noticeError: unknown) => {
                request.log.error(
                  { err: noticeError },
                  'verity: meeting transcription failure notice failed',
                );
              });
            } finally {
              await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
            }
          })();
          backgroundMeetingJobs.add(job);
          const releaseJob = () => {
            activeMeetingJobs -= 1;
            releaseMeetingJob(id, controller);
            backgroundMeetingJobs.delete(job);
          };
          void job.then(releaseJob, releaseJob);

          reply.code(202);
          return { accepted: true };
        },
      });
    },
  };
}
