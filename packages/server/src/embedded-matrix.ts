import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from './server-deps.js';
import { notifyManagedMatrixConfigured } from './self-update/server-update-controller.js';

export function createEmbeddedMatrix(ctx: {
  integrations: Pick<EventStore['integrations'], 'matrixConfigSummary'>;
}) {
  const managedMatrixControl = existsSync('/run/verity-updater/control');
  let matrixActivationDone = false;
  const activateMatrixIfConfigured = async (): Promise<void> => {
    if (!managedMatrixControl || matrixActivationDone) return;
    if ((await ctx.integrations.matrixConfigSummary()) === null) return;
    matrixActivationDone = await notifyManagedMatrixConfigured();
  };

  const bindings: Pick<ServerDeps, 'onMatrixConfigured' | 'matrixConnectorToken'> = {
    ...(managedMatrixControl ? { onMatrixConfigured: activateMatrixIfConfigured } : {}),
    matrixConnectorToken: async () => {
      try {
        return (
          await readFile('/run/verity-updater/control/matrix/connector-token', 'utf8')
        ).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return process.env.VERITY_MATRIX_CONNECTOR_TOKEN;
        throw error;
      }
    },
  };
  return { bindings, managedMatrixControl, activateMatrixIfConfigured };
}

export function installEmbeddedMatrix(
  app: FastifyInstance,
  ctx: ReturnType<typeof createEmbeddedMatrix>,
): void {
  const { managedMatrixControl, activateMatrixIfConfigured } = ctx;
  if (managedMatrixControl) {
    const retryMatrixActivation = async (): Promise<void> => {
      try {
        await activateMatrixIfConfigured();
      } catch (error) {
        app.log.warn({ err: error }, 'Matrix connector activation will retry');
      }
    };
    void retryMatrixActivation();
    const matrixActivationTimer = setInterval(() => void retryMatrixActivation(), 10_000);
    matrixActivationTimer.unref?.();
    app.addHook('onClose', () => clearInterval(matrixActivationTimer));
  }
}
