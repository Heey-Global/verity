import {
  canonicalJson,
  executionProfileRefSchema,
  executionProfileRecordSchema,
  type ExecutionProfileRecord,
  type ExecutionProfileRef,
} from '@verity/secret-contracts';

export type SecretExecutionProfileParameterValidator = (
  parameters: Readonly<Record<string, unknown>>,
) => boolean | Promise<boolean>;

export type SecretExecutionProfilePolicy = ExecutionProfileRecord extends infer Profile
  ? Profile extends ExecutionProfileRecord
    ? Omit<Profile, 'projectId' | 'state'>
    : never
  : never;

export type SecretExecutionProfileAdapter = {
  policy: SecretExecutionProfilePolicy;
  validateParameters: SecretExecutionProfileParameterValidator;
};

export interface SecretExecutionProfileAdapterRegistry {
  validate(
    profile: ExecutionProfileRecord,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
}

function key(profile: ExecutionProfileRef): string {
  return `${profile.id}\0${String(profile.version)}\0${profile.policyHash}`;
}

function policyFromRecord(profile: ExecutionProfileRecord): SecretExecutionProfilePolicy {
  const policy = { ...profile };
  Reflect.deleteProperty(policy, 'projectId');
  Reflect.deleteProperty(policy, 'state');
  return policy;
}

/**
 * Verity-owned executable-policy registry. Durable records select a policy but cannot supply
 * validation logic. Unknown, duplicate, malformed, or throwing adapters fail closed.
 */
export function createSecretExecutionProfileAdapterRegistry(
  adapters: readonly SecretExecutionProfileAdapter[],
): SecretExecutionProfileAdapterRegistry {
  const registered = new Map<
    string,
    {
      policyJson: string;
      validateParameters: SecretExecutionProfileParameterValidator;
    }
  >();
  for (const adapter of adapters) {
    const profile = executionProfileRefSchema.parse({
      id: adapter.policy.id,
      version: adapter.policy.version,
      policyHash: adapter.policy.policyHash,
    });
    const normalizedPolicy = policyFromRecord(
      executionProfileRecordSchema.parse({
        ...adapter.policy,
        projectId: 'adapter-validation',
        state: 'active',
      }),
    );
    const adapterKey = key(profile);
    if (registered.has(adapterKey)) {
      throw new Error('duplicate secret execution profile adapter');
    }
    registered.set(adapterKey, {
      policyJson: canonicalJson(normalizedPolicy),
      validateParameters: adapter.validateParameters,
    });
  }

  return {
    async validate(profile, parameters) {
      if (profile.trustMode !== 'restricted' || profile.state !== 'active') return false;
      const adapter = registered.get(key(profile));
      if (
        adapter === undefined ||
        adapter.policyJson !== canonicalJson(policyFromRecord(profile))
      ) {
        return false;
      }
      try {
        return (await adapter.validateParameters(parameters)) === true;
      } catch {
        return false;
      }
    },
  };
}
