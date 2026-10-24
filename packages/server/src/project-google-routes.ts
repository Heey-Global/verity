import { registerGoogleAccountRoutes } from './google-account-routes.js';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';

const params = z.object({
  id: z.string().min(1),
  service: z.enum(['gmail', 'calendar', 'contacts']),
});
const checks = {
  gmail: hasGoogleGmailScopes,
  calendar: hasGoogleCalendarScopes,
  contacts: hasGoogleContactsScopes,
};

export function registerProjectGoogleRoutes(app: FastifyInstance, eventStore: EventStore): void {
  registerGoogleAccountRoutes(app, eventStore);
  app.get('/google/connection', async () => {
    const accounts = await eventStore.googleAccounts.list();
    if (accounts.length > 0) {
      const used = new Map<string, { id: string; name: string }>();
      for (const account of accounts)
        for (const project of (await eventStore.googleAccounts.usage(account.id)).projects)
          used.set(project.id, project);
      return {
        connected: true,
        accountEmail: accounts.length === 1 ? accounts[0]!.email : null,
        scopes: [...new Set(accounts.flatMap((account) => account.scopes))],
        projects: [...used.values()],
      };
    }
    const settings = await eventStore.getVeritySettings();
    const projects = (await eventStore.listProjects()).filter(
      (project) => !project.archived && project.kind !== 'control_plane',
    );
    const sessions = await eventStore.listSessions();
    const used = [];
    for (const project of projects) {
      const projectSettings = await eventStore.getProjectSettings(project.id);
      const grants = await Promise.all(
        (['gmail', 'calendar', 'contacts'] as const).map((service) =>
          eventStore.getProjectGoogleConnection(project.id, service),
        ),
      );
      const legacy = await Promise.all(
        sessions
          .filter((session) => session.projectId === project.id)
          .flatMap((session) => [
            eventStore.getSessionGmailConnection(session.sessionId),
            eventStore.getSessionCalendarConnection(session.sessionId),
            eventStore.getSessionContactsConnection(session.sessionId),
          ]),
      );
      if (
        projectSettings?.googleDriveFolderId ||
        [...grants, ...legacy].some((grant) => grant !== undefined)
      )
        used.push({ id: project.id, name: project.repo });
    }
    return {
      connected: Boolean(settings?.googleDriveRefreshToken?.trim()),
      accountEmail: settings?.googleDriveAccountEmail ?? null,
      scopes: settings?.googleGrantedScopes ?? [],
      projects: used,
    };
  });
  app.get('/projects/:id/google/:service', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid Google connection parameters' });
    const { id, service } = parsed.data;
    if (!(await eventStore.getProject(id)))
      return reply.code(404).send({ error: 'Project not found' });
    const accounts = await eventStore.googleAccounts.list();
    if (accounts.length > 0) {
      const account = await eventStore.googleAccounts.projectAccess(id, service);
      return {
        enabled: account !== undefined && checks[service](account.scopes),
        connected: accounts.some((candidate) => checks[service](candidate.scopes)),
        accountId: account?.id ?? null,
        accountEmail: account?.email ?? null,
        accountName: account?.displayName ?? null,
        clientId: account?.clientId ?? accounts[0]?.clientId ?? null,
        legacySessionCount: await eventStore.countLegacyProjectGoogleSessions(id, service),
      };
    }
    const settings = await eventStore.getVeritySettings();
    const grant = await eventStore.getProjectGoogleConnection(id, service);
    const legacySessionCount = await eventStore.countLegacyProjectGoogleSessions(id, service);
    const connected =
      Boolean(settings?.googleDriveRefreshToken?.trim()) &&
      checks[service](settings?.googleGrantedScopes);
    return {
      legacySessionCount,
      enabled:
        grant !== undefined &&
        grant.accountEmail.toLowerCase() === settings?.googleDriveAccountEmail?.toLowerCase(),
      connected,
      accountEmail: settings?.googleDriveAccountEmail ?? null,
      clientId: settings?.googleDriveClientId ?? null,
    };
  });
  app.put('/projects/:id/google/:service', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid Google connection parameters' });
    const { id, service } = parsed.data;
    if (!(await eventStore.getProject(id)))
      return reply.code(404).send({ error: 'Project not found' });
    const allAccounts = await eventStore.googleAccounts.list();
    const accounts = allAccounts.filter((account) => checks[service](account.scopes));
    const body = z.object({ accountId: z.string().min(1).optional() }).parse(request.body ?? {});
    if (body.accountId !== undefined || allAccounts.length > 0) {
      const account =
        body.accountId === undefined
          ? accounts.length === 1
            ? accounts[0]
            : undefined
          : accounts.find((candidate) => candidate.id === body.accountId);
      if (!account) return reply.code(409).send({ error: 'Select an authorized Google account' });
      await eventStore.googleAccounts.setProjectAccess(id, service, account.id);
      return {
        enabled: true,
        connected: true,
        accountId: account.id,
        accountEmail: account.email,
        accountName: account.displayName,
        clientId: account.clientId,
      };
    }
    const settings = await eventStore.getVeritySettings();
    if (
      !settings?.googleDriveRefreshToken?.trim() ||
      !settings.googleDriveAccountEmail ||
      !checks[service](settings.googleGrantedScopes)
    )
      return reply.code(409).send({ error: 'Connect this Google service first' });
    await eventStore.enableProjectGoogleConnection(id, service, settings.googleDriveAccountEmail);
    return {
      enabled: true,
      connected: true,
      accountEmail: settings.googleDriveAccountEmail,
      clientId: settings.googleDriveClientId,
    };
  });
  app.delete('/projects/:id/google/:service', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid Google connection parameters' });
    const { id, service } = parsed.data;
    if (!(await eventStore.getProject(id)))
      return reply.code(404).send({ error: 'Project not found' });
    if ((await eventStore.googleAccounts.list()).length > 0) {
      await eventStore.googleAccounts.setProjectAccess(id, service, null);
    } else await eventStore.disableProjectGoogleConnection(id, service);
    return { enabled: false };
  });
}
