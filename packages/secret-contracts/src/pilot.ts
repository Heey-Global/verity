import { z } from 'zod';
import { canonicalJson, secretContractIdSchema, sha256HexSchema } from './common.js';
import { executionProfileRecordSchema, secretAliasRefSchema } from './catalog.js';
import { restrictedHttpEgressPolicySchema, validateEgressPolicyIdentity } from './egress.js';

export const pilotSecurityGateSchema = z.enum([
  'grant-replay',
  'request-substitution',
  'duplicate-redemption',
  'restart-replay',
  'cancel-race',
  'raw-secret-leakage',
  'sibling-isolation',
  'metadata-isolation',
  'egress-bypass',
  'resource-exhaustion',
  'cleanup-chaos',
]);
export type PilotSecurityGate = z.infer<typeof pilotSecurityGateSchema>;

const REQUIRED_SECURITY_GATES = pilotSecurityGateSchema.options;

const restrictedProfileSchema = executionProfileRecordSchema.refine(
  (profile) => profile.trustMode === 'restricted',
  'pilot profile must be restricted',
);

const pilotBase = {
  id: secretContractIdSchema,
  version: z.literal(1),
  definitionHash: sha256HexSchema,
  projectId: secretContractIdSchema,
  profile: restrictedProfileSchema,
  aliases: z.array(secretAliasRefSchema).min(1).max(4),
  egress: restrictedHttpEgressPolicySchema,
  fixtureId: secretContractIdSchema,
  abuseCases: z.array(pilotSecurityGateSchema).min(1).max(REQUIRED_SECURITY_GATES.length),
} as const;

export const restrictedPilotDefinitionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...pilotBase,
        kind: z.literal('kubernetes-read'),
        operation: z
          .object({
            clusterId: secretContractIdSchema,
            namespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
            verbs: z.tuple([z.literal('get'), z.literal('list')]),
            resources: z.tuple([z.literal('pods'), z.literal('deployments')]),
            maximumItems: z.number().int().positive().max(500),
            clusterIdHash: sha256HexSchema,
            namespaceHash: sha256HexSchema,
            clusterPathSegmentIndex: z.number().int().nonnegative().max(63),
            namespacePathSegmentIndex: z.number().int().nonnegative().max(63),
            requestSchemaHash: sha256HexSchema,
            responseSchemaHash: sha256HexSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...pilotBase,
        kind: z.literal('fixed-json-api'),
        operation: z
          .object({
            operationId: secretContractIdSchema,
            method: z.literal('POST'),
            tenantIdHash: sha256HexSchema,
            tenantPathSegmentIndex: z.number().int().nonnegative().max(63),
            requestSchemaHash: sha256HexSchema,
            responseSchemaHash: sha256HexSchema,
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((pilot, ctx) => {
    const profile = pilot.profile;
    if (profile.projectId !== pilot.projectId) {
      ctx.addIssue({ code: 'custom', path: ['profile', 'projectId'], message: 'project mismatch' });
    }
    if (profile.state !== 'active') {
      ctx.addIssue({
        code: 'custom',
        path: ['profile', 'state'],
        message: 'pilot profile must be active',
      });
    }
    if (profile.egressPolicyHash !== pilot.egress.policyHash) {
      ctx.addIssue({ code: 'custom', path: ['egress'], message: 'egress policy hash mismatch' });
    }
    if (pilot.kind === 'kubernetes-read') {
      const pathBindings = pilot.egress.immutableBindings.filter(
        (binding) => binding.location === 'path-segment',
      );
      if (
        !pathBindings.some(
          (binding) =>
            binding.segmentIndex === pilot.operation.clusterPathSegmentIndex &&
            binding.valueHash === pilot.operation.clusterIdHash,
        ) ||
        !pathBindings.some(
          (binding) =>
            binding.segmentIndex === pilot.operation.namespacePathSegmentIndex &&
            binding.valueHash === pilot.operation.namespaceHash,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress', 'immutableBindings'],
          message: 'cluster and namespace must be immutably bound',
        });
      }
      if (profile.parameterSchemaHash !== pilot.operation.requestSchemaHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['operation', 'requestSchemaHash'],
          message: 'request schema mismatch',
        });
      }
      if (profile.resultSchemaHash !== pilot.operation.responseSchemaHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['operation', 'responseSchemaHash'],
          message: 'result schema mismatch',
        });
      }
      if (pilot.egress.response.schemaHash !== pilot.operation.responseSchemaHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress', 'response', 'schemaHash'],
          message: 'egress response schema mismatch',
        });
      }
      if (
        pilot.egress.methods.length !== 1 ||
        pilot.egress.methods[0] !== 'GET' ||
        pilot.egress.body.kind !== 'none'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress'],
          message: 'Kubernetes read requires exact GET without body',
        });
      }
    }
    if (
      pilot.kind === 'fixed-json-api' &&
      (pilot.egress.methods.length !== 1 || pilot.egress.methods[0] !== pilot.operation.method)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['egress', 'methods'],
        message: 'API method must be exact',
      });
    }
    if (
      pilot.kind === 'fixed-json-api' &&
      profile.resultSchemaHash !== pilot.operation.responseSchemaHash
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['operation', 'responseSchemaHash'],
        message: 'result schema mismatch',
      });
    }
    if (pilot.kind === 'fixed-json-api') {
      if (profile.parameterSchemaHash !== pilot.operation.requestSchemaHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['operation', 'requestSchemaHash'],
          message: 'request schema mismatch',
        });
      }
      if (
        pilot.egress.body.kind !== 'json-schema' ||
        pilot.egress.body.schemaHash !== pilot.operation.requestSchemaHash
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress', 'body'],
          message: 'API body schema mismatch',
        });
      }
      if (pilot.egress.response.schemaHash !== pilot.operation.responseSchemaHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress', 'response', 'schemaHash'],
          message: 'egress response schema mismatch',
        });
      }
      if (
        !pilot.egress.immutableBindings.some(
          (binding) =>
            binding.location === 'path-segment' &&
            binding.segmentIndex === pilot.operation.tenantPathSegmentIndex &&
            binding.valueHash === pilot.operation.tenantIdHash,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['egress', 'immutableBindings'],
          message: 'tenant must be immutably path-bound',
        });
      }
    }
    if (
      new Set(pilot.aliases.map((alias) => `${alias.id}:${alias.version}`)).size !==
      pilot.aliases.length
    ) {
      ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'aliases must be unique' });
    }
    if (new Set(pilot.abuseCases).size !== pilot.abuseCases.length) {
      ctx.addIssue({ code: 'custom', path: ['abuseCases'], message: 'abuse cases must be unique' });
    }
  });
export type RestrictedPilotDefinition = z.infer<typeof restrictedPilotDefinitionSchema>;

export function restrictedPilotDefinitionPreimage(pilot: RestrictedPilotDefinition): string {
  const { definitionHash: _definitionHash, ...definition } = pilot;
  void _definitionHash;
  return 'verity.restricted-pilot.v1\0' + canonicalJson(definition);
}

export function validateRestrictedPilotDefinitionIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): RestrictedPilotDefinition {
  const pilot = restrictedPilotDefinitionSchema.parse(input);
  validateEgressPolicyIdentity(pilot.egress, sha256);
  if (
    pilot.kind === 'kubernetes-read' &&
    (sha256(`verity.pilot.cluster-id.v1\0${pilot.operation.clusterId}`) !==
      pilot.operation.clusterIdHash ||
      sha256(`verity.pilot.namespace.v1\0${pilot.operation.namespace}`) !==
        pilot.operation.namespaceHash)
  ) {
    throw new Error('Kubernetes operation identity mismatch');
  }
  if (sha256(restrictedPilotDefinitionPreimage(pilot)) !== pilot.definitionHash) {
    throw new Error('definitionHash mismatch');
  }
  return pilot;
}

export const pilotBundleSchema = z
  .object({
    version: z.literal(1),
    pilots: z.tuple([restrictedPilotDefinitionSchema, restrictedPilotDefinitionSchema]),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const kinds = new Set(bundle.pilots.map((pilot) => pilot.kind));
    if (kinds.size !== 2)
      ctx.addIssue({
        code: 'custom',
        path: ['pilots'],
        message: 'exactly one pilot of each kind is required',
      });
    if (new Set(bundle.pilots.map((pilot) => pilot.profile.id)).size !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['pilots'],
        message: 'pilot profiles must be distinct',
      });
    }
  });
export type PilotBundle = z.infer<typeof pilotBundleSchema>;

export function validatePilotBundleIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): PilotBundle {
  const bundle = pilotBundleSchema.parse(input);
  for (const pilot of bundle.pilots) validateRestrictedPilotDefinitionIdentity(pilot, sha256);
  return bundle;
}

export const pilotMeasurementSchema = z
  .object({
    pilotId: secretContractIdSchema,
    pilotDefinitionHash: sha256HexSchema,
    backend: z.enum(['docker-gvisor', 'kubernetes-gvisor']),
    sampleCount: z.number().int().min(30),
    coldStartP50Ms: z.number().int().nonnegative(),
    coldStartP95Ms: z.number().int().nonnegative(),
    latencyP50Ms: z.number().int().nonnegative(),
    latencyP95Ms: z.number().int().nonnegative(),
    cleanupP95Ms: z.number().int().nonnegative(),
    maximumOutputBytes: z.number().int().nonnegative(),
    costMicrousdP50: z.number().int().nonnegative(),
    maximumConcurrentProjectJobs: z.number().int().positive(),
    maximumConcurrentExecutorJobs: z.number().int().positive(),
    measuredAt: z.string().datetime({ offset: false }),
    fixtureHash: sha256HexSchema,
  })
  .strict()
  .superRefine((measurement, ctx) => {
    if (
      measurement.coldStartP50Ms > measurement.coldStartP95Ms ||
      measurement.latencyP50Ms > measurement.latencyP95Ms
    ) {
      ctx.addIssue({ code: 'custom', message: 'p50 must not exceed p95' });
    }
    const coldStartLimit = measurement.backend === 'docker-gvisor' ? 5_000 : 15_000;
    const cleanupLimit = measurement.backend === 'docker-gvisor' ? 30_000 : 60_000;
    if (measurement.coldStartP95Ms > coldStartLimit || measurement.cleanupP95Ms > cleanupLimit) {
      ctx.addIssue({ code: 'custom', message: 'measurement exceeds W5 SLO gate' });
    }
  });
export type PilotMeasurement = z.infer<typeof pilotMeasurementSchema>;

const readinessBudgetSchema = z
  .object({
    version: z.number().int().positive(),
    policyHash: sha256HexSchema,
    maximumCostMicrousdP50: z.number().int().nonnegative(),
    minimumConcurrentProjectJobs: z.literal(2),
    minimumConcurrentExecutorJobs: z.literal(8),
  })
  .strict();
export type ReadinessBudget = z.infer<typeof readinessBudgetSchema>;

export function readinessBudgetPreimage(budget: ReadinessBudget): string {
  const { policyHash: _policyHash, ...terms } = budget;
  void _policyHash;
  return 'verity.pilot-readiness-budget.v1\0' + canonicalJson(terms);
}

export const phaseOneReadinessReportSchema = z
  .object({
    recommendation: z.enum(['go', 'no-go']),
    approvedBudget: readinessBudgetSchema,
    pilotDefinitionHashes: z.tuple([sha256HexSchema, sha256HexSchema]),
    measurements: z.array(pilotMeasurementSchema).max(2),
    passedSecurityGates: z.array(pilotSecurityGateSchema).max(REQUIRED_SECURITY_GATES.length),
    blockers: z.array(secretContractIdSchema).max(64),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (new Set(report.pilotDefinitionHashes).size !== 2)
      ctx.addIssue({ code: 'custom', message: 'pilot hashes must be distinct' });
    if (report.recommendation === 'go') {
      const measuredHashes = new Set(
        report.measurements.map((measurement) => measurement.pilotDefinitionHash),
      );
      const measuredPilots = new Set(report.measurements.map((measurement) => measurement.pilotId));
      const passedGates = new Set(report.passedSecurityGates);
      if (
        report.measurements.length !== 2 ||
        measuredHashes.size !== 2 ||
        measuredPilots.size !== 2 ||
        report.pilotDefinitionHashes.some((hash) => !measuredHashes.has(hash)) ||
        REQUIRED_SECURITY_GATES.some((gate) => !passedGates.has(gate)) ||
        report.measurements.some(
          (measurement) =>
            measurement.costMicrousdP50 > report.approvedBudget.maximumCostMicrousdP50 ||
            measurement.maximumConcurrentProjectJobs <
              report.approvedBudget.minimumConcurrentProjectJobs ||
            measurement.maximumConcurrentExecutorJobs <
              report.approvedBudget.minimumConcurrentExecutorJobs,
        ) ||
        report.blockers.length !== 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'go requires bound pilot evidence, every security gate, and no blockers',
        });
      }
    }
    if (report.recommendation === 'no-go' && report.blockers.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'no-go requires at least one blocker' });
    }
  });
export type PhaseOneReadinessReport = z.infer<typeof phaseOneReadinessReportSchema>;

export function validatePhaseOneReadinessReportIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): PhaseOneReadinessReport {
  const report = phaseOneReadinessReportSchema.parse(input);
  if (sha256(readinessBudgetPreimage(report.approvedBudget)) !== report.approvedBudget.policyHash) {
    throw new Error('approved budget policyHash mismatch');
  }
  return report;
}
