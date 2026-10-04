import { isCodexModel } from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';

export function registerConnectionUsageRoutes(
  app: FastifyInstance,
  store: EventStore,
  getDefaultModel?: () => Promise<string | undefined>,
): void {
  app.get('/connections/usage', async () => {
    const projects = (await store.listProjects()).filter(
      (project) => !project.archived && project.kind !== 'control_plane',
    );
    const sources = await store.integrations.listSources();
    const sessions = await store.listSessions();
    const defaultModel = await getDefaultModel?.();
    const usage = {
      github: 0,
      claude: 0,
      codex: 0,
      opencode: 0,
      google: 0,
      matrix: 0,
      doppler: 0,
      mcp: 0,
    };
    for (const project of projects) {
      const settings = await store.getProjectSettings(project.id);
      const bindings = await store.listProjectMcpBindings(project.id);
      const grants = [];
      for (const service of ['gmail', 'calendar', 'contacts'] as const) {
        grants.push(await store.getProjectGoogleConnection(project.id, service));
      }
      if (project.kind === 'github') usage.github++;
      let legacyGoogle = false;
      for (const session of sessions.filter((session) => session.projectId === project.id)) {
        if (
          (await store.getSessionGmailConnection(session.sessionId)) ||
          (await store.getSessionCalendarConnection(session.sessionId)) ||
          (await store.getSessionContactsConnection(session.sessionId))
        ) {
          legacyGoogle = true;
          break;
        }
      }
      if (
        settings?.googleDriveFolderId ||
        grants.some((grant) => grant !== undefined) ||
        legacyGoogle
      )
        usage.google++;
      if (sources.some((source) => source.projectId === project.id)) usage.matrix++;
      if (settings?.dopplerProject && settings.dopplerConfig) usage.doppler++;
      if (bindings.some((binding) => binding.enabled)) usage.mcp++;
      // A login alone does not imply use: count effective defaults and session
      // choices according to the same model routing contract as the conductor.
      const models = [
        settings?.defaultModel ?? defaultModel,
        ...sessions
          .filter((session) => session.projectId === project.id)
          .map((session) => session.model),
      ].filter((model): model is string => Boolean(model));
      const backends = new Set(
        models.map((model) =>
          isCodexModel(model) ? 'codex' : model.includes('/') ? 'opencode' : 'claude',
        ),
      );
      for (const backend of ['claude', 'codex', 'opencode'] as const)
        if (backends.has(backend)) usage[backend]++;
    }
    return usage;
  });
}
