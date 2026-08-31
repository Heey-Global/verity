import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  phaseOneReadinessReportSchema,
  pilotBundleSchema,
  pilotMeasurementSchema,
  pilotSecurityGateSchema,
  readinessBudgetPreimage,
  restrictedPilotDefinitionPreimage,
  restrictedPilotDefinitionSchema,
  validatePilotBundleIdentity,
  validatePhaseOneReadinessReportIdentity,
  validateRestrictedPilotDefinitionIdentity,
} from './pilot.js';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const c = 'c'.repeat(64);
const sha256 = (value: string): string => (value.includes('changed.invalid') ? 'd'.repeat(64) : c);

/** Refusals as `["path","to","field"] message`, so assertions pin both. */
function refusals(outcome: z.ZodSafeParseResult<unknown>): string[] {
  expect(outcome.success).toBe(false);
  return outcome.success
    ? []
    : outcome.error.issues.map((issue) => `${JSON.stringify(issue.path)} ${issue.message}`);
}

const measurement = {
  pilotId: 'kubernetes-read',
  pilotDefinitionHash: a,
  backend: 'docker-gvisor',
  sampleCount: 30,
  coldStartP50Ms: 1_000,
  coldStartP95Ms: 2_000,
  latencyP50Ms: 100,
  latencyP95Ms: 200,
  cleanupP95Ms: 1_000,
  maximumOutputBytes: 65_536,
  costMicrousdP50: 500,
  maximumConcurrentProjectJobs: 2,
  maximumConcurrentExecutorJobs: 8,
  measuredAt: '2026-07-18T00:00:00Z',
  fixtureHash: a,
};

function pilot(kind: 'kubernetes-read' | 'fixed-json-api') {
  const method = kind === 'kubernetes-read' ? 'GET' : 'POST';
  const resultHash = kind === 'fixed-json-api' ? b : a;
  const base = {
    id: kind,
    version: 1 as const,
    definitionHash: a,
    projectId: 'fixture-project',
    profile: {
      id: `${kind}-profile`,
      projectId: 'fixture-project',
      version: 1,
      policyHash: a,
      state: 'active' as const,
      limits: {
        timeoutSeconds: 30,
        cpuMillis: 1000,
        memoryMiB: 128,
        maxProcesses: 1,
        maxOutputBytes: 65_536,
      },
      trustMode: 'restricted' as const,
      requiresApproval: true,
      imageDigest: a,
      executablePath: '/pilot',
      executableDigest: a,
      parameterSchemaHash: a,
      snapshotPolicyHash: a,
      egressPolicyHash: c,
      resultSchemaHash: resultHash,
      allowDescendants: false,
    },
    aliases: [{ id: `${kind}-credential`, version: 1 }],
    egress: {
      id: `${kind}-egress`,
      version: 1,
      policyHash: c,
      protocol: 'https-json' as const,
      destination: { hostname: 'fixture.invalid', port: 443 as const },
      tls: {
        serverName: 'fixture.invalid',
        minimumVersion: 'TLSv1.3' as const,
        spkiSha256: [a],
        allowSystemRoots: false as const,
        trustBundleHash: a,
        verification: 'pki-hostname-validity-and-spki' as const,
      },
      methods: [method],
      pathPrefixes: ['/v1/tenant'],
      allowedQueryKeys: [],
      allowedRequestHeaders: ['authorization'],
      immutableBindings:
        kind === 'kubernetes-read'
          ? [
              { location: 'path-segment' as const, segmentIndex: 0, valueHash: c },
              { location: 'path-segment' as const, segmentIndex: 1, valueHash: c },
            ]
          : [{ location: 'path-segment' as const, segmentIndex: 1, valueHash: a }],
      body:
        kind === 'fixed-json-api'
          ? { kind: 'json-schema' as const, schemaHash: a, maxBytes: 4096 }
          : { kind: 'none' as const },
      response: { maxBytes: 65_536, schemaHash: resultHash },
      redirects: 'deny' as const,
      dns: {
        searchDomains: false as const,
        pinForRequest: true as const,
        rejectPrivateAndMetadata: true as const,
        allowIpv6: false,
      },
      denyConnect: true as const,
      denyProtocolUpgrade: true as const,
      stripProxyEnvironment: true as const,
    },
    fixtureId: `${kind}-fixture`,
    abuseCases: ['egress-bypass', 'request-substitution'] as const,
  };
  return kind === 'kubernetes-read'
    ? {
        ...base,
        kind,
        operation: {
          clusterId: 'fixture-cluster',
          namespace: 'pilot-fixture',
          verbs: ['get', 'list'] as const,
          resources: ['pods', 'deployments'] as const,
          maximumItems: 100,
          clusterIdHash: c,
          namespaceHash: c,
          clusterPathSegmentIndex: 0,
          namespacePathSegmentIndex: 1,
          requestSchemaHash: a,
          responseSchemaHash: a,
        },
      }
    : {
        ...base,
        kind,
        operation: {
          operationId: 'fixture-status-read',
          method,
          tenantIdHash: a,
          tenantPathSegmentIndex: 1,
          requestSchemaHash: a,
          responseSchemaHash: b,
        },
      };
}

describe('W10 restricted pilot contracts', () => {
  it('requires exactly one distinct pilot of each kind', () => {
    const kubernetes = pilot('kubernetes-read');
    const api = pilot('fixed-json-api');
    expect(pilotBundleSchema.parse({ version: 1, pilots: [kubernetes, api] }).pilots).toHaveLength(
      2,
    );
    expect(() =>
      pilotBundleSchema.parse({ version: 1, pilots: [kubernetes, kubernetes] }),
    ).toThrow();
    const parsedKubernetes = restrictedPilotDefinitionSchema.parse(kubernetes);
    const parsedApi = restrictedPilotDefinitionSchema.parse(api);
    const bundle = {
      version: 1,
      pilots: [
        { ...parsedKubernetes, definitionHash: c },
        { ...parsedApi, definitionHash: c },
      ],
    } as const;
    expect(validatePilotBundleIdentity(bundle, sha256).pilots).toHaveLength(2);
  });

  it('binds the definition identity and profile policy hashes', () => {
    const input = restrictedPilotDefinitionSchema.parse(pilot('kubernetes-read'));
    const definitionHash = sha256(restrictedPilotDefinitionPreimage(input));
    expect(
      validateRestrictedPilotDefinitionIdentity({ ...input, definitionHash }, sha256)
        .definitionHash,
    ).toBe(definitionHash);
    expect(() =>
      validateRestrictedPilotDefinitionIdentity({ ...input, definitionHash: b }, sha256),
    ).toThrow(/mismatch/);
    expect(() => restrictedPilotDefinitionSchema.parse({ ...input, projectId: 'other' })).toThrow(
      /project mismatch/,
    );
    expect(() =>
      validateRestrictedPilotDefinitionIdentity(
        {
          ...input,
          egress: {
            ...input.egress,
            destination: { hostname: 'changed.invalid', port: 443 },
            tls: { ...input.egress.tls, serverName: 'changed.invalid' },
          },
        },
        sha256,
      ),
    ).toThrow(/policyHash mismatch/);
  });

  it('rejects method and result-schema widening', () => {
    const api = pilot('fixed-json-api');
    expect(() =>
      restrictedPilotDefinitionSchema.parse({
        ...api,
        egress: { ...api.egress, methods: ['GET'] },
      }),
    ).toThrow(/method/);
    expect(() =>
      restrictedPilotDefinitionSchema.parse({
        ...api,
        operation: { ...api.operation, responseSchemaHash: a },
      }),
    ).toThrow(/result schema/);
    expect(() =>
      restrictedPilotDefinitionSchema.parse({
        ...api,
        egress: { ...api.egress, response: { ...api.egress.response, schemaHash: a } },
      }),
    ).toThrow(/egress response schema/);
  });

  it('cannot report go without measurements and cleared blockers', () => {
    expect(() =>
      phaseOneReadinessReportSchema.parse({
        recommendation: 'go',
        approvedBudget: {
          version: 1,
          policyHash: a,
          maximumCostMicrousdP50: 1_000,
          minimumConcurrentProjectJobs: 2,
          minimumConcurrentExecutorJobs: 8,
        },
        pilotDefinitionHashes: [a, b],
        measurements: [],
        passedSecurityGates: [],
        blockers: [],
      }),
    ).toThrow(/evidence/);
    expect(
      phaseOneReadinessReportSchema.parse({
        recommendation: 'no-go',
        approvedBudget: {
          version: 1,
          policyHash: a,
          maximumCostMicrousdP50: 1_000,
          minimumConcurrentProjectJobs: 2,
          minimumConcurrentExecutorJobs: 8,
        },
        pilotDefinitionHashes: [a, b],
        measurements: [],
        passedSecurityGates: [],
        blockers: ['native-e2e-evidence-missing'],
      }).recommendation,
    ).toBe('no-go');
    const budget = {
      version: 1,
      policyHash: c,
      maximumCostMicrousdP50: 1_000,
      minimumConcurrentProjectJobs: 2 as const,
      minimumConcurrentExecutorJobs: 8 as const,
    };
    const report = {
      recommendation: 'no-go' as const,
      approvedBudget: budget,
      pilotDefinitionHashes: [a, b] as const,
      measurements: [],
      passedSecurityGates: [],
      blockers: ['native-e2e-evidence-missing'],
    };
    expect(readinessBudgetPreimage(budget)).toContain('maximumCostMicrousdP50');
    expect(validatePhaseOneReadinessReportIdentity(report, sha256).recommendation).toBe('no-go');
    expect(() =>
      validatePhaseOneReadinessReportIdentity(
        {
          ...report,
          approvedBudget: { ...budget, maximumCostMicrousdP50: 2_000 },
        },
        (value) => (value.includes('2000') ? 'd'.repeat(64) : c),
      ),
    ).toThrow(/policyHash mismatch/);
  });

  it('refuses pilots whose profile is inactive or unbound from the egress policy', () => {
    const kubernetes = pilot('kubernetes-read');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          profile: { ...kubernetes.profile, state: 'draft' },
        }),
      ),
    ).toContain('["profile","state"] pilot profile must be active');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          profile: { ...kubernetes.profile, egressPolicyHash: b },
        }),
      ),
    ).toContain('["egress"] egress policy hash mismatch');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          aliases: [
            { id: 'shared-credential', version: 1 },
            { id: 'shared-credential', version: 1 },
          ],
        }),
      ),
    ).toContain('["aliases"] aliases must be unique');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          abuseCases: ['cancel-race', 'cancel-race'],
        }),
      ),
    ).toContain('["abuseCases"] abuse cases must be unique');
  });

  it('pins the Kubernetes pilot to bound cluster, namespace, schemas, and a bodiless GET', () => {
    const kubernetes = pilot('kubernetes-read');
    const unbound = '["egress","immutableBindings"] cluster and namespace must be immutably bound';
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          operation: { ...kubernetes.operation, clusterIdHash: b },
        }),
      ),
    ).toContain(unbound);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          operation: { ...kubernetes.operation, namespaceHash: b },
        }),
      ),
    ).toContain(unbound);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          operation: { ...kubernetes.operation, requestSchemaHash: b },
        }),
      ),
    ).toContain('["operation","requestSchemaHash"] request schema mismatch');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          operation: { ...kubernetes.operation, responseSchemaHash: b },
        }),
      ),
    ).toContain('["operation","responseSchemaHash"] result schema mismatch');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          egress: {
            ...kubernetes.egress,
            response: { ...kubernetes.egress.response, schemaHash: b },
          },
        }),
      ),
    ).toContain('["egress","response","schemaHash"] egress response schema mismatch');
    const readOnly = '["egress"] Kubernetes read requires exact GET without body';
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          egress: { ...kubernetes.egress, methods: ['POST'] },
        }),
      ),
    ).toContain(readOnly);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          egress: { ...kubernetes.egress, methods: ['GET', 'POST'] },
        }),
      ),
    ).toContain(readOnly);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...kubernetes,
          egress: {
            ...kubernetes.egress,
            body: { kind: 'json-schema', schemaHash: a, maxBytes: 4096 },
          },
        }),
      ),
    ).toContain(readOnly);
  });

  it('pins the API pilot to bound request body and tenant path segment', () => {
    const api = pilot('fixed-json-api');
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...api,
          operation: { ...api.operation, requestSchemaHash: b },
        }),
      ),
    ).toContain('["operation","requestSchemaHash"] request schema mismatch');
    const bodyMismatch = '["egress","body"] API body schema mismatch';
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...api,
          egress: { ...api.egress, body: { kind: 'json-schema', schemaHash: b, maxBytes: 4096 } },
        }),
      ),
    ).toContain(bodyMismatch);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...api,
          egress: { ...api.egress, body: { kind: 'none' } },
        }),
      ),
    ).toContain(bodyMismatch);
    expect(
      refusals(
        restrictedPilotDefinitionSchema.safeParse({
          ...api,
          operation: { ...api.operation, tenantIdHash: b },
        }),
      ),
    ).toContain('["egress","immutableBindings"] tenant must be immutably path-bound');
  });

  it('binds the Kubernetes operation hashes to the cluster and namespace names', () => {
    const input = restrictedPilotDefinitionSchema.parse(pilot('kubernetes-read'));
    expect(() =>
      validateRestrictedPilotDefinitionIdentity(input, (value) =>
        value.startsWith('verity.pilot.cluster-id.v1\0') ? b : c,
      ),
    ).toThrow('Kubernetes operation identity mismatch');
    expect(() =>
      validateRestrictedPilotDefinitionIdentity(input, (value) =>
        value.startsWith('verity.pilot.namespace.v1\0') ? b : c,
      ),
    ).toThrow('Kubernetes operation identity mismatch');
  });

  it('rejects measurements that invert percentiles or miss the W5 SLO gate', () => {
    expect(pilotMeasurementSchema.parse(measurement).sampleCount).toBe(30);
    const inverted = '[] p50 must not exceed p95';
    expect(
      refusals(
        pilotMeasurementSchema.safeParse({
          ...measurement,
          coldStartP50Ms: 3_000,
          coldStartP95Ms: 2_000,
        }),
      ),
    ).toContain(inverted);
    expect(
      refusals(
        pilotMeasurementSchema.safeParse({ ...measurement, latencyP50Ms: 300, latencyP95Ms: 200 }),
      ),
    ).toContain(inverted);
    const overGate = '[] measurement exceeds W5 SLO gate';
    expect(
      refusals(pilotMeasurementSchema.safeParse({ ...measurement, coldStartP95Ms: 5_001 })),
    ).toContain(overGate);
    expect(
      refusals(pilotMeasurementSchema.safeParse({ ...measurement, cleanupP95Ms: 30_001 })),
    ).toContain(overGate);
    // Kubernetes gets the wider budget for the same numbers.
    expect(
      pilotMeasurementSchema.parse({
        ...measurement,
        backend: 'kubernetes-gvisor',
        coldStartP95Ms: 5_001,
        cleanupP95Ms: 30_001,
      }).backend,
    ).toBe('kubernetes-gvisor');
    expect(
      refusals(
        pilotMeasurementSchema.safeParse({
          ...measurement,
          backend: 'kubernetes-gvisor',
          coldStartP95Ms: 15_001,
        }),
      ),
    ).toContain(overGate);
    expect(
      refusals(
        pilotMeasurementSchema.safeParse({
          ...measurement,
          backend: 'kubernetes-gvisor',
          cleanupP95Ms: 60_001,
        }),
      ),
    ).toContain(overGate);
  });

  it('accepts go only with complete, budget-bound pilot evidence', () => {
    const kubernetes = { ...measurement, pilotId: 'kubernetes-read', pilotDefinitionHash: a };
    const api = { ...measurement, pilotId: 'fixed-json-api', pilotDefinitionHash: b };
    const report = {
      recommendation: 'go',
      approvedBudget: {
        version: 1,
        policyHash: a,
        maximumCostMicrousdP50: 1_000,
        minimumConcurrentProjectJobs: 2,
        minimumConcurrentExecutorJobs: 8,
      },
      pilotDefinitionHashes: [a, b],
      measurements: [kubernetes, api],
      passedSecurityGates: [...pilotSecurityGateSchema.options],
      blockers: [] as string[],
    };
    expect(phaseOneReadinessReportSchema.parse(report).recommendation).toBe('go');
    const incomplete = '[] go requires bound pilot evidence, every security gate, and no blockers';
    const parse = (overrides: Record<string, unknown>): string[] =>
      refusals(phaseOneReadinessReportSchema.safeParse({ ...report, ...overrides }));
    expect(parse({ measurements: [kubernetes] })).toContain(incomplete);
    expect(parse({ measurements: [kubernetes, { ...api, pilotDefinitionHash: a }] })).toContain(
      incomplete,
    );
    expect(parse({ measurements: [kubernetes, { ...api, pilotId: 'kubernetes-read' }] })).toContain(
      incomplete,
    );
    expect(
      parse({
        pilotDefinitionHashes: [a, c],
        measurements: [kubernetes, { ...api, pilotDefinitionHash: b }],
      }),
    ).toContain(incomplete);
    expect(parse({ passedSecurityGates: pilotSecurityGateSchema.options.slice(1) })).toContain(
      incomplete,
    );
    expect(parse({ measurements: [{ ...kubernetes, costMicrousdP50: 1_001 }, api] })).toContain(
      incomplete,
    );
    expect(
      parse({ measurements: [{ ...kubernetes, maximumConcurrentProjectJobs: 1 }, api] }),
    ).toContain(incomplete);
    expect(
      parse({ measurements: [{ ...kubernetes, maximumConcurrentExecutorJobs: 7 }, api] }),
    ).toContain(incomplete);
    expect(parse({ blockers: ['still-open'] })).toContain(incomplete);
    expect(parse({ pilotDefinitionHashes: [a, a] })).toContain('[] pilot hashes must be distinct');
    expect(parse({ recommendation: 'no-go' })).toContain('[] no-go requires at least one blocker');
  });
});
