// First-run starter project and onboarding welcome session.
//
// A fresh installation gets one local project, "Getting started", as soon as the
// server boots, and provisions it in the background while the operator is still
// pairing a device and walking through onboarding. That first provision is the
// one that pulls the sandbox image, which otherwise costs minutes the first time
// someone creates a project. When onboarding finishes, the app asks for the
// welcome session: one session in that project whose transcript already holds a
// server-written greeting with a setup checklist and Quick Actions, so it shows
// up instantly and costs no tokens. The real agent takes over on the first reply,
// with the guide prompt attached through `sessionSystemPrompt`.
import {
  LOCAL_PROJECT_OWNER,
  type EventStore,
  type ProjectRecord,
  type SealableSecretCipher,
} from '@verity/store';
import {
  WELCOME_SESSION_MARKER,
  renderWelcomeGuidePrompt,
  renderWelcomeOpener,
  welcomeChoices,
  type AgentEvent,
  type WelcomeSetupStatus,
} from '@verity/events';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';
import { computeOnboardingStatus } from './onboarding-routes.js';
import { localProjectInput } from './project-collection-routes.js';
import type { SpawnSession } from './session-create-route.js';
import { parseSpawnRequestBody } from './session-create-schema.js';

export const STARTER_PROJECT_SLUG = 'getting-started';
export const WELCOME_SESSION_NAME = 'Welcome';

type StarterStore = Pick<
  EventStore,
  | 'getSecretKeyMeta'
  | 'listProjects'
  | 'createProject'
  | 'setProjectSetupStatus'
  | 'getStarterProjectId'
  | 'recordStarterProject'
>;

/**
 * Create and start provisioning the starter project, once, on a fresh install.
 *
 * Fresh means no master password yet and no project besides the built-in control
 * project. An upgraded installation with a projects history never gets one, and a
 * managed one always has a master password as well; neither does an installation whose operator deleted the starter project,
 * because the soft-deleted row still counts as a project. Provisioning a local
 * project needs no secret, so it runs while the store is still sealed — the one
 * place the server provisions without the operator having unlocked first.
 *
 * Never throws: a failure here only costs the head start, and the welcome
 * endpoint provisions again when the operator finishes onboarding. A boot that
 * died between creating the project and recording it adopts that project on the
 * next boot; with no master password set, nobody else can have created it.
 */
export async function ensureStarterProject(deps: {
  store: StarterStore;
  provision: (projectId: string) => Promise<unknown>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}): Promise<ProjectRecord | undefined> {
  try {
    if ((await deps.store.getSecretKeyMeta()) !== undefined) return undefined;
    if ((await deps.store.getStarterProjectId()) !== undefined) return undefined;
    const projects = (await deps.store.listProjects({ includeHidden: true })).filter(
      (project) => project.id !== CONTROL_PLANE_PROJECT_ID,
    );
    const orphan = projects.length === 1 ? projects[0] : undefined;
    let project: ProjectRecord;
    if (projects.length === 0) {
      project = await deps.store.createProject(localProjectInput(STARTER_PROJECT_SLUG));
    } else if (
      orphan !== undefined &&
      orphan.owner === LOCAL_PROJECT_OWNER &&
      orphan.repo === STARTER_PROJECT_SLUG &&
      orphan.hiddenAt === null
    ) {
      project = orphan;
    } else {
      return undefined;
    }
    await deps.store.recordStarterProject(project.id);
    await deps.store.setProjectSetupStatus(project.id, 'pending');
    deps.log.info({ projectId: project.id }, 'verity: provisioning the starter project');
    void deps.provision(project.id).catch((error: unknown) => {
      deps.log.warn(
        { err: error, projectId: project.id },
        'verity: starter project provisioning failed; the welcome request retries it',
      );
    });
    return project;
  } catch (error) {
    deps.log.warn({ err: error }, 'verity: could not create the starter project');
    return undefined;
  }
}

type WelcomeState = 'ready' | 'preparing' | 'none' | 'failed';

export interface WelcomeResponse {
  state: WelcomeState;
  sessionId: string | null;
  projectId: string | null;
}

type WelcomeStore = EventStore;

function present(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

async function welcomeSetupStatus(
  store: WelcomeStore,
  cipher: SealableSecretCipher | undefined,
): Promise<WelcomeSetupStatus & { complete: boolean }> {
  const status = await computeOnboardingStatus(store, cipher);
  const settings = await store.getVeritySettingsRaw();
  return {
    complete: status.complete,
    aiProvider: status.claudeConfigured || status.codexConfigured || status.opencodeConfigured,
    github: status.githubAppConfigured,
    doppler: status.dopplerConfigured,
    // One account-level Google sign-in backs Drive, mail, calendar and contacts.
    google: present(settings?.googleDriveRefreshToken),
  };
}

/**
 * The welcome session of the starter project. A session the spawn created but
 * the server never got to mark (it died in between) is still empty and still
 * named "Welcome"; it is adopted rather than joined by a second one.
 */
async function findWelcomeSession(
  store: WelcomeStore,
  projectId: string,
): Promise<{ sessionId: string; needsGreeting: boolean } | undefined> {
  let unmarked: string | undefined;
  for (const session of await store.listSessions()) {
    if (session.projectId !== projectId) continue;
    if (await store.hasSessionAutomationMarker(session.sessionId, WELCOME_SESSION_MARKER)) {
      // Marked but empty: the server died between marking and writing the greeting.
      const empty = (await store.latestEventSeq(session.sessionId)) === 0;
      return { sessionId: session.sessionId, needsGreeting: empty };
    }
    if (
      unmarked === undefined &&
      session.name === WELCOME_SESSION_NAME &&
      (await store.latestEventSeq(session.sessionId)) === 0
    ) {
      unmarked = session.sessionId;
    }
  }
  if (unmarked === undefined) return undefined;
  await store.markSessionAutomation(unmarked, WELCOME_SESSION_MARKER);
  return { sessionId: unmarked, needsGreeting: true };
}

/**
 * Write the greeting into a fresh session without running a turn. The events are
 * stored but deliberately not published on the bus: a published `choices` followed
 * by a terminal status reads as "the agent is asking you something" and fires a
 * push notification at the operator who is looking at the app right now. The
 * closing `status` keeps the overview from showing the session as running.
 */
async function seedWelcomeSession(
  store: WelcomeStore,
  sessionId: string,
  status: WelcomeSetupStatus,
): Promise<void> {
  const events: AgentEvent[] = [
    { t: 'notice', role: 'agent', text: renderWelcomeOpener(status) },
    { t: 'choices', ...welcomeChoices(status) },
    { t: 'status', state: 'completed' },
  ];
  for (const event of events) await store.appendEvent(sessionId, event);
}

/**
 * `POST /onboarding/welcome`: return the welcome session, creating it on first
 * call. Idempotent, so the app polls this same request while the starter project
 * is still provisioning; a session create against a project that is not active
 * yet starts (or joins) its provisioning and answers `preparing`.
 */
export function registerWelcomeRoutes(
  app: FastifyInstance,
  deps: {
    eventStore: WelcomeStore;
    secretCipher: SealableSecretCipher | undefined;
    spawn: SpawnSession;
    notifySessionCreated: (sessionId: string, projectId: string) => void;
  },
): void {
  let inFlight: Promise<{ statusCode: number; body: WelcomeResponse | { error: string } }> | null =
    null;
  // The app polls every few seconds. A starter project whose provisioning failed
  // is retried once from here, not on every poll; after that it reports `failed`
  // and the operator can repair it from the project like any other.
  const retriedFailedProjects = new Set<string>();

  const welcome = async (
    log: FastifyBaseLogger,
  ): Promise<{ statusCode: number; body: WelcomeResponse | { error: string } }> => {
    const status = await welcomeSetupStatus(deps.eventStore, deps.secretCipher);
    if (!status.complete) {
      return { statusCode: 409, body: { error: 'finish onboarding first' } };
    }
    // By recorded id, never by name: an operator's own "getting-started" project
    // must not receive a welcome session.
    const starterProjectId = await deps.eventStore.getStarterProjectId();
    const project =
      starterProjectId === undefined
        ? undefined
        : await deps.eventStore.getProject(starterProjectId);
    if (project === undefined || project.hiddenAt !== null) {
      return { statusCode: 200, body: { state: 'none', sessionId: null, projectId: null } };
    }
    if (project.state === 'failed') {
      if (retriedFailedProjects.has(project.id)) {
        return {
          statusCode: 200,
          body: { state: 'failed', sessionId: null, projectId: project.id },
        };
      }
      retriedFailedProjects.add(project.id);
    }
    const existing = await findWelcomeSession(deps.eventStore, project.id);
    if (existing !== undefined) {
      if (existing.needsGreeting) {
        await seedWelcomeSession(deps.eventStore, existing.sessionId, status);
      }
      return {
        statusCode: 200,
        body: { state: 'ready', sessionId: existing.sessionId, projectId: project.id },
      };
    }
    // Through the request parser, so the welcome session gets the same defaults
    // and normalization as one created with POST /sessions.
    const spawned = await deps.spawn(
      parseSpawnRequestBody({ projectId: project.id, name: WELCOME_SESSION_NAME }),
      log,
    );
    const result = spawned.result;
    if ('sessionId' in result) {
      if (await deps.eventStore.markSessionAutomation(result.sessionId, WELCOME_SESSION_MARKER)) {
        await seedWelcomeSession(deps.eventStore, result.sessionId, status);
      }
      deps.notifySessionCreated(result.sessionId, project.id);
      return {
        statusCode: 200,
        body: { state: 'ready', sessionId: result.sessionId, projectId: project.id },
      };
    }
    if ('awaitingProvisioning' in result) {
      return {
        statusCode: 200,
        body: { state: 'preparing', sessionId: null, projectId: project.id },
      };
    }
    log.warn({ projectId: project.id, result }, 'verity: welcome session could not be created');
    return { statusCode: 200, body: { state: 'failed', sessionId: null, projectId: project.id } };
  };

  app.post('/onboarding/welcome', async (request, reply) => {
    // One run at a time: two concurrent first calls would otherwise both find no
    // welcome session and each create one.
    const run = inFlight ?? welcome(request.log);
    inFlight = run;
    try {
      const { statusCode, body } = await run;
      reply.code(statusCode);
      return body;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  });
}

/** The guide prompt for the welcome session, or an empty string for any other. */
export async function welcomeSessionPrompt(
  store: Pick<EventStore, 'hasSessionAutomationMarker'>,
  sessionId: string,
): Promise<string> {
  try {
    return (await store.hasSessionAutomationMarker(sessionId, WELCOME_SESSION_MARKER))
      ? renderWelcomeGuidePrompt()
      : '';
  } catch {
    // The guide is an extra; a failed lookup must not cost the operator the turn.
    return '';
  }
}
