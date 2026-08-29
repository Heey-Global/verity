import { z } from 'zod';
import {
  brokeredSecretsProtocolVersionSchema,
  positiveVersionSchema,
  secretContractIdSchema,
  secretInjectionSchema,
  sha256HexSchema,
} from './common.js';

export const providerKindSchema = z.literal('doppler');
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** Public, non-secret identity of a server-owned provider binding. */
export const providerBindingRefSchema = z
  .object({
    id: secretContractIdSchema,
    version: positiveVersionSchema,
    provider: providerKindSchema,
  })
  .strict();
export type ProviderBindingRef = z.infer<typeof providerBindingRefSchema>;

export const secretAliasRefSchema = z
  .object({ id: secretContractIdSchema, version: positiveVersionSchema })
  .strict();
export type SecretAliasRef = z.infer<typeof secretAliasRefSchema>;

export const executionProfileRefSchema = z
  .object({
    id: secretContractIdSchema,
    version: positiveVersionSchema,
    policyHash: sha256HexSchema,
  })
  .strict();
export type ExecutionProfileRef = z.infer<typeof executionProfileRefSchema>;

const resourceLimitsSchema = z
  .object({
    timeoutSeconds: z.number().int().positive().max(86_400),
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
  })
  .strict();

const profileBase = {
  id: secretContractIdSchema,
  projectId: secretContractIdSchema,
  version: positiveVersionSchema,
  policyHash: sha256HexSchema,
  state: z.enum(['draft', 'active', 'disabled']),
  limits: resourceLimitsSchema,
} as const;

export const executionProfileRecordSchema = z.discriminatedUnion('trustMode', [
  z
    .object({
      ...profileBase,
      trustMode: z.literal('trusted'),
      requiresApproval: z.literal(true),
      network: z.enum(['none', 'profile-allowlist', 'unrestricted']),
      opaqueArtifacts: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...profileBase,
      trustMode: z.literal('restricted'),
      requiresApproval: z.boolean(),
      imageDigest: sha256HexSchema,
      executablePath: z.string().startsWith('/').max(4096),
      executableDigest: sha256HexSchema,
      parameterSchemaHash: sha256HexSchema,
      snapshotPolicyHash: sha256HexSchema,
      egressPolicyHash: sha256HexSchema,
      resultSchemaHash: sha256HexSchema,
      allowDescendants: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...profileBase,
      trustMode: z.literal('action'),
      requiresApproval: z.boolean(),
      action: secretContractIdSchema,
      inputSchemaHash: sha256HexSchema,
      resultSchemaHash: sha256HexSchema,
    })
    .strict(),
]);
export type ExecutionProfileRecord = z.infer<typeof executionProfileRecordSchema>;

/** Agent-visible catalog item. Provider source, key path, and values are intentionally absent. */
const secretCatalogItemBase = {
  alias: secretAliasRefSchema,
  name: secretContractIdSchema,
  description: z.string().min(1).max(500),
  injection: secretInjectionSchema,
  profile: executionProfileRefSchema,
};

export const secretCatalogItemSchema = z.discriminatedUnion('trustMode', [
  z
    .object({
      ...secretCatalogItemBase,
      trustMode: z.literal('trusted'),
      requiresApproval: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...secretCatalogItemBase,
      trustMode: z.literal('restricted'),
      requiresApproval: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...secretCatalogItemBase,
      trustMode: z.literal('action'),
      requiresApproval: z.boolean(),
    })
    .strict(),
]);
export type SecretCatalogItem = z.infer<typeof secretCatalogItemSchema>;

export const secretCatalogResponseSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    catalogVersion: positiveVersionSchema,
    items: z.array(secretCatalogItemSchema).max(256),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const names = new Set<string>();
    for (const item of catalog.items) {
      if (names.has(item.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate secret alias name: ${item.name}` });
      }
      names.add(item.name);
    }
  });
export type SecretCatalogResponse = z.infer<typeof secretCatalogResponseSchema>;

/** Server-internal binding record. It carries a secret-store reference, never credential plaintext. */
export const providerBindingRecordSchema = z
  .object({
    id: secretContractIdSchema,
    projectId: secretContractIdSchema,
    version: positiveVersionSchema,
    provider: providerKindSchema,
    credentialRef: z
      .string()
      .min(1)
      .max(512)
      .regex(/^secretref:[A-Za-z0-9._:/-]+$/),
    dopplerProject: secretContractIdSchema,
    dopplerConfig: secretContractIdSchema,
    state: z.enum(['active', 'disabled', 'revocation_attention']),
  })
  .strict();
export type ProviderBindingRecord = z.infer<typeof providerBindingRecordSchema>;

/** Server-internal alias. `providerKey` is never exposed by the public catalog schema. */
export const secretAliasRecordSchema = z
  .object({
    id: secretContractIdSchema,
    projectId: secretContractIdSchema,
    version: positiveVersionSchema,
    name: secretContractIdSchema,
    description: z.string().min(1).max(500),
    binding: providerBindingRefSchema,
    providerKey: z.string().min(1).max(256),
    injection: secretInjectionSchema,
    profile: executionProfileRefSchema,
    state: z.enum(['active', 'disabled']),
  })
  .strict();
export type SecretAliasRecord = z.infer<typeof secretAliasRecordSchema>;
