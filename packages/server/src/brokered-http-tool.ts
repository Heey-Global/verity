import {
  brokeredHttpRequestAliases,
  brokeredHttpRequestSchema,
  trustedCliRequestSchema,
} from '@verity/secret-contracts';

import {
  assertBrokeredDopplerBinding,
  brokeredDopplerSnapshot,
  type BrokeredDopplerBinding,
} from './brokered-doppler-binding.js';
import type { DopplerPerson } from './doppler-credential.js';
import {
  referencedBindings,
  resolveSecretReference,
  type ProjectDopplerBinding,
} from './doppler-secret-reference.js';
import {
  createRestrictedHttpJsonConnector,
  restrictedHttpJsonRequestSchema,
  type RestrictedHttpJsonTransport,
} from './restricted-http-json-connector.js';

/** One of the project's Doppler bindings (ADR 0031). */
export type BrokeredHttpProjectBinding = ProjectDopplerBinding;

/** Resolves one secret name inside one binding with the calling person's token. */
export type BrokeredSecretResolver = (input: {
  projectId: string;
  connectionId: string;
  dopplerProject: string;
  dopplerConfig: string;
  secretName: string;
  /** The calling turn; its person's Doppler connection resolves the secret. */
  person: DopplerPerson;
}) => Promise<Uint8Array>;

/** The bindings a call's references read from, as its approval is bound to them. */
export function referencedSnapshot(
  bindings: readonly ProjectDopplerBinding[],
  references: readonly string[],
): BrokeredDopplerBinding {
  return brokeredDopplerSnapshot(referencedBindings(bindings, references));
}

/** Every secret reference a secret tool request reads; a malformed request reads none
 *  and is refused, so it cannot be approved against an unknown binding. */
export function brokeredSecretReferences(
  toolName: 'verity_http_request' | 'verity_secret_run',
  request: unknown,
): readonly string[] {
  if (toolName === 'verity_http_request')
    return brokeredHttpRequestAliases(brokeredHttpRequestSchema.parse(request));
  return trustedCliRequestSchema.parse(request).secrets.map((entry) => entry.secretAlias);
}

/** Resolves a reference (`NAME` or `project/config/NAME`) against the bindings. */
export function resolveReferencedSecret(
  resolveSecret: BrokeredSecretResolver,
  bindings: readonly ProjectDopplerBinding[],
  input: { projectId: string; reference: string; person: DopplerPerson },
): Promise<Uint8Array> {
  const { binding, name } = resolveSecretReference(bindings, input.reference);
  return resolveSecret({
    projectId: input.projectId,
    connectionId: binding.connectionId,
    dopplerProject: binding.dopplerProject,
    dopplerConfig: binding.dopplerConfig,
    secretName: name,
    person: input.person,
  });
}

export type BrokeredToolCall = {
  id: string;
  consumptionId?: string;
  name: 'verity_http_request' | 'verity_secret_run';
  input: unknown;
  /** Trusted gateway authority; never read from tool arguments. */
  approvedBinding?: BrokeredDopplerBinding;
};

export type BrokeredHttpToolResult = {
  status: number;
  body: unknown;
  truncated?: boolean;
  note?: 'body withheld (undecodable)' | 'body withheld (truncated)';
};

/** Keep the complete encoded MCP result within the gateway response envelope. */
const MAX_RELAY_RESULT_BYTES = 32 * 1024;

function boundRelayResult(result: BrokeredHttpToolResult): BrokeredHttpToolResult {
  const serializedResult = JSON.stringify(result);
  if (
    serializedResult === undefined ||
    Buffer.byteLength(serializedResult, 'utf8') <= MAX_RELAY_RESULT_BYTES
  ) {
    return result;
  }
  // Never relay a partial body: a cut may expose an unredactable secret prefix.
  return {
    status: result.status,
    body: null,
    truncated: true,
    note: 'body withheld (truncated)',
  };
}

export function createBrokeredHttpTool(options: {
  requireApprovalBinding?: boolean;
  getProjectBindings: (projectId: string) => Promise<readonly ProjectDopplerBinding[]>;
  resolveSecret: BrokeredSecretResolver;
  consumeApproval: (input: {
    projectId: string;
    sessionId: string;
    turnId: string;
    callId: string;
    requestHash: string;
  }) => Promise<boolean>;
  transport: RestrictedHttpJsonTransport;
}) {
  return async (
    projectId: string,
    sessionId: string,
    turnId: string,
    call: BrokeredToolCall,
  ): Promise<BrokeredHttpToolResult> => {
    if (call.name !== 'verity_http_request') {
      throw new Error('invalid brokered HTTP tool call');
    }
    const request = restrictedHttpJsonRequestSchema.parse(call.input);
    if (options.requireApprovalBinding && call.approvedBinding === undefined)
      throw new Error('approved Doppler binding is required');
    const references = brokeredHttpRequestAliases(request);
    const current = async () =>
      referencedSnapshot(await options.getProjectBindings(projectId), references);
    const bindings = await options.getProjectBindings(projectId);
    const binding = referencedSnapshot(bindings, references);
    assertBrokeredDopplerBinding(binding, call.approvedBinding);
    const connector = createRestrictedHttpJsonConnector({
      profile: {
        id: 'project-http',
        projectId,
        secretPolicy: { mode: 'per-request-approval' },
        timeoutMs: 15_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 65_536,
      },
      resolveSecret: (reference) =>
        resolveReferencedSecret(options.resolveSecret, bindings, {
          projectId,
          reference,
          person: { sessionId, turnId },
        }),
      consumeApproval: async (requestHash) => {
        assertBrokeredDopplerBinding(await current(), binding);
        const consumed = await options.consumeApproval({
          projectId,
          sessionId,
          turnId,
          callId: call.consumptionId ?? call.id,
          requestHash,
        });
        assertBrokeredDopplerBinding(await current(), binding);
        return consumed;
      },
      transport: options.transport,
    });
    const result = await connector.execute(request);
    return boundRelayResult({
      status: result.status,
      body: result.body ?? null,
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(result.note === undefined ? {} : { note: result.note }),
    });
  };
}

// The CLI streaming entry point shares the HTTP secret broker transport policy.
export { createBrokeredForgeProxy } from './brokered-forge-proxy.js';
