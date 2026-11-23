import type { FastifyInstance } from 'fastify';
import type { ManagedDevServerManager } from './managed-dev-server-manager.js';
import type { ProvisionerImpl } from './provisioner.js';
import { installPersonalSandboxSleep } from './personal-sandbox-sleep.js';
import { ensureStarterProject } from './welcome-session.js';

export function installEmbeddedPersonalSandboxSleep(
  app: FastifyInstance,
  eventStore: Parameters<typeof installPersonalSandboxSleep>[1]['store'],
  managedDevServerManager: Pick<ManagedDevServerManager, 'hasRunningServersFor'> | undefined,
  provisioner: Pick<ProvisionerImpl, 'sleepPersonalSandbox'> | undefined,
): void {
  // A person's own sandbox sleeps once nothing needs it (ADR 0023 §4), so a
  // member's container uses memory only while that member works.
  installPersonalSandboxSleep(app, {
    store: eventStore,
    hasRunningServersFor: async (projectId, userId) =>
      managedDevServerManager?.hasRunningServersFor(projectId, userId),
    sleepSandbox: () => provisioner?.sleepPersonalSandbox?.bind(provisioner),
  });
}

export function startEmbeddedStarterProject(
  app: Pick<FastifyInstance, 'log'>,
  eventStore: Parameters<typeof ensureStarterProject>[0]['store'],
  provisioner: Pick<ProvisionerImpl, 'provision'> | undefined,
): void {
  // A fresh installation provisions its starter project now, so the sandbox image
  // is pulled while the operator is still onboarding (see welcome-session.ts).
  if (provisioner !== undefined) {
    void ensureStarterProject({
      store: eventStore,
      provision: (projectId) =>
        provisioner.provision(projectId, {
          initiator: { kind: 'system', trigger: 'welcome_project' },
        }),
      log: app.log,
    });
  }
}
