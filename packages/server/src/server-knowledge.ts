import type { FastifyInstance } from 'fastify';
import { CODEX_DEFAULT_MODEL } from '@verity/session';
import type { ServerContext } from './server-context.js';
import type { createServerModels } from './server-models.js';
import { veritySettingsStore } from './server-support.js';
import { registerIntegrationRoutes } from './integrations/routes.js';
import { knowledgeRef, noteWikiOccasion, occasionTitle } from './wiki-occasions.js';
import { createKnowledgeImageQuery } from './knowledge-image-query.js';
import { createImageTextExtractor, type ImageTextJob } from './knowledge-image-text.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { registerKnowledgeSourceRoutes } from './knowledge-source-routes.js';

export function installKnowledge(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: Pick<ReturnType<typeof createServerModels>, 'availableModels' | 'projectDefaultModel'>,
): void {
  const { deps, conductor } = ctx;
  const { availableModels, projectDefaultModel } = wiring;
  if (deps.eventStore.knowledge !== undefined) {
    registerKnowledgeSourceRoutes(app, {
      knowledge: deps.eventStore.knowledge,
      store: deps.eventStore,
      ...(deps.dataRoot !== undefined ? { dataRoot: deps.dataRoot } : {}),
    });
    registerKnowledgeRoutes(app, {
      knowledge: deps.eventStore.knowledge,
    });
  }
  // Chat images get their text read by the project's default model in the
  // background. Codex and OpenCode use direct model requests without agent tools.
  const imageTextExtractor =
    deps.refineCwd === undefined
      ? undefined
      : createImageTextExtractor({
          query: createKnowledgeImageQuery({
            fallback: (input) => conductor.query(input),
            codexCredential: deps.codexGatewayCredentialProvider,
            codexDefaultModel: async () =>
              (await availableModels()).modelOrder?.find(
                (id) => id.startsWith('codex/') && id !== CODEX_DEFAULT_MODEL,
              ),
            openCode: async () => {
              const settings = await veritySettingsStore(deps.eventStore).getVeritySettings();
              const baseUrl = settings?.opencodeBaseUrl?.trim();
              const apiKey = settings?.opencodeApiKey?.trim();
              return baseUrl && apiKey ? { baseUrl, apiKey } : undefined;
            },
          }),
          cwd: deps.refineCwd,
          modelFor: (projectId) => projectDefaultModel(projectId),
          onError: (error, job) =>
            app.log.warn(
              { err: error, projectId: job.projectId, path: job.relativePath },
              'verity: image text extraction failed',
            ),
        });
  registerIntegrationRoutes(app, {
    store: deps.eventStore.integrations,
    onChatDay: (projectId, path, room) =>
      noteWikiOccasion(
        deps.eventStore,
        {
          projectId,
          kind: 'chat',
          ref: knowledgeRef(path),
          title: `${room} · ${occasionTitle(path)}`,
          reopen: true,
        },
        app.log,
      ),
    ...(deps.dataRoot !== undefined ? { dataRoot: deps.dataRoot } : {}),
    ...(deps.matrixConnectorToken !== undefined
      ? { connectorToken: deps.matrixConnectorToken }
      : {}),
    ...(deps.onMatrixConfigured !== undefined
      ? { onMatrixConfigured: deps.onMatrixConfigured }
      : {}),
    ...(imageTextExtractor !== undefined
      ? { extractImageText: (job: ImageTextJob) => void imageTextExtractor.enqueue(job) }
      : {}),
  });
}
