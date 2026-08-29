import {
  createRestrictedHttpJsonConnector,
  restrictedHttpJsonRequestSchema,
  type RestrictedHttpJsonTransport,
} from './restricted-http-json-connector.js';

export type BrokeredHttpProjectBinding = {
  dopplerProject: string;
  dopplerConfig: string;
};

export type BrokeredToolCall = {
  id: string;
  name: 'verity_http_request' | 'verity_secret_run';
  input: unknown;
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
  getProjectBinding: (projectId: string) => Promise<BrokeredHttpProjectBinding | undefined>;
  resolveSecret: (input: {
    projectId: string;
    dopplerProject: string;
    dopplerConfig: string;
    secretName: string;
  }) => Promise<Uint8Array>;
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
    const binding = await options.getProjectBinding(projectId);
    if (binding === undefined) throw new Error('project Doppler binding is unavailable');
    const connector = createRestrictedHttpJsonConnector({
      profile: {
        id: 'project-http',
        projectId,
        secretPolicy: { mode: 'per-request-approval' },
        timeoutMs: 15_000,
        maxRequestBytes: 65_536,
        maxResponseBytes: 65_536,
      },
      resolveSecret: (secretName) =>
        options.resolveSecret({
          projectId,
          dopplerProject: binding.dopplerProject,
          dopplerConfig: binding.dopplerConfig,
          secretName,
        }),
      consumeApproval: (requestHash) =>
        options.consumeApproval({
          projectId,
          sessionId,
          turnId,
          callId: call.id,
          requestHash,
        }),
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
