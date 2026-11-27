import type { FastifyInstance } from 'fastify';
import { SealedError } from '@verity/store';
import { AttendeeMeetings } from './attendee-meetings.js';
import { attendeeResearchHints } from './attendee-research.js';
import { registerAttendeeRoutes } from './attendee-routes.js';
import type { AssistantToolDeps } from './assistant-tool.js';
import { registerCalendarMeetingRoutes } from './calendar-meeting-routes.js';
import {
  startCalendarMeetingWatcher,
  type CalendarMeetingDeps,
} from './calendar-meeting-watcher.js';
import { registerCalendarWatchRoutes } from './calendar-watch-routes.js';
import { configuredLiveAudioTranscription } from './live-audio-transcription.js';
import { registerLiveMeetingIntakeRoutes } from './live-meeting-intake.js';
import { meetingKnowledgeExcerpts } from './live-meeting-knowledge.js';
import { registerLiveMeetingRoutes } from './live-meeting-routes.js';
import {
  configuredMeetingTranscriber,
  fileLiveMeeting,
  meetingTranscriptionSettingsWhileSealed,
  removeFiledLiveMeeting,
} from './meeting-transcription.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import { isModelAllowedForProject, resolveProjectDefaultModel } from './project-agent-policy.js';
import type { ServerContext } from './server-context.js';
import type { ServerDeps } from './server-deps.js';
import { createMeetingTranscriptController } from './server-meeting-transcripts.js';
import type { peopleDirectQueries, sharedProjectPeople } from './server-people.js';
import {
  hasVeritySettingsStore,
  isProjectSessionModel,
  projectSettingsStore,
  veritySettingsStore,
} from './server-support.js';
import type { SpawnSession } from './session-create-route.js';

type MeetingTranscripts = ReturnType<typeof createMeetingTranscriptController>;
type DirectQueries = ReturnType<typeof peopleDirectQueries>;

function meetingTranscriptionSettingsReader(deps: ServerDeps) {
  return async () => {
    if (!hasVeritySettingsStore(deps.eventStore)) return undefined;
    try {
      return await veritySettingsStore(deps.eventStore).getVeritySettings();
    } catch (error) {
      if (!(error instanceof SealedError)) throw error;
      const raw = await veritySettingsStore(deps.eventStore).getVeritySettingsRaw();
      return meetingTranscriptionSettingsWhileSealed(raw ?? undefined);
    }
  };
}

/**
 * The meeting transcript jobs, on the transcriber the settings choose. Built
 * before the routes because session status and deletion read its job state.
 */
export function createMeetingTranscripts(
  app: FastifyInstance,
  deps: ServerDeps,
): MeetingTranscripts {
  const meetingTranscriber =
    deps.meetingTranscriber ??
    configuredMeetingTranscriber(meetingTranscriptionSettingsReader(deps));
  return createMeetingTranscriptController(app, deps, meetingTranscriber);
}

/** Closures `buildServer` still owns that the meetings depend on. */
export interface MeetingsWiring {
  assistantToolDeps: AssistantToolDeps;
  meetingTranscripts: MeetingTranscripts;
  availableModels: Parameters<typeof peopleDirectQueries>[1];
  personSessionModel: ReturnType<typeof sharedProjectPeople>['personSessionModel'];
  directQueryFor: DirectQueries['directQueryFor'];
  instanceClaudeServes: DirectQueries['instanceClaudeServes'];
}

/**
 * Live meetings with their analysis, the attendee bots, calendar-started
 * meetings with their watcher, and the meeting transcript routes.
 */
export function installMeetings(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    assistantToolDeps,
    meetingTranscripts,
    availableModels,
    personSessionModel,
    directQueryFor,
    instanceClaudeServes,
  }: MeetingsWiring,
): { attendeeMeetings: AttendeeMeetings } {
  const { deps, lifecycle, conductor, pushSender, resources } = ctx;
  const meetingController = registerLiveMeetingRoutes(app, deps.eventStore, {
    onTasksChanged: () => resources.invalidate('/tasks'),
    onResultChanged: (sessionId, meetingId) =>
      resources.invalidate(
        `/sessions/${encodeURIComponent(sessionId)}/live-meetings/${encodeURIComponent(meetingId)}/result`,
      ),
    onFinished: (sessionId, meetingId) =>
      fileLiveMeeting({
        eventStore: deps.eventStore,
        bus: deps.bus,
        dataRoot: deps.dataRoot,
        sessionId,
        meetingId,
        log: app.log,
      }),
    onDiscarded: async (sessionId, meeting) => {
      // Independent steps, all attempted: a provider failure must not skip removing the
      // filed transcript. Any failure is reported so the discard is retried.
      const steps = await Promise.allSettled([
        // The attendee owner is created below; a request can only arrive once it exists.
        meeting.engine === 'attendee'
          ? attendeeMeetings.discardFinished(sessionId, meeting.id)
          : Promise.resolve(true),
        removeFiledLiveMeeting({
          eventStore: deps.eventStore,
          dataRoot: deps.dataRoot,
          sessionId,
          meeting,
        }),
      ]);
      const failed = steps.find((step) => step.status === 'rejected');
      if (failed) throw failed.reason;
    },
    knowledge: async (sessionId, transcript) => {
      if (!deps.dataRoot) return [];
      const session = await deps.eventStore.getSession(sessionId);
      return session?.projectId
        ? meetingKnowledgeExcerpts(deps.dataRoot, session.projectId, transcript)
        : [];
    },
    query: async (sessionId, prompt, signal) => {
      const session = await deps.eventStore.getSession(sessionId);
      if (!session) return undefined;
      // On the account of whoever last wrote in the session.
      const person = (await deps.eventStore.latestPromptInitiator(sessionId))?.userId;
      const settings = session.projectId
        ? await projectSettingsStore(deps.eventStore).getProjectSettings(session.projectId)
        : undefined;
      const projectModel =
        person === undefined ? undefined : await personSessionModel(session, person);
      // The analysis must stay on an agent the project allows, even when the
      // session itself still runs on one the project has since excluded.
      const model =
        projectModel !== undefined && isModelAllowedForProject(projectModel, settings)
          ? projectModel
          : isModelAllowedForProject(session.model, settings)
            ? session.model
            : resolveProjectDefaultModel(
                await availableModels({ viewer: person }),
                settings === undefined || settings === null || person === undefined
                  ? settings
                  : {
                      ...settings,
                      defaultModel:
                        await deps.eventStore.userProviderConnections.projectDefaultModel(
                          person,
                          session.projectId ?? '',
                        ),
                    },
                isProjectSessionModel,
              );
      if (model === undefined) return undefined;
      if (model.startsWith('codex/') || model.startsWith('verity/'))
        return directQueryFor(person)({
          model,
          prompt,
          signal,
          maxOutputTokens: prompt.startsWith('Write a meeting result') ? 12000 : 2048,
        });
      if (!instanceClaudeServes(person)) return undefined;
      return conductor.query({
        prompt,
        model,
        signal,
        toolless: true,
        cwd: deps.refineCwd ?? session.worktree,
      });
    },
  });
  const attendeeMeetings = new AttendeeMeetings({
    store: deps.eventStore,
    ...(deps.attendeeEdge ? { edge: deps.attendeeEdge } : {}),
    ingest: meetingController.ingest,
    ...configuredLiveAudioTranscription(meetingTranscriptionSettingsReader(deps)),
    spoken: attendeeResearchHints({ store: deps.eventStore, classify: meetingController.spoken }),
    log: app.log,
  });
  registerAttendeeRoutes(app, attendeeMeetings, () =>
    Boolean(deps.secretCipher && !deps.secretCipher.isSealed()),
  );
  app.addHook('onReady', () => attendeeMeetings.open());
  const calendarMeetings: CalendarMeetingDeps = {
    store: deps.eventStore,
    meetings: attendeeMeetings,
    sender: pushSender,
    googleAccessToken: deps.googleAccessToken ?? (() => Promise.resolve(undefined)),
    warn: (obj, msg) => app.log.warn(obj, msg),
  };
  registerCalendarMeetingRoutes(app, calendarMeetings);
  // Built after the gateway tools; the assistant's meeting actions read it per call.
  assistantToolDeps.meetings = calendarMeetings;
  let calendarMeetingWatcher: ReturnType<typeof startCalendarMeetingWatcher> | undefined;
  app.addHook('onReady', async () => {
    // Before the server takes requests: no join of this process is under way yet.
    try {
      await deps.eventStore.calendarWatch.releaseUnfinishedJoins();
    } catch (err) {
      app.log.warn({ err }, 'releasing unfinished calendar joins failed');
    }
    calendarMeetingWatcher = startCalendarMeetingWatcher(calendarMeetings);
  });
  lifecycle.onClose(async () => {
    // Before the meetings close: a pass in flight may still be starting a bot.
    await calendarMeetingWatcher?.stop();
    await attendeeMeetings.close();
  });
  meetingTranscripts.registerRoutes();
  return { attendeeMeetings };
}

/**
 * Meetings started from a session or a calendar watch. Installed after the
 * session routes, whose spawn they use.
 */
export function installMeetingIntake(
  app: FastifyInstance,
  ctx: ServerContext,
  { attendeeMeetings, spawn }: { attendeeMeetings: AttendeeMeetings; spawn: SpawnSession },
): void {
  const { deps } = ctx;
  registerLiveMeetingIntakeRoutes(app, {
    store: deps.eventStore,
    meetings: attendeeMeetings,
    spawn,
    canReadSession: async (userId, sessionId) =>
      userId === undefined ||
      (await authorizePairedRoute(deps.eventStore, userId, 'GET', '/sessions/:id', {
        id: sessionId,
      })) === 'allow',
    log: app.log,
  });
  registerCalendarWatchRoutes(app, {
    store: deps.eventStore,
    googleAccessToken: deps.googleAccessToken ?? (() => Promise.resolve(undefined)),
    log: app.log,
  });
}
