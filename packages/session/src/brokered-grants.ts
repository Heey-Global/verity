import { createHash } from 'node:crypto';

import { BROKERED_JWT_DEFAULT_LIFETIME_SECONDS, canonicalJson } from '@verity/secret-contracts';

/** Tools whose permission prompt a standing operator grant may answer (ADR 0011 D2). */
export type BrokeredGrantToolName = 'verity_http_request' | 'verity_secret_run';

export function brokeredGrantToolName(toolName: string): BrokeredGrantToolName | undefined {
  return toolName === 'verity_http_request' || toolName === 'verity_secret_run'
    ? toolName
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build the exact security scope persisted for a standing brokered-secret grant. */
export function brokeredGrantTarget(
  toolName: BrokeredGrantToolName,
  input: Record<string, unknown> | undefined,
):
  | {
      secretAlias: string;
      secretAliases: readonly string[];
      toolName: BrokeredGrantToolName;
      target: string;
    }
  | undefined {
  if (input === undefined) return undefined;
  if (toolName === 'verity_secret_run') {
    const secrets = input['secrets'];
    const command = input['command'];
    const entryScript = input['entryScript'];
    if (!Array.isArray(secrets) || !Array.isArray(command) || !isRecord(entryScript))
      return undefined;
    const secretMappings = secrets.map((secret) => {
      if (
        !isRecord(secret) ||
        typeof secret['secretAlias'] !== 'string' ||
        typeof secret['env'] !== 'string' ||
        (secret['injection'] !== undefined &&
          secret['injection'] !== 'env' &&
          secret['injection'] !== 'file')
      )
        return undefined;
      return {
        secretAlias: secret['secretAlias'],
        env: secret['env'],
        injection: secret['injection'] ?? 'env',
      };
    });
    const path = entryScript['path'];
    const projectPath = entryScript['projectPath'];
    const sha256 = entryScript['sha256'];
    const loading = entryScript['loading'];
    if (
      secretMappings.length === 0 ||
      secretMappings.some((mapping) => mapping === undefined) ||
      command.length < 2 ||
      command.some((token) => typeof token !== 'string') ||
      typeof path !== 'string' ||
      typeof projectPath !== 'string' ||
      projectPath.startsWith('/') ||
      projectPath
        .split('/')
        .some((component) => component === '' || component === '.' || component === '..') ||
      typeof sha256 !== 'string' ||
      !path.startsWith('/') ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      loading !== 'isolated' ||
      typeof command[0] !== 'string' ||
      !command[0].startsWith('/') ||
      (!command[0].startsWith('/bin/') && !command[0].startsWith('/usr/')) ||
      command[1] !== path
    )
      return undefined;
    const validMappings = secretMappings.filter((mapping) => mapping !== undefined);
    const commandTokens = command as string[];
    const sortedMappings = validMappings.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    const descriptor = createHash('sha256')
      .update(
        canonicalJson({
          command: [commandTokens[0], projectPath, ...commandTokens.slice(2)],
          secrets: sortedMappings,
          entryScript: { projectPath, sha256, loading },
        }),
      )
      .digest('hex');
    return {
      secretAlias: sortedMappings[0]!.secretAlias,
      secretAliases: [...new Set(sortedMappings.map((mapping) => mapping.secretAlias))],
      toolName,
      target: `v1:${String(command[0])}#${descriptor}`,
    };
  }
  const secretAlias = input['secretAlias'];
  if (typeof secretAlias !== 'string' || secretAlias.length === 0) return undefined;
  const url = input['url'];
  if (typeof url !== 'string') return undefined;
  try {
    const host = new URL(url).host;
    const auth = input['auth'];
    if (isRecord(auth) && auth['kind'] === 'jwt') {
      const descriptor = createHash('sha256')
        .update(
          canonicalJson({
            algorithm: auth['algorithm'] ?? null,
            audience: auth['audience'] ?? null,
            issuer: (auth['issuer'] ?? null) as unknown,
            keyId: (auth['keyId'] ?? null) as unknown,
            subject: (auth['subject'] ?? null) as unknown,
            scope: auth['scope'] ?? null,
            expiresInSeconds: auth['expiresInSeconds'] ?? BROKERED_JWT_DEFAULT_LIFETIME_SECONDS,
          }),
        )
        .digest('hex');
      return {
        secretAlias,
        secretAliases: [secretAlias],
        toolName,
        target: `${host}#jwt:${descriptor}`,
      };
    }
    return { secretAlias, secretAliases: [secretAlias], toolName, target: host };
  } catch {
    return undefined;
  }
}
