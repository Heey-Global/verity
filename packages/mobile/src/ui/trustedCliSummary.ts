/**
 * What a trusted CLI approval card shows: which secrets go into which
 * environment variables, and the exact command they go to (ADR 0011 D4).
 *
 * One run may carry several secrets, and the card is the only place the operator
 * sees which. A summary that reads just the first entry, or falls back to a raw
 * JSON dump, turns "approve this invocation" into "approve something involving
 * secrets" — which is the one thing the card exists to prevent.
 *
 * Null when the input does not parse. The caller then shows the raw input rather
 * than a confident summary of a shape it did not understand.
 */
export type TrustedCliSecretSummary = {
  secretAlias: string;
  env: string;
  /** `file` means the variable holds a path Verity writes the value to. */
  injection: 'env' | 'file';
};

export type TrustedCliSummary = {
  secrets: TrustedCliSecretSummary[];
  command: string[];
  executable: string;
  entryScript: {
    path: string;
    projectPath: string;
    sha256: string;
    loading: 'isolated' | 'dynamic';
  } | null;
};

function parseSecret(raw: unknown): TrustedCliSecretSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !['secretAlias', 'env', 'injection'].includes(key))) {
    return null;
  }
  const secretAlias = typeof entry['secretAlias'] === 'string' ? entry['secretAlias'] : null;
  const env = typeof entry['env'] === 'string' ? entry['env'] : null;
  if (secretAlias === null || env === null || secretAlias.length === 0 || env.length === 0) {
    return null;
  }
  // Absent means `env`: the shape every caller used before file injection
  // existed. Anything else is unreadable rather than `env` — the difference
  // between a variable and a file Verity writes into the sandbox is the whole
  // point of the field, so guessing it would state the wrong one confidently.
  const injection = entry['injection'];
  if (injection !== undefined && injection !== 'env' && injection !== 'file') return null;
  return { secretAlias, env, injection: injection ?? 'env' };
}

export function trustedCliSummary(rawInput: unknown): TrustedCliSummary | null {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return null;
  const input = rawInput as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['secrets', 'command', 'entryScript'].includes(key))) {
    return null;
  }
  const rawSecrets = input['secrets'];
  if (!Array.isArray(rawSecrets) || rawSecrets.length === 0) return null;
  const secrets: TrustedCliSecretSummary[] = [];
  for (const raw of rawSecrets) {
    const secret = parseSecret(raw);
    // One unreadable entry means the card cannot claim to show the whole
    // invocation, so it shows none of it.
    if (secret === null) return null;
    secrets.push(secret);
  }
  const rawCommand = input['command'];
  if (!Array.isArray(rawCommand) || rawCommand.length === 0) return null;
  const command = rawCommand.filter((token): token is string => typeof token === 'string');
  if (command.length !== rawCommand.length) return null;
  const rawEntryScript = input['entryScript'];
  let entryScript: TrustedCliSummary['entryScript'] = null;
  if (rawEntryScript !== undefined) {
    if (
      typeof rawEntryScript !== 'object' ||
      rawEntryScript === null ||
      Array.isArray(rawEntryScript)
    )
      return null;
    const entry = rawEntryScript as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !['path', 'projectPath', 'sha256', 'loading'].includes(key))
    ) {
      return null;
    }
    if (
      typeof entry['path'] !== 'string' ||
      typeof entry['projectPath'] !== 'string' ||
      entry['projectPath']
        .split('/')
        .some((component) => component === '' || component === '.' || component === '..') ||
      typeof entry['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry['sha256']) ||
      (entry['loading'] !== undefined &&
        entry['loading'] !== 'isolated' &&
        entry['loading'] !== 'dynamic')
    )
      return null;
    entryScript = {
      path: entry['path'],
      projectPath: entry['projectPath'],
      sha256: entry['sha256'],
      loading: entry['loading'] ?? 'dynamic',
    };
  }
  return { secrets, command, executable: command[0]!, entryScript };
}

/** Headline fragment: the alias when there is one, a count when there are more. */
export function trustedCliSecretLabel(summary: TrustedCliSummary): string {
  return summary.secrets.length === 1
    ? summary.secrets[0]!.secretAlias
    : `${summary.secrets.length} secrets`;
}

/** `ASC_KEY_ID as ASC_KEY_ID, ASC_PRIVATE_KEY as a file at ASC_KEY_FILE` */
export function trustedCliInjectionSummary(summary: TrustedCliSummary): string {
  return summary.secrets
    .map((secret) =>
      secret.injection === 'file'
        ? `${secret.secretAlias} as a file at ${secret.env}`
        : `${secret.secretAlias} as ${secret.env}`,
    )
    .join(', ');
}
