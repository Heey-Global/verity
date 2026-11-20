import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ServerContext } from './server-context.js';
import type { SpawnSession } from './session-create-route.js';
import { parseSpawnRequestBody } from './session-create-schema.js';
import { hasProjectWiki } from './wiki-occasions.js';
import {
  startWikiMaintenanceTrigger,
  WIKI_MAINTENANCE_DISPLAY_PROMPT,
  WIKI_MAINTENANCE_PROMPT,
  WIKI_MAINTENANCE_SESSION_NAME,
  type WikiMaintenanceTrigger,
} from './wiki-maintenance-trigger.js';

interface WikiMaintenanceOptions {
  spawn: SpawnSession;
  isProjectBusy: (projectId: string) => Promise<boolean>;
  wikiMaintenanceSessions: Set<string>;
}

export function installWikiMaintenance(
  app: FastifyInstance,
  ctx: ServerContext,
  { spawn, isProjectBusy, wikiMaintenanceSessions }: WikiMaintenanceOptions,
): void {
  const { deps, lifecycle, conductor, sessionsBeingReaped } = ctx;
  // Wiki maintenance runs when something new happened in a project (see
  // wiki-maintenance-trigger.ts and docs/knowledge.md).
  if (deps.dataRoot !== undefined) {
    const dataRoot = deps.dataRoot;
    let wikiMaintenance: WikiMaintenanceTrigger | undefined;
    app.addHook('onReady', async () => {
      try {
        for (const id of await deps.eventStore.wikiMaintenance.sessionIds())
          wikiMaintenanceSessions.add(id);
      } catch (err) {
        // The session list reads them again on every load; the runs still start.
        app.log.warn({ err }, 'wiki maintenance sessions could not be read');
      }
      wikiMaintenance = startWikiMaintenanceTrigger({
        store: deps.eventStore,
        hasWiki: (projectId) => hasProjectWiki(dataRoot, projectId),
        isProjectBusy: (projectId) => isProjectBusy(projectId),
        ensureSession: async (project) => {
          const known = (await deps.eventStore.wikiMaintenance.get(project.id))?.sessionId;
          const existing = known ? await deps.eventStore.getSession(known) : undefined;
          if (existing?.projectId === project.id) {
            wikiMaintenanceSessions.add(existing.sessionId);
            return existing.sessionId;
          }
          // Hidden before it exists, so no list or notification ever sees it.
          const sessionId = randomUUID();
          wikiMaintenanceSessions.add(sessionId);
          const created = await spawn(
            parseSpawnRequestBody({
              projectId: project.id,
              sessionId,
              name: WIKI_MAINTENANCE_SESSION_NAME,
            }),
            app.log,
          );
          if (!('sessionId' in created.result)) {
            wikiMaintenanceSessions.delete(sessionId);
            return undefined;
          }
          try {
            await deps.eventStore.wikiMaintenance.setSession(project.id, sessionId);
          } catch (err) {
            // Unrecorded, it would show up in lists after a restart and never be reused.
            await ctx.deleteSession(sessionId).catch(() => false);
            throw err;
          }
          return sessionId;
        },
        dispatch: (sessionId) =>
          sessionsBeingReaped.has(sessionId)
            ? Promise.resolve({ accepted: false })
            : conductor.dispatchTurnWhenIdle(
                sessionId,
                WIKI_MAINTENANCE_PROMPT,
                {},
                {
                  displayPrompt: WIKI_MAINTENANCE_DISPLAY_PROMPT,
                  validateSession: (session) =>
                    deps.eventStore.wikiMaintenance.isSession(session.sessionId),
                },
              ),
        log: app.log,
      });
    });
    lifecycle.onClose(async () => {
      await wikiMaintenance?.stop();
    });
  }
}
