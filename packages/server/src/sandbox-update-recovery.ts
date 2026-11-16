import type { ProjectActivityReason } from './project-idle-sleep.js';
import type { EventStore } from '@verity/store';
import type { LocalPreviewManager } from './local-preview-manager.js';
import type { ManagedDevServerManager } from './managed-dev-server-manager.js';
import type { PreviewShareManager } from './preview-share-manager.js';

export type SandboxUpdateRecoveryResult = { state: 'ready' | 'failed'; detail: string };

/** Capture actual serving resources, then verify their identities after a recreate.
 * Retained offline URLs are deliberately absent from the recovery obligation. */
export function createSandboxUpdateRecovery(input: {
  store: EventStore;
  devServers: () => ManagedDevServerManager | undefined;
  local: () => LocalPreviewManager | undefined;
  public: () => PreviewShareManager | undefined;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async capture(
      this: void,
      projectId: string,
    ): Promise<() => Promise<SandboxUpdateRecoveryResult>> {
      const capture = async (): Promise<() => Promise<SandboxUpdateRecoveryResult>> => {
        await input
          .local()
          ?.reconcile()
          .catch(() => undefined);
        const instances = (
          await input.store.managedDevServers.listInstances({ projectId, desired: 'running' })
        ).filter(
          (instance) =>
            instance.state === 'running' && input.devServers()?.hasVerifiedInstance(instance.id),
        );
        const names = new Map<string, string>();
        for (const instance of instances)
          names.set(
            instance.id,
            (await input.store.managedDevServers.get(instance.serverId))?.name ?? instance.id,
          );
        const local =
          input
            .local()
            ?.liveProjectShares(projectId)
            .map((share) => share.id) ?? [];
        const publicIds: string[] = [];
        for (const share of await input.store.listPublicPreviewShares(projectId))
          if (await input.public()?.isOnline(share)) publicIds.push(share.id);
        return async () => {
          const timeoutMs = input.timeoutMs ?? 120_000;
          const deadline = now() + timeoutMs;
          let expired = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let detail = 'Recovery check did not finish';
          const run = async (): Promise<SandboxUpdateRecoveryResult> => {
            for (;;) {
              try {
                // Reconcilers also cover other projects; their errors must not hide
                // this project's per-resource recovery result below.
                await input
                  .devServers()
                  ?.tick()
                  .catch(() => undefined);
                await input
                  .local()
                  ?.reconcile()
                  .catch(() => undefined);
                await input
                  .public()
                  ?.reconcile()
                  .catch(() => undefined);
                const verified = await input
                  .devServers()
                  ?.verifyRecoveryInstances(instances.map((instance) => instance.id));
                const missing: string[] = [];
                for (const before of instances) {
                  const instance = await input.store.managedDevServers.getInstance(before.id);
                  if (instance?.state !== 'running' || !verified?.has(before.id))
                    missing.push(
                      `Dev server “${names.get(before.id)}” did not restart${instance?.detail ? `: ${instance.detail}` : ''}`,
                    );
                }
                const liveLocal = new Set(
                  input
                    .local()
                    ?.liveProjectShares(projectId)
                    .map((share) => share.id),
                );
                for (const id of local)
                  if (!liveLocal.has(id)) missing.push(`Local preview ${id} is offline`);
                for (const id of publicIds) {
                  const share = await input.store.getPublicPreviewShare(id);
                  if (!share || !(await input.public()?.isOnline(share)))
                    missing.push(`Public preview ${id} is offline`);
                }
                if (missing.length === 0)
                  return { state: 'ready', detail: 'Update applied; all services recovered' };
                detail = missing.join('; ');
              } catch (error) {
                detail = `Recovery check failed: ${error instanceof Error ? error.message : String(error)}`;
              }
              if (expired || now() >= deadline) return { state: 'failed', detail };
              await wait(Math.min(input.pollMs ?? 2_000, deadline - now()));
            }
          };
          try {
            return await Promise.race([
              run(),
              new Promise<SandboxUpdateRecoveryResult>((resolve) => {
                timer = setTimeout(() => {
                  expired = true;
                  resolve({ state: 'failed', detail: `${detail}; recovery deadline exceeded` });
                }, timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          capture(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Service recovery capture deadline exceeded')),
              input.timeoutMs ?? 120_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Domain lifecycle hooks keep the composition root focused on wiring. */
export function sandboxUpdateLifecycleHooks(
  input: Parameters<typeof createSandboxUpdateRecovery>[0] & {
    log: () => { info: (event: Record<string, unknown>, message: string) => void };
  },
) {
  return {
    sandboxUpdateRecovery: createSandboxUpdateRecovery(input),
    onSandboxUpdateRecovery: (projectId: string, result: SandboxUpdateRecoveryResult) =>
      input.log().info({ projectId, ...result }, 'verity: sandbox update recovery'),
    onSandboxServiceInterruption: (
      projectId: string,
      reason: 'nightly_update' | 'manual_update',
      blockers: readonly ProjectActivityReason[],
    ) =>
      input
        .log()
        .info({ projectId, reason, blockers }, 'verity: sandbox update interrupts services'),
  };
}
