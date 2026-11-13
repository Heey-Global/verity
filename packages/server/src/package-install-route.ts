import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import {
  internalConnectionIdentity,
  internalConnectionGenerationSignal,
} from './internal-listener.js';
import { createPackageArtifactBroker } from './package-artifact-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';
import {
  createNpmInstallGrant,
  npmInstallGrant,
  npmPackageIdentity,
  npmReleaseEligibility,
  revokeNpmInstallGrant,
} from './package-install-grants.js';

/** Registry lookups one verification runs at once; the broker bounds all requests. */
export const PUBLICATION_LOOKUP_CONCURRENCY = 6;
/** Publication times never change once released, so facts outlive one install. */
export const PUBLICATION_FACT_TTL_MS = 24 * 60 * 60_000;
export const PUBLICATION_FACT_LIMIT = 50_000;

const npmPackages = z
  .array(
    z
      .object({
        name: z
          .string()
          .min(1)
          .max(214)
          .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
        version: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[0-9A-Za-z.+_-]+$/u),
      })
      .strict(),
  )
  .max(5000);

const inputSchema = z.object({
  action: z.enum(['check', 'configured', 'verify', 'complete']),
  sessionId: z.string().min(1).max(256),
  manager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv']),
  command: z.string().min(1).max(16_384),
  supported: z.boolean(),
  protected: z.boolean(),
  configFile: z.string().min(1).max(4096),
  setupToken: z.string().uuid().optional(),
  packages: npmPackages.optional(),
  minimumAgeDays: z.number().finite().min(3).max(3650).optional(),
  installToken: z.string().uuid().optional(),
});

interface SetupGrant {
  projectId: string;
  containerGeneration: string;
  sessionId: string;
  manager: string;
  configFile: string;
  expires: number;
}

export function registerPackageInstallRoute(
  app: FastifyInstance,
  deps: {
    capabilities?: GhTokenCapabilityRegistry | undefined;
    store: Pick<
      EventStore,
      'getSession' | 'getPackageProtectionDecision' | 'setPackageProtectionDecision'
    >;
    conductor: Pick<Conductor, 'requestExternalPermission'>;
    appendNotice: (sessionId: string, text: string) => Promise<void>;
    packageTransport?: BrokeredHttpStreamTransport;
  },
): void {
  if (!deps.capabilities) return;
  const capabilities = deps.capabilities;
  const queues = new Map<string, Promise<void>>();
  const setupSelections = new Set<string>();
  const grants = new Map<string, SetupGrant>();
  const packageBroker = createPackageArtifactBroker(
    deps.packageTransport ? { transport: deps.packageTransport } : {},
  );
  // Publication facts only: verdicts, capability authority and exceptions are never cached.
  const publicationTimes = new Map<string, { published: string; expires: number }>();
  const publicationTime = (identity: string): string | undefined => {
    const cached = publicationTimes.get(identity);
    if (cached && cached.expires > Date.now()) return cached.published;
    publicationTimes.delete(identity);
    return undefined;
  };

  app.post('/internal/package-install', async (request, reply) => {
    const token = bearerToken(request.headers.authorization) ?? '';
    const binding = token === '' ? undefined : await capabilities.resolve(token);
    const socket = internalConnectionIdentity(request);
    if (
      !binding ||
      !socket ||
      socket.projectId !== binding.projectId ||
      socket.containerGeneration !== binding.containerGeneration
    )
      return reply.code(401).send({ error: 'unauthorized' });
    const generationSignal = internalConnectionGenerationSignal(request);
    const authorized = async (): Promise<boolean> => {
      if (generationSignal?.aborted) return false;
      const current = await capabilities.resolve(token);
      return (
        !generationSignal?.aborted &&
        current?.projectId === binding.projectId &&
        current.containerGeneration === binding.containerGeneration
      );
    };
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid package installation request' });
    const body = parsed.data;
    const session = await deps.store.getSession(body.sessionId);
    if (!session || session.projectId !== binding.projectId)
      return reply.code(404).send({ error: 'session not found in this project' });
    if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
    const projectId = binding.projectId;
    for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key);

    if (body.action === 'complete') {
      const grant = body.installToken ? npmInstallGrant(body.installToken) : undefined;
      if (!grant || grant.sourceToken !== token || grant.sessionId !== body.sessionId)
        return reply.code(409).send({ error: 'no matching package installation' });
      revokeNpmInstallGrant(body.installToken!);
      return { action: 'complete' };
    }

    if (body.action === 'configured') {
      const grant = body.setupToken === undefined ? undefined : grants.get(body.setupToken);
      if (
        !grant ||
        grant.projectId !== projectId ||
        grant.containerGeneration !== binding.containerGeneration ||
        grant.sessionId !== body.sessionId ||
        grant.manager !== body.manager ||
        grant.configFile !== body.configFile ||
        !body.protected ||
        !body.supported
      )
        return reply.code(409).send({ error: 'no matching approved package protection setup' });
      await deps.store.setPackageProtectionDecision(projectId, 'protected');
      grants.delete(body.setupToken!);
      setupSelections.delete(projectId);
      await deps.appendNotice(body.sessionId, `3-day delay set up · ${basename(body.configFile)}`);
      if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
      return { action: 'continue' };
    }

    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    const closed = (): void => {
      if (!reply.raw.writableFinished) abort();
    };
    generationSignal?.addEventListener('abort', abort, { once: true });
    request.raw.once('aborted', abort);
    reply.raw.once('close', closed);
    const previous = queues.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const queued = previous.then(() => waiting);
    queues.set(projectId, queued);
    try {
      await previous;
      if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
      if (body.action === 'verify') {
        if (body.manager !== 'npm' || !body.packages || body.minimumAgeDays === undefined)
          return reply
            .code(400)
            .send({ error: 'npm verification needs packages and minimumAgeDays' });
        const minimumAgeDays = body.minimumAgeDays;
        const identities = new Set<string>();
        const exceptions = new Set<string>();
        const violations: string[] = [];
        // One bounded provider response at a time; never trust client publication dates.
        const byName = new Map<string, string[]>();
        for (const pkg of body.packages) {
          const versions = byName.get(pkg.name) ?? [];
          if (!versions.includes(pkg.version)) versions.push(pkg.version);
          byName.set(pkg.name, versions);
        }
        // Look up names concurrently; the first failure stops the remaining lookups.
        const lookups = [...byName];
        const resolved = new Map<string, Map<string, string | undefined>>();
        const stop = new AbortController();
        const lookupSignal = AbortSignal.any([controller.signal, stop.signal]);
        let rejection: string | undefined;
        let failed: string | undefined;
        let next = 0;
        const lookup = async (): Promise<void> => {
          while (next < lookups.length && !lookupSignal.aborted) {
            const [name, versions] = lookups[next++]!;
            const times = new Map(
              versions.map((version) => [
                version,
                publicationTime(npmPackageIdentity(name, version)),
              ]),
            );
            const missing = versions.filter((version) => times.get(version) === undefined);
            if (missing.length > 0) {
              let metadata: Awaited<ReturnType<typeof packageBroker.publicationTimes>>;
              try {
                metadata = await packageBroker.publicationTimes(
                  name,
                  missing,
                  lookupSignal,
                  authorized,
                );
              } catch (error) {
                // A lookup cut short by another lookup's verdict does not change it.
                if (stop.signal.aborted) return;
                failed ??= `${name}@${versions.join(',')}`;
                stop.abort();
                throw error;
              }
              for (const version of missing) {
                const identity = npmPackageIdentity(name, version);
                const published = metadata.times.get(version);
                const problem = !metadata.versions.has(version)
                  ? 'release metadata is unavailable'
                  : typeof published !== 'string' ||
                      !npmReleaseEligibility(published, minimumAgeDays).availableAt
                    ? 'publication time is missing or invalid'
                    : undefined;
                if (problem || typeof published !== 'string') {
                  rejection ??= `Cannot verify ${identity}: ${problem ?? 'publication time is missing or invalid'}.`;
                  stop.abort();
                  return;
                }
                while (publicationTimes.size >= PUBLICATION_FACT_LIMIT)
                  publicationTimes.delete(publicationTimes.keys().next().value!);
                publicationTimes.set(identity, {
                  published,
                  expires: Date.now() + PUBLICATION_FACT_TTL_MS,
                });
                times.set(version, published);
              }
            }
            resolved.set(name, times);
          }
        };
        const outcomes = await Promise.allSettled(
          Array.from({ length: Math.min(PUBLICATION_LOOKUP_CONCURRENCY, lookups.length) }, lookup),
        );
        const lookupFailed =
          failed !== undefined ||
          controller.signal.aborted ||
          outcomes.some((outcome) => outcome.status === 'rejected');
        if (!lookupFailed && rejection !== undefined)
          return reply.code(409).send({ error: rejection });
        try {
          if (lookupFailed) throw new Error('publication lookup failed');
          // Evaluate in lockfile order so the reported exceptions stay deterministic.
          for (const [name, versions] of byName) {
            const times = resolved.get(name)!;
            for (const version of versions) {
              const identity = npmPackageIdentity(name, version);
              const eligibility = npmReleaseEligibility(times.get(version), body.minimumAgeDays);
              if (!eligibility.availableAt)
                return reply.code(409).send({
                  error: `Cannot verify ${identity}: publication time is missing or invalid.`,
                });
              identities.add(identity);
              if (!eligibility.eligible) {
                exceptions.add(identity);
                violations.push(`${identity}: available ${eligibility.availableAt}`);
              }
            }
          }
        } catch {
          if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
          return reply.code(502).send({
            error: `Cannot verify ${failed ?? 'npm release'} metadata; installation remains blocked.`,
          });
        }
        if (violations.length > 0) {
          if (violations.length > 40)
            return reply.code(409).send({
              error: `Installation contains ${violations.length} young releases; wait for the release-age window instead of approving a bulk exception.`,
            });
          // The setup decision (including a saved Skip) never authorizes young versions.
          const answer = await deps.conductor.requestExternalPermission({
            sessionId: body.sessionId,
            toolUseId: `package-install-exception-${randomUUID()}`,
            toolName: 'verity_package_install',
            input: {
              command: `${body.command}\nRelease-age exception for this installation only (${body.minimumAgeDays} days):\n${violations.join('\n')}`,
              manager: 'npm',
              supported: false,
              packages: [...exceptions],
              minimumAgeDays: body.minimumAgeDays,
            },
            channel: 'acp',
            allowStandingGrant: false,
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            !(await authorized()) ||
            answer.decision.behavior !== 'allow' ||
            answer.decision.updatedInput?.action !== 'install'
          )
            return { action: 'cancel' };
          await deps.appendNotice(
            body.sessionId,
            `Release-age exception approved for this installation only · ${[...exceptions].join(', ')}`,
          );
        }
        if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
        const installToken = createNpmInstallGrant({
          sourceToken: token,
          projectId,
          containerGeneration: binding.containerGeneration,
          sessionId: body.sessionId,
          policy: { minimumAgeDays: body.minimumAgeDays, packages: identities, exceptions },
        });
        return { action: 'continue', installToken };
      }
      const configure = (): { action: 'configure'; setupToken: string } => {
        const setupToken = randomUUID();
        grants.set(setupToken, {
          projectId,
          containerGeneration: socket.containerGeneration,
          sessionId: body.sessionId,
          manager: body.manager,
          configFile: body.configFile,
          expires: Date.now() + 10 * 60_000,
        });
        return { action: 'configure', setupToken };
      };
      const saved = await deps.store.getPackageProtectionDecision(projectId);
      if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
      if (saved === 'skipped') return { action: 'continue' };
      // A stale file on an older CLI is not evidence the setting is effective.
      if (body.protected && body.supported) {
        await deps.store.setPackageProtectionDecision(projectId, 'protected');
        return { action: (await authorized()) ? 'continue' : 'cancel' };
      }
      if ((saved === 'protected' || setupSelections.has(projectId)) && body.supported)
        return configure();
      const answer = await deps.conductor.requestExternalPermission({
        sessionId: body.sessionId,
        toolUseId: `package-install-${randomUUID()}`,
        toolName: 'verity_package_install',
        input: {
          command: body.command,
          manager: body.manager,
          supported: body.supported,
          configFile: basename(body.configFile),
        },
        channel: 'acp',
        allowStandingGrant: false,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !(await authorized()) ||
        answer.decision.behavior !== 'allow'
      )
        return { action: 'cancel' };
      const action = answer.decision.updatedInput?.action;
      if (body.supported && action === 'configure') {
        setupSelections.add(projectId);
        return configure();
      }
      if ((body.supported && action === 'skip') || (!body.supported && action === 'install')) {
        setupSelections.delete(projectId);
        for (const [key, grant] of grants) if (grant.projectId === projectId) grants.delete(key);
        await deps.store.setPackageProtectionDecision(projectId, 'skipped');
        await deps.appendNotice(
          body.sessionId,
          'Dependency release delay skipped · decision saved',
        );
        return { action: (await authorized()) ? 'continue' : 'cancel' };
      }
      return { action: 'cancel' };
    } finally {
      release();
      if (queues.get(projectId) === queued) queues.delete(projectId);
      generationSignal?.removeEventListener('abort', abort);
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', closed);
    }
  });
}
