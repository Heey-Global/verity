import {
  collectProcessTree,
  PROCESS_TREE_KILL_GRACE_MS,
  signalProcessTree,
  type EventBus,
} from '@verity/session';
import type { EventStore, VeritySettingsRecord } from '@verity/store';
import { SealedError } from '@verity/store';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, sep } from 'node:path';
import './fastify-augmentation.js';
import {
  ensureProjectKnowledge,
  KNOWLEDGE_MEETINGS_DIR,
  KNOWLEDGE_MOUNT_TARGET,
} from './knowledge-folder.js';
import {
  liveMeetingAnswerCount,
  liveMeetingLinkLabel,
  liveMeetingPeopleCount,
  liveMeetingSavedMessage,
  liveMeetingTitle,
  renderLiveMeetingMarkdown,
} from './live-meeting-export.js';
import { emitNotice } from './session-event-writer.js';
import { assertSessionRealPath, sessionFilePath } from './session-files.js';

interface MeetingTranscriptSegment {
  speaker: string;
  text: string;
  start?: number | undefined;
  end?: number | undefined;
}

export interface MeetingTranscriptResult {
  segments: MeetingTranscriptSegment[];
  language?: string | undefined;
  duration?: number | undefined;
}

export interface MeetingTranscriber {
  transcribe(input: {
    audio: Buffer;
    audioPath?: string;
    mediaType: string;
    fileName: string;
    signal?: AbortSignal;
  }): Promise<MeetingTranscriptResult>;
}

export class MeetingTranscriberUnavailableError extends Error {
  constructor() {
    super('meeting transcription is not configured');
    this.name = 'MeetingTranscriberUnavailableError';
  }
}

export class MeetingTranscriptionFailedError extends Error {
  constructor(message = 'meeting transcription failed') {
    super(message);
    this.name = 'MeetingTranscriptionFailedError';
  }
}

export class MeetingTranscriptionCancelledError extends Error {
  constructor() {
    super('meeting transcription was stopped');
    this.name = 'MeetingTranscriptionCancelledError';
  }
}

export class MeetingAudioTooLargeError extends Error {}

export const DEFAULT_MEETING_AUDIO_STREAM_BYTES = 500_000_000;

// The streamed upload route acknowledges first; transcription of a two-hour
// recording is allowed to continue server-side without an HTTP request deadline.
const MEETING_TRANSCRIBER_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const MEETING_TRANSCRIBER_STDOUT_BYTES = 25_000_000;

const DEFAULT_MEETING_TRANSCRIBE_COMMAND = 'verity-transcribe-meeting';

export function isSupportedMeetingAudio(mediaType: string, fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return (
    mediaType.startsWith('audio/') ||
    lowerName.endsWith('.mp3') ||
    lowerName.endsWith('.m4a') ||
    lowerName.endsWith('.wav') ||
    lowerName.endsWith('.aac') ||
    lowerName.endsWith('.ogg') ||
    lowerName.endsWith('.opus') ||
    lowerName.endsWith('.webm') ||
    lowerName.endsWith('.flac')
  );
}

export function slugifyMeetingTitle(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'meeting';
}

function formatSeconds(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function renderMeetingTranscriptMarkdown(input: {
  title: string;
  fileName: string;
  mediaType: string;
  createdAt: Date;
  result: MeetingTranscriptResult;
}): string {
  const lines = [
    `# ${input.title}`,
    '',
    `- Date: ${input.createdAt.toISOString().slice(0, 10)}`,
    `- Source file: ${input.fileName}`,
    `- Media type: ${input.mediaType}`,
  ];
  if (input.result.language) lines.push(`- Language: ${input.result.language}`);
  const duration = formatSeconds(input.result.duration);
  if (duration) lines.push(`- Duration: ${duration}`);
  lines.push('', '## Transcript', '');
  for (const segment of input.result.segments) {
    const start = formatSeconds(segment.start);
    const speaker = segment.speaker.trim() || 'Speaker';
    const text = segment.text.trim();
    if (!text) continue;
    lines.push(start ? `**${speaker}** (${start}): ${text}` : `**${speaker}:** ${text}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function meetingTranscriptChatMessage(input: {
  path: string;
  title: string;
  segments: number;
}): string {
  const count = input.segments === 1 ? '1 segment' : `${String(input.segments)} segments`;
  return `Meeting transcript saved: [${input.path}](${input.path})\n\nTitle: ${input.title}\nSegments: ${count}`;
}

function meetingTranscriptRequestMessage(fileName: string): string {
  return `Please transcribe meeting audio:\n${fileName}`;
}

function meetingTranscriptProgressMessage(fileName: string): string {
  return `Transcribing meeting audio\n${fileName}`;
}

function meetingTranscriptFailureMessage(fileName: string, reason: string): string {
  return `Could not transcribe meeting audio\n${fileName}\n\n${reason}`;
}

export async function emitMeetingTranscriptRequest(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  fileName: string;
  clientRequestId?: string;
}): Promise<void> {
  await emitNotice({
    ...input,
    role: 'operator',
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    text: meetingTranscriptRequestMessage(input.fileName),
  });
}

export async function emitMeetingTranscriptProgress(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  fileName: string;
}): Promise<void> {
  await emitNotice({
    ...input,
    role: 'agent',
    text: meetingTranscriptProgressMessage(input.fileName),
  });
}

export async function emitMeetingTranscriptSaved(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  path: string;
  title: string;
  segments: number;
}): Promise<void> {
  await emitNotice({
    ...input,
    role: 'agent',
    text: meetingTranscriptChatMessage(input),
  });
}

export async function emitMeetingTranscriptFailed(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  fileName: string;
  reason: string;
}): Promise<void> {
  await emitNotice({
    ...input,
    role: 'agent',
    text: meetingTranscriptFailureMessage(input.fileName, input.reason),
  });
}

export async function emitMeetingTranscriptCancelled(input: {
  eventStore: EventStore;
  bus: EventBus;
  sessionId: string;
  fileName: string;
}): Promise<void> {
  await emitNotice({
    ...input,
    role: 'agent',
    text: `Meeting transcription stopped\n${input.fileName}`,
  });
}

const meetingIndexUpdates = new Map<string, Promise<void>>();

const meetingTranscriptCommits = new Map<string, Promise<void>>();

async function updateMeetingIndexFile(
  indexAbs: string,
  transform: (content: string) => string,
): Promise<void> {
  const handle = await open(
    indexAbs,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('invalid meeting index');
    const content = await handle.readFile('utf8');
    const next = transform(content);
    if (next === content) return;
    const bytes = Buffer.from(next);
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function withMeetingTranscriptCommitLock<T>(
  meetingDir: string,
  relPath: string,
  commit: () => Promise<T>,
): Promise<T> {
  const transcriptAbs = join(meetingDir, basename(relPath));
  const previous = meetingTranscriptCommits.get(transcriptAbs) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  meetingTranscriptCommits.set(transcriptAbs, queued);
  await previous.catch(() => undefined);
  try {
    return await commit();
  } finally {
    release();
    if (meetingTranscriptCommits.get(transcriptAbs) === queued) {
      meetingTranscriptCommits.delete(transcriptAbs);
    }
  }
}

export async function appendMeetingIndex(
  meetingDir: string,
  relPath: string,
  title: string,
): Promise<void> {
  const indexAbs = join(meetingDir, 'index.md');
  const previous = meetingIndexUpdates.get(indexAbs) ?? Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(async () => {
      const entry = `- [${liveMeetingLinkLabel(title)}](${basename(relPath)})\n`;
      await updateMeetingIndexFile(indexAbs, (existing) => {
        let content = existing === '' ? '# Meetings\n\n' : existing;
        if (!content.endsWith('\n')) content += '\n';
        const destination = `](${basename(relPath)})`;
        const retained = content
          .split('\n')
          .filter((line) => !(line.startsWith('- [') && line.endsWith(destination)))
          .join('\n');
        return `${retained}${retained.endsWith('\n') ? '' : '\n'}${entry}`;
      });
    });
  meetingIndexUpdates.set(indexAbs, update);
  try {
    await update;
  } finally {
    if (meetingIndexUpdates.get(indexAbs) === update) meetingIndexUpdates.delete(indexAbs);
  }
}

export async function meetingAudioHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, 8);
}

export async function ensureMeetingDirectory(dataRoot: string, projectId: string): Promise<string> {
  const projectDir = await ensureProjectKnowledge(dataRoot, projectId);
  const meetingDir = join(projectDir, KNOWLEDGE_MEETINGS_DIR);
  const meetingReal = await realpath(meetingDir);
  await assertSessionRealPath(projectDir, meetingReal);
  return meetingReal;
}

/** Compatibility for tests and deployments without a configured data root. */
export async function ensureLegacyMeetingDirectory(worktree: string): Promise<string> {
  const rootReal = await realpath(worktree);
  const docsDir = join(worktree, 'docs');
  await mkdir(docsDir, { recursive: true });
  if ((await lstat(docsDir)).isSymbolicLink()) throw new Error('invalid meeting directory');
  const docsReal = await realpath(docsDir);
  if (docsReal !== rootReal && !docsReal.startsWith(`${rootReal}${sep}`))
    throw new Error('invalid meeting directory');
  const meetingDir = join(docsDir, 'meetings');
  await mkdir(meetingDir, { recursive: true });
  if ((await lstat(meetingDir)).isSymbolicLink()) throw new Error('invalid meeting directory');
  const meetingReal = await realpath(meetingDir);
  if (meetingReal !== rootReal && !meetingReal.startsWith(`${rootReal}${sep}`))
    throw new Error('invalid meeting directory');
  return meetingReal;
}

/**
 * Files a finished live meeting as Markdown next to the transcribed recordings and
 * tells the session where it is. The name derives from the meeting id, so a later
 * call (late notes, renamed speakers) rewrites the same file and stays silent.
 */
export async function fileLiveMeeting(input: {
  eventStore: EventStore;
  bus: EventBus;
  dataRoot: string | undefined;
  sessionId: string;
  meetingId: string;
}): Promise<void> {
  const session = await input.eventStore.getSession(input.sessionId);
  if (!session) return;
  const load = async () => {
    const changes = await input.eventStore.liveMeetings.changes(input.sessionId, 0);
    const meeting = changes.meetings.find((candidate) => candidate.id === input.meetingId);
    if (!meeting || meeting.state === 'active') return null;
    const notes = changes.notes.filter((note) => note.meetingId === meeting.id);
    const insights = await input.eventStore.liveMeetings.insights(input.sessionId, meeting.id);
    const result = await input.eventStore.liveMeetings.result(input.sessionId, meeting.id);
    return { meeting, notes, insights: insights ?? [], result };
  };
  const first = await load();
  if (!first) return;
  const knowledge = input.dataRoot !== undefined && session.projectId !== null;
  const meetingDir = knowledge
    ? await ensureMeetingDirectory(input.dataRoot!, session.projectId!)
    : await ensureLegacyMeetingDirectory(session.worktree);
  const title = liveMeetingTitle({
    ...first.meeting,
    title: first.meeting.title || first.result?.title || null,
  });
  const hash = createHash('sha256').update(first.meeting.id).digest('hex').slice(0, 8);
  const date = new Date(first.meeting.startedAt).toISOString().slice(0, 10);
  const relPath = `${knowledge ? KNOWLEDGE_MEETINGS_DIR : 'docs/meetings'}/${date}-live-meeting-${hash}.md`;
  await withMeetingTranscriptCommitLock(meetingDir, relPath, async () => {
    // Read again under the lock: an overlapping filing that read earlier must not
    // overwrite a later note or speaker name with its older snapshot.
    const current = await load();
    if (!current) return;
    const markdown = renderLiveMeetingMarkdown(current);
    const written = await writeMeetingTranscript({ meetingDir, relPath, markdown });
    if (!written.created) {
      // writeMeetingTranscript has already refused a symlink or non-file here. Write
      // beside it and rename over it, so a reader never sees half a meeting.
      const target = join(meetingDir, basename(relPath));
      const temporary = join(meetingDir, `.${basename(relPath)}.${randomUUID()}.tmp`);
      await writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      await rename(temporary, target).catch(async (error: unknown) => {
        await unlink(temporary).catch(() => undefined);
        throw error;
      });
    }
    {
      await appendMeetingIndex(meetingDir, relPath, title);
      const events = await input.eventStore.getEvents(input.sessionId);
      const savedLink = knowledge ? `${KNOWLEDGE_MOUNT_TARGET}/${relPath}` : relPath;
      const details = {
        sessionId: input.sessionId,
        meetingId: current.meeting.id,
        durationMinutes: Math.max(
          1,
          Math.round(
            ((current.meeting.endedAt ?? current.meeting.startedAt) - current.meeting.startedAt) /
              60_000,
          ),
        ),
        people: liveMeetingPeopleCount(current.meeting),
        notes: current.notes.length,
        answers: liveMeetingAnswerCount(events, current.meeting.id),
        ...(current.result?.summary ? { summary: current.result.summary } : {}),
      };
      const text = liveMeetingSavedMessage(
        knowledge ? `${KNOWLEDGE_MOUNT_TARGET}/${relPath}` : relPath,
        title,
        details,
      );
      const announced = events.findLast(
        (event) =>
          event.t === 'notice' &&
          event.text.startsWith('Meeting saved to the knowledge base: [') &&
          event.text.split('\n')[0]?.endsWith(`](${savedLink})`),
      );
      if (announced?.t === 'notice' && announced.text === text) return;
      await emitNotice({
        eventStore: input.eventStore,
        bus: input.bus,
        sessionId: input.sessionId,
        role: 'agent',
        text,
      });
    }
  });
}

export async function existingMeetingTranscript(
  meetingDir: string,
  relPath: string,
): Promise<{ path: string; segments: number } | null> {
  const absPath = join(meetingDir, basename(relPath));
  const existing = await lstat(absPath).catch(() => undefined);
  if (existing === undefined) return null;
  if (existing.isSymbolicLink()) throw new Error('invalid meeting transcript path');
  if (!existing.isFile()) throw new Error('invalid meeting transcript path');
  const markdown = await readFile(absPath, 'utf8');
  const segments = markdown.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('**') && (trimmed.includes('): ') || trimmed.includes(':** '));
  }).length;
  return { path: relPath, segments };
}

export async function writeMeetingTranscript(input: {
  meetingDir: string;
  relPath: string;
  markdown: string;
}): Promise<{ path: string; created: boolean }> {
  sessionFilePath(input.meetingDir, basename(input.relPath));
  try {
    await writeFile(join(input.meetingDir, basename(input.relPath)), input.markdown, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    return { path: input.relPath, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      const existing = await existingMeetingTranscript(input.meetingDir, input.relPath);
      if (existing) return { path: existing.path, created: false };
    }
    throw error;
  }
}

export async function removeCancelledMeetingTranscript(input: {
  meetingDir: string;
  relPath: string;
  title: string;
}): Promise<void> {
  await unlink(join(input.meetingDir, basename(input.relPath))).catch(() => undefined);
  const indexAbs = join(input.meetingDir, 'index.md');
  const previous = meetingIndexUpdates.get(indexAbs) ?? Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(async () => {
      const entry = `- [${liveMeetingLinkLabel(input.title)}](${basename(input.relPath)})\n`;
      await updateMeetingIndexFile(indexAbs, (content) => content.replace(entry, ''));
    });
  meetingIndexUpdates.set(indexAbs, update);
  try {
    await update;
  } finally {
    if (meetingIndexUpdates.get(indexAbs) === update) meetingIndexUpdates.delete(indexAbs);
  }
}

export type MeetingTranscriptionSettings = Pick<
  VeritySettingsRecord,
  'transcribeBaseUrl' | 'transcribeApiKey' | 'transcribeModel' | 'transcribeBackendMode'
>;

/**
 * The meeting-transcription backends this deployment can actually be set to.
 * `local` is deliberately absent: Verity bundles no speech-to-text backend any
 * more, so storing it would recreate the unsatisfiable choice that store
 * migration `0083_drop_local_transcribe_backend_mode` clears from existing
 * installations. Writes are REJECTED (400) rather than normalised, so an older
 * app that still offers the local option is told its choice no longer exists
 * instead of silently being switched to an off-host service.
 */

export function meetingTranscriptionSettingsWhileSealed(
  settings: MeetingTranscriptionSettings | undefined,
): MeetingTranscriptionSettings | undefined {
  // `local` is a stored preference for a backend this deployment no longer has.
  // Carry the mode through without any secret material so the transcriber reports
  // it unavailable, rather than dropping it here and silently falling back to a
  // remote backend the operator never chose for this recording.
  if (settings?.transcribeBackendMode === 'local') {
    return {
      transcribeBackendMode: 'local',
      transcribeBaseUrl: null,
      transcribeApiKey: null,
      transcribeModel: null,
    };
  }
  if (settings?.transcribeBackendMode === 'external') throw new SealedError();
  return undefined;
}

export function configuredMeetingTranscriber(
  readSettings: () => Promise<MeetingTranscriptionSettings | undefined>,
): MeetingTranscriber {
  return new CommandMeetingTranscriber(DEFAULT_MEETING_TRANSCRIBE_COMMAND, readSettings);
}

function parseMeetingTranscriptSegments(value: unknown): MeetingTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): MeetingTranscriptSegment[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const segment = raw as Record<string, unknown>;
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!text) return [];
    const speaker =
      typeof segment.speaker === 'string' && segment.speaker.trim().length > 0
        ? segment.speaker.trim()
        : 'Speaker 1';
    return [
      {
        speaker,
        text,
        ...(typeof segment.start === 'number' ? { start: segment.start } : {}),
        ...(typeof segment.end === 'number' ? { end: segment.end } : {}),
      },
    ];
  });
}

function parseMeetingTranscriptResult(value: unknown): MeetingTranscriptResult {
  if (typeof value !== 'object' || value === null) {
    throw new MeetingTranscriptionFailedError('transcription client returned invalid JSON');
  }
  const body = value as Record<string, unknown>;
  let segments = parseMeetingTranscriptSegments(body.segments ?? body.utterances);
  if (segments.length === 0 && typeof body.text === 'string' && body.text.trim().length > 0) {
    segments = [{ speaker: 'Speaker 1', text: body.text.trim() }];
  }
  if (segments.length === 0) {
    throw new MeetingTranscriptionFailedError('transcription client returned no text');
  }
  return {
    segments,
    ...(typeof body.language === 'string' ? { language: body.language } : {}),
    ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
  };
}

export class CommandMeetingTranscriber implements MeetingTranscriber {
  constructor(
    private readonly command: string,
    private readonly readSettings: () => Promise<MeetingTranscriptionSettings | undefined>,
  ) {}

  async transcribe(input: {
    audio: Buffer;
    audioPath?: string;
    mediaType: string;
    fileName: string;
    signal?: AbortSignal;
  }): Promise<MeetingTranscriptResult> {
    const settings = await this.readSettings();
    if (input.audioPath) {
      try {
        const stdout = await runMeetingTranscriptionCommand(
          this.command,
          input.audioPath,
          input.mediaType,
          settings,
          input.signal,
        );
        return parseMeetingTranscriptResult(JSON.parse(stdout) as unknown);
      } catch (error) {
        if (
          error instanceof MeetingTranscriberUnavailableError ||
          error instanceof MeetingTranscriptionFailedError ||
          error instanceof MeetingTranscriptionCancelledError
        ) {
          throw error;
        }
        if (error instanceof SyntaxError) {
          throw new MeetingTranscriptionFailedError('transcription client returned invalid JSON');
        }
        throw new MeetingTranscriptionFailedError();
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'verity-meeting-'));
    const ext = extname(input.fileName).replace(/[^A-Za-z0-9.]/g, '') || '.audio';
    const audioPath = join(dir, `meeting${ext}`);
    try {
      await writeFile(audioPath, input.audio, { mode: 0o600 });
      const stdout = await runMeetingTranscriptionCommand(
        this.command,
        audioPath,
        input.mediaType,
        settings,
        input.signal,
      );
      return parseMeetingTranscriptResult(JSON.parse(stdout) as unknown);
    } catch (error) {
      if (
        error instanceof MeetingTranscriberUnavailableError ||
        error instanceof MeetingTranscriptionFailedError ||
        error instanceof MeetingTranscriptionCancelledError
      ) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new MeetingTranscriptionFailedError('transcription client returned invalid JSON');
      }
      throw new MeetingTranscriptionFailedError();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runMeetingTranscriptionCommand(
  command: string,
  audioPath: string,
  mediaType: string,
  settings: MeetingTranscriptionSettings | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const settingEnv = (value: string | null | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const settingsBaseUrl = settingEnv(settings?.transcribeBaseUrl);
  // Verity bundles no local speech-to-text backend, so a stored `local` choice
  // has nothing left to run against. Report it as unconfigured instead of
  // quietly shipping the recording to whatever remote backend the deployment
  // happens to carry.
  if (settings?.transcribeBackendMode === 'local') throw new MeetingTranscriberUnavailableError();
  const externalBaseUrl = settingsBaseUrl;
  const externalApiKey = settingEnv(settings?.transcribeApiKey);
  const externalModel = settingEnv(settings?.transcribeModel);
  if (settings?.transcribeBackendMode === 'external' && (!externalBaseUrl || !externalModel)) {
    throw new MeetingTranscriptionFailedError(
      'External meeting transcription is not configured. Add its URL and model in Settings.',
    );
  }
  const settingsEnv =
    settings?.transcribeBackendMode === 'external'
      ? {
          VERITY_TRANSCRIBE_BASE_URL: externalBaseUrl ?? '',
          VERITY_TRANSCRIBE_API_KEY: externalApiKey ?? '',
          VERITY_TRANSCRIBE_MODEL: externalModel ?? '',
        }
      : settingsBaseUrl
        ? {
            VERITY_TRANSCRIBE_BASE_URL: settingsBaseUrl,
            VERITY_TRANSCRIBE_API_KEY: settingEnv(settings?.transcribeApiKey) ?? '',
            VERITY_TRANSCRIBE_MODEL: settingEnv(settings?.transcribeModel) ?? '',
          }
        : {};
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('VERITY_TRANSCRIBE_') || name.startsWith('VERITY_MEETING_')) {
      delete env[name];
    }
  }
  Object.assign(env, {
    VERITY_AUDIO_FILE: audioPath,
    VERITY_AUDIO_MEDIA_TYPE: mediaType,
    ...settingsEnv,
  });
  // The bundled client only speaks to an OpenAI-compatible endpoint, and there is
  // no local one to fall back to. Without a base URL the meeting would be
  // uploaded and then fail against an empty endpoint, so report it unavailable
  // up front. A deployment-supplied command carries its own configuration and is
  // deliberately exempt.
  if (!externalBaseUrl) throw new MeetingTranscriberUnavailableError();
  try {
    const execOpts = {
      env,
      encoding: 'utf8' as const,
      maxBuffer: MEETING_TRANSCRIBER_STDOUT_BYTES + 65_536,
      detached: true,
    };
    const executable = command;
    const args = ['--json', '--diarize', audioPath];
    let child!: ReturnType<typeof execFile>;
    const execution = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = execFile(executable, args, execOpts, (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(new Error(error.message, { cause: error }), {
              code: error.code,
              stdout,
              stderr,
            }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
    let termination: Promise<void> | undefined;
    const terminateGroup = () => {
      if (termination || child.pid === undefined) return;
      const pid = child.pid;
      // The `/proc` descendant walk this used to carry inline now lives in
      // `@verity/session` (`process-tree.ts`), because agent-turn teardown needs the
      // same thing for the same reason: a child that called `setsid` leaves the group,
      // so the group signal alone never reaches it. Captured before anything is
      // signalled — a terminated parent takes its children out of the walk.
      const descendants = collectProcessTree(pid);
      termination = new Promise<void>((resolveTermination) => {
        signalProcessTree(descendants, 'SIGTERM');
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        const forceKillTimer = setTimeout(() => {
          signalProcessTree(descendants, 'SIGKILL');
          try {
            // Signal only while the original process group still exists. Waiting
            // for this escalation before returning prevents a later PID-reuse kill.
            process.kill(-pid, 0);
            process.kill(-pid, 'SIGKILL');
          } catch {
            // The complete process group already exited.
          }
          resolveTermination();
        }, PROCESS_TREE_KILL_GRACE_MS);
        forceKillTimer.unref();
      });
    };
    let observedOutputBytes = 0;
    const observeOutput = (chunk: string | Buffer) => {
      observedOutputBytes += Buffer.byteLength(chunk);
      if (observedOutputBytes > MEETING_TRANSCRIBER_STDOUT_BYTES) terminateGroup();
    };
    child.stdout?.on('data', observeOutput);
    child.stderr?.on('data', observeOutput);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, MEETING_TRANSCRIBER_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener('abort', terminateGroup, { once: true });
    if (signal?.aborted) terminateGroup();
    const executionResult = await execution
      .then((result) => ({ result }))
      .catch((error: unknown) => ({ error }));
    clearTimeout(timeout);
    signal?.removeEventListener('abort', terminateGroup);
    if (termination) await termination;
    if (timedOut) throw new Error('meeting transcription timed out');
    if ('error' in executionResult) throw executionResult.error;
    const { stdout } = executionResult.result;
    return String(stdout);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new MeetingTranscriptionCancelledError();
    }
    const code = (error as { code?: string | number }).code;
    if (code === 'ENOENT' || code === 127) throw new MeetingTranscriberUnavailableError();
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new MeetingTranscriptionFailedError(
      typeof stderr === 'string' && stderr.trim().length > 0
        ? stderr.trim()
        : 'transcription client failed',
    );
  }
}
