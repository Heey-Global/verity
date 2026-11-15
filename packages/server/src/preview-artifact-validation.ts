import { OPENCODE_KNOWLEDGE_READ_PERMISSION } from './provisioner.js';

// What a preview may ship as an OpenCode gateway config: checked before the
// artifact is served, so a share cannot carry another person's provider settings.

export function validModelMetadata(value: object): boolean {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'name') {
      if (typeof child !== 'string') return false;
    } else if (['attachment', 'reasoning', 'temperature', 'tool_call'].includes(key)) {
      if (typeof child !== 'boolean') return false;
    } else if (key === 'limit' || key === 'cost') {
      if (typeof child !== 'object' || child === null || Array.isArray(child)) return false;
      const allowed =
        key === 'limit'
          ? ['input', 'output', 'context']
          : ['input', 'output', 'cache_read', 'cache_write'];
      if (
        !exactKeys(child, allowed) ||
        !Object.values(child).every(
          (number) => typeof number === 'number' && Number.isFinite(number) && number >= 0,
        )
      )
        return false;
    } else if (key === 'modalities') {
      if (
        typeof child !== 'object' ||
        child === null ||
        Array.isArray(child) ||
        !exactKeys(child, ['input', 'output'])
      )
        return false;
      if (
        !Object.values(child).every(
          (list) =>
            Array.isArray(list) &&
            list.every(
              (item: unknown) =>
                typeof item === 'string' &&
                ['text', 'audio', 'image', 'video', 'pdf'].includes(item),
            ),
        )
      )
        return false;
    } else return false;
  }
  return true;
}

export function validOpenCodeGatewayConfig(contents: string): boolean {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    if (
      !exactKeys(parsed, [
        '$schema',
        'autoupdate',
        'permission',
        'provider',
        'model',
        'small_model',
        'theme',
        'username',
        'logLevel',
      ])
    )
      return false;
    for (const key of ['model', 'small_model', 'theme', 'username', 'logLevel']) {
      const value = (parsed as Record<string, unknown>)[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' || !/^[a-zA-Z0-9._ /:-]+$/u.test(value))
      )
        return false;
    }
    const { $schema, autoupdate, permission, provider } = parsed as {
      $schema?: unknown;
      autoupdate?: unknown;
      permission?: unknown;
      provider?: unknown;
    };
    if ($schema !== 'https://opencode.ai/config.json' || autoupdate !== false) return false;
    if (permission !== undefined && !validKnowledgePermission(permission)) return false;
    // Provisioning also emits a credential-free config when no provider is selected.
    if (provider === undefined) return true;
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return false;
    if (!exactKeys(provider, ['verity'])) return false;
    const verity = (provider as { verity?: unknown }).verity;
    if (typeof verity !== 'object' || verity === null || Array.isArray(verity)) return false;
    if (!exactKeys(verity, ['npm', 'name', 'options', 'models'])) return false;
    const {
      npm,
      name,
      options: gateway,
      models,
    } = verity as {
      npm?: unknown;
      name?: unknown;
      options?: unknown;
      models?: unknown;
    };
    if (
      (npm !== '@opencode/ai/providers/openai-compatible' && npm !== '@ai-sdk/openai-compatible') ||
      name !== 'OpenAI-compatible'
    )
      return false;
    if (typeof gateway !== 'object' || gateway === null || Array.isArray(gateway)) return false;
    if (!exactKeys(gateway, ['baseURL', 'apiKey', 'timeout'])) return false;
    const timeout = (gateway as { timeout?: unknown }).timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0)
    )
      return false;
    const { baseURL, apiKey } = gateway as { baseURL?: unknown; apiKey?: unknown };
    if (
      typeof baseURL !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+\/opencode$/u.test(baseURL) ||
      apiKey !== 'verity-opencode-gateway-placeholder-v1'
    )
      return false;
    if (typeof models !== 'object' || models === null || Array.isArray(models)) return false;
    const entries = Object.values(models as Record<string, unknown>);
    return (
      entries.length > 0 &&
      entries.every((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        return (
          exactKeys(value, [
            'name',
            'limit',
            'cost',
            'modalities',
            'attachment',
            'reasoning',
            'temperature',
            'tool_call',
          ]) &&
          typeof (value as { name?: unknown }).name === 'string' &&
          validModelMetadata(value)
        );
      })
    );
  } catch {
    return false;
  }
}

export function exactKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validKnowledgePermission(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return (
    exactKeys(actual, Object.keys(OPENCODE_KNOWLEDGE_READ_PERMISSION)) &&
    Object.entries(OPENCODE_KNOWLEDGE_READ_PERMISSION).every(([key, expected]) => {
      const rule = actual[key];
      return (
        typeof rule === 'object' &&
        rule !== null &&
        !Array.isArray(rule) &&
        exactKeys(rule, Object.keys(expected)) &&
        Object.entries(expected).every(
          ([pattern, action]) => (rule as Record<string, unknown>)[pattern] === action,
        )
      );
    })
  );
}
