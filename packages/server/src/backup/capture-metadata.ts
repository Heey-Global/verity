import { z } from 'zod';
import { posix } from 'node:path';
import { validateBackupPath } from './format.js';
const path = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      validateBackupPath(value);
      return true;
    } catch {
      return false;
    }
  });
const boundedText = z.string().max(4096);
const bytes = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const timestamp = z.string().datetime({ offset: true });
export const captureMetadataSchema = z
  .object({
    startedAt: timestamp,
    finishedAt: timestamp,
    databaseAt: timestamp,
    barrierMs: z.number().nonnegative().finite(),
    sourceRoot: z.string().startsWith('/').max(4096),
    architecture: z.enum(['amd64', 'arm64']),
    image: z
      .string()
      .regex(
        /^ghcr\.io\/heey-global\/verity\/verity-server(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/,
      ),
    scope: z
      .array(z.enum(['database', 'workspaces', 'sessions', 'knowledge', 'identity']))
      .length(5),
    activeTurns: z.array(z.string().min(1).max(256)).max(50000),
    projects: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            state: z.enum([
              'absent',
              'cloning',
              'container_starting',
              'active',
              'sleeping_starting',
              'sleeping',
              'waking',
              'failed',
            ]),
            archived: z.boolean(),
            paths: z.array(path).max(50000),
            bytes,
            warnings: z.array(boundedText).max(1000),
          })
          .strict(),
      )
      .max(10000),
    exclusions: z.array(z.object({ path, bytes }).strict()).max(50000),
    warnings: z.array(boundedText).max(10000),
    identity: z
      .array(
        z.enum([
          'deployment-id',
          'pairing-identity.pem',
          'tls-key.pem',
          'tls-cert.pem',
          'tls-ca-cert.pem',
        ]),
      )
      .length(5),
    caKey: z
      .object({
        installationId: z.string().uuid(),
        keyGeneration: z.number().int().min(1).max(999999999),
        path,
      })
      .strict(),
    git: z
      .array(
        z
          .object({
            repoKey: z.string().uuid(),
            projectId: z.string().min(1).max(256),
            path,
            status: z.enum(['validated', 'not-validated', 'alternates-dropped', 'unstable']),
            findings: z.array(boundedText).max(50000),
            pointers: z.array(z.object({ path, target: boundedText }).strict()).max(50000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceRoot !== posix.normalize(value.sourceRoot) ||
      [...value.sourceRoot].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
      )
    )
      context.addIssue({ code: 'custom', message: 'Invalid capture source root' });
    const ownedPaths = value.projects.flatMap((project) => project.paths);
    const owners = new Set(ownedPaths);
    if (
      owners.size !== ownedPaths.length ||
      ownedPaths.some(
        (path) =>
          !/^(workspaces|sessions)\//.test(path) ||
          path
            .split('/')
            .some((_, index, parts) => index > 0 && owners.has(parts.slice(0, index).join('/'))),
      )
    )
      context.addIssue({ code: 'custom', message: 'Ambiguous project path ownership' });
    for (const git of value.git) {
      const project = value.projects.find((candidate) => candidate.id === git.projectId);
      if (
        !git.path.endsWith('/.git') ||
        !project?.paths.some((path) => git.path.startsWith(path + '/')) ||
        new Set(git.pointers.map((pointer) => pointer.path)).size !== git.pointers.length
      )
        context.addIssue({ code: 'custom', message: 'Invalid Git ownership or pointer inventory' });
    }
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt))
      context.addIssue({ code: 'custom', message: 'Capture window is reversed' });
    if (
      new Set(value.scope).size !== 5 ||
      new Set(value.identity).size !== 5 ||
      new Set(value.projects.map((project) => project.id)).size !== value.projects.length ||
      new Set(value.git.map((git) => git.repoKey)).size !== value.git.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate capture inventory entry' });
  });
export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;
