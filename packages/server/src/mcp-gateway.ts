import { randomUUID } from 'node:crypto';

import {
  brokeredHttpRequestSchema,
  trustedCliRequestSchema,
  BROKERED_HTTP_TOOL_DESCRIPTION,
  TRUSTED_CLI_TOOL_DESCRIPTION,
  gatewayToolNameSchema,
  type GatewayCallDecision,
  type GatewayCallRejection,
  type GatewayToolName,
} from '@verity/secret-contracts';
import {
  CREATE_DELIVERY_TOOL_DESCRIPTION,
  LIST_SESSIONS_TOOL_DESCRIPTION,
  SESSION_HANDOFF_TOOL_DESCRIPTION,
  createDeliveryRequestSchema,
  listSessionsRequestSchema,
  sessionHandoffRequestSchema,
} from '@verity/events';
import {
  TrustedCliDispatchError,
  trustedCliDispatchMessage,
  type ExternalPermissionAnswer,
} from '@verity/session';
import { z } from 'zod';

import type { McpGatewayCaller } from './mcp-gateway-tokens.js';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

const DOPPLER_RESOLUTION_PHASES = new Set([
  'project configuration',
  'secret alias',
  'Doppler authentication',
  'Doppler request start',
  'Doppler request timeout',
  'Doppler response status',
  'Doppler response format',
]);
const SAFE_PROJECT_CONFIGURATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}@v[1-9]\d{0,15}$/u;

function dopplerResolutionMessage(error: DopplerSecretResolutionError): string | undefined {
  if (error.phase === undefined || !DOPPLER_RESOLUTION_PHASES.has(error.phase)) return undefined;
  if (
    error.httpStatus !== undefined &&
    (!Number.isInteger(error.httpStatus) || error.httpStatus < 100 || error.httpStatus > 599)
  )
    return undefined;
  if (
    error.projectConfiguration !== undefined &&
    !SAFE_PROJECT_CONFIGURATION.test(error.projectConfiguration)
  )
    return undefined;
  const status = error.httpStatus === undefined ? '' : ` (HTTP ${String(error.httpStatus)})`;
  const configuration =
    error.projectConfiguration === undefined
      ? ''
      : `, project configuration \`${error.projectConfiguration}\``;
  return `Secret resolution failed during ${error.phase}${status}${configuration}. No secret value was exposed.`;
}

/**
 * The loopback MCP gateway: the brokered secret tools, served over HTTP to an ACP session
 * (ADR 0014 D1).
 *
 * A Claude/Codex session reaches these tools on its own native relay, where the server sees
 * the model emit the call and can bind the approval to it. An ACP session has no such relay
 * — neither installed adapter carries MCP over ACP — so the tools are offered as an MCP
 * server the agent connects to over the internal network instead. That transport is the
 * whole reason this module is careful:
 *
 * - **Every call is approval-gated, and no configuration waives it** (D2). The gateway holds
 *   the request until the operator answers a card or a standing grant covers it. There is no
 *   allowlist, no trusted-caller mode, no bypass parameter.
 * - **The gateway never claims the model made the call** (D4/D5). Anything in the workspace
 *   holding the endpoint and its token produces a byte-identical request, so the card states
 *   the server-side parameters and attributes nothing.
 * - **Every `tools/call` leaves an audit record** (D3), written before the secret resolves
 *   and again for the outcome. It is the only trace of a call that never appears in the
 *   session transcript, which by construction is where a stolen-endpoint call is absent.
 *
 * This module is transport-free: it takes a parsed body plus the identity the connection
 * already proved, and returns a status and a body. Mounting it, minting session tokens and
 * binding the ports live with the route.
 */

/** MCP revisions this gateway speaks, newest first. */
export const MCP_GATEWAY_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const MCP_GATEWAY_SERVER_NAME = 'verity-secret-gateway';

/** How long an unanswered card may hold one call open before the caller is denied. Long
 *  enough that an operator who stepped away can still answer, short enough that an
 *  abandoned request does not pin a connection for the session's life. */
export const MCP_GATEWAY_APPROVAL_TIMEOUT_MS = 5 * 60_000;

const JSON_RPC_VERSION = '2.0';
const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;

/** Told to the agent when the call could not be keyed, and so was neither recorded nor made. */
const UNRECORDED_CALL_MESSAGE = 'Verity could not record this call, so it was not made.';

/** JSON-RPC ids are echoed verbatim; a notification has none. Batches are not accepted —
 *  the 2025-06-18 revision removed them, and one call per request keeps every audit record
 *  attributable to one HTTP request. */
const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const toolCallParamsSchema = z
  .object({
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export interface McpGatewayResponse {
  status: number;
  /** Absent for a notification, which is acknowledged with an empty 202. */
  body?: unknown;
}

/** One `tools/call` the gateway is about to serve, in the form the audit record keys. */
export interface McpGatewayAuditRecord {
  projectId: string;
  kind: 'gateway_call_received' | 'gateway_call_served' | 'gateway_call_rejected';
  channel: 'acp-mcp';
  /** The gateway's own id for this call, shared by every record it produces. Two identical
   *  concurrent calls key to the same MAC, so this is what pairs a `received` with the
   *  outcome that belongs to it. */
  callId: string;
  toolName?: GatewayToolName;
  requestMac?: string;
  macKeyId?: string;
  decision?: GatewayCallDecision;
  rejection?: GatewayCallRejection;
}

export interface McpGatewayDeps {
  /**
   * Resolve a presented bearer to the session it was minted for, within the project the
   * connection already proved. Returns undefined for an unknown, expired or foreign-project
   * token — the gateway never distinguishes those to the caller.
   */
  resolveCaller(input: { projectId: string; token: string }): Promise<McpGatewayCaller | undefined>;
  /**
   * Raise the approval card and wait for the answer (ADR 0014 D2). Must fail safe to deny
   * when `signal` aborts. A rejection means the card could not be raised at all, which the
   * gateway reports as `unavailable` rather than serving the call.
   */
  requestApproval(input: {
    projectId: string;
    sessionId: string;
    callId: string;
    toolName: GatewayToolName;
    input: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<ExternalPermissionAnswer>;
  /**
   * Refuse a caller that may not use this tool at all — before the operator is asked about it.
   *
   * A tool whose authority check lives in its own implementation only runs it after the card is
   * answered, which means an operator can be shown "Send briefing to session X?", read the whole
   * briefing, allow it, and only then have the call refused for a reason their answer could not
   * change. Nothing unauthorised happens either way, but a card whose answer cannot matter is
   * the kind that teaches people to stop reading the ones that can.
   *
   * Throw to refuse; a {@link ControlPlaneSessionAuthorityError} is recorded as
   * `unauthenticated`, anything else as `unavailable`, exactly as the same throw from
   * {@link invokeTool} would be. It runs after `gateway_call_received` lands, so the attempt is
   * in the trail before it is turned away.
   *
   * Optional because it is a re-ordering, not a second gate: a composition that omits it loses
   * the early refusal and nothing else — the tool still refuses the call itself. So this must
   * never be the only place a check lives.
   */
  authorizeCall?(
    input: McpGatewayCaller & { projectId: string; toolName: GatewayToolName },
  ): Promise<void>;
  /** Execute the approved call. Resolves with the tool's result, or throws if the server
   *  could not serve it (sealed store, missing binding, transport failure). */
  invokeTool(
    input: McpGatewayCaller & {
      projectId: string;
      callId: string;
      /** Stable across an MCP transport retry of the same JSON-RPC invocation. */
      invocationId: string;
      toolName: GatewayToolName;
      request: unknown;
    },
  ): Promise<unknown>;
  /** Append one gateway audit record. Fail-closed on `gateway_call_received`: a throw
   *  refuses the call before any secret is resolved. */
  recordCall(record: McpGatewayAuditRecord): Promise<void>;
  /** Keyed MAC over the call, under the active gateway key (ADR 0014 D3). */
  requestMac(input: {
    projectId: string;
    request: unknown;
  }): Promise<{ requestMac: string; macKeyId: string }>;
  /**
   * The tools this gateway serves, defaulting to every one the contract names. A tool is
   * omitted when the composition cannot actually run it — `verity_secret_run` executes
   * inside the session's Sandbox through the turn's trusted-CLI broker, which a deployment
   * without a Sandbox supervisor has no way to reach.
   *
   * Omission is total, not cosmetic: an omitted name is absent from `tools/list` AND
   * refused by `tools/call` as an unknown tool, so the served set is the same set whichever
   * way the caller asks. Advertising a tool the gateway would then fail on would train the
   * model to retry a call that cannot ever succeed.
   */
  servedTools?: readonly GatewayToolName[];
  /** Additional tools exposed only for the already authenticated project identity. */
  extraToolsForProject?: ((projectId: string) => readonly GatewayToolName[]) | undefined;
  /** Overridable for tests; defaults to {@link MCP_GATEWAY_APPROVAL_TIMEOUT_MS}. */
  approvalTimeoutMs?: number;
}

const TOOL_SCHEMAS = {
  verity_http_request: brokeredHttpRequestSchema,
  verity_secret_run: trustedCliRequestSchema,
  verity_create_delivery: createDeliveryRequestSchema,
  verity_list_sessions: listSessionsRequestSchema,
  verity_session_handoff: sessionHandoffRequestSchema,
} as const satisfies Record<GatewayToolName, z.ZodType>;

const TOOL_DESCRIPTIONS: Record<GatewayToolName, string> = {
  verity_http_request: BROKERED_HTTP_TOOL_DESCRIPTION,
  verity_secret_run: TRUSTED_CLI_TOOL_DESCRIPTION,
  verity_create_delivery: CREATE_DELIVERY_TOOL_DESCRIPTION,
  verity_list_sessions: LIST_SESSIONS_TOOL_DESCRIPTION,
  verity_session_handoff: SESSION_HANDOFF_TOOL_DESCRIPTION,
};

function toolDeclarations(served: ReadonlySet<GatewayToolName>): readonly {
  name: string;
  description: string;
  inputSchema: unknown;
}[] {
  return gatewayToolNameSchema.options
    .filter((name) => served.has(name))
    .map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: z.toJSONSchema(TOOL_SCHEMAS[name], { target: 'draft-7' }),
    }));
}

function jsonRpcResult(id: string | number | null, result: unknown): McpGatewayResponse {
  return { status: 200, body: { jsonrpc: JSON_RPC_VERSION, id, result } };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): McpGatewayResponse {
  return { status: 200, body: { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } } };
}

/** A tool failure is an MCP *result*, not a protocol error: the model is meant to read it
 *  and decide what to do, the way it reads a 404 from `verity_http_request`. */
function toolError(id: string | number | null, message: string): McpGatewayResponse {
  return jsonRpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

function toolSuccess(id: string | number | null, result: unknown): McpGatewayResponse {
  return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
}

export interface McpGateway {
  /**
   * Serve one JSON-RPC message. `projectId` is the project the connection itself proved —
   * never a value the body carries — so a token can only ever act within the project it was
   * minted for, and a rejected call is still recorded against the right trail.
   */
  handle(input: {
    projectId: string;
    token: string | undefined;
    body: unknown;
  }): Promise<McpGatewayResponse>;
}

export function createMcpGateway(deps: McpGatewayDeps): McpGateway {
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? MCP_GATEWAY_APPROVAL_TIMEOUT_MS;
  const served = new Set<GatewayToolName>(
    deps.servedTools ?? ['verity_http_request', 'verity_secret_run'],
  );
  if (served.size === 0) throw new Error('MCP gateway must serve at least one tool');
  const toolsForProject = (projectId: string): ReadonlySet<GatewayToolName> =>
    new Set([...served, ...(deps.extraToolsForProject?.(projectId) ?? [])]);

  /** Record a refusal, then answer. A failed audit write cannot un-refuse the call, so it
   *  only downgrades the reply — the caller was getting nothing either way. */
  const reject = async (
    projectId: string,
    callId: string,
    rejection: GatewayCallRejection,
    keyed: { requestMac: string; macKeyId: string } | undefined,
    toolName: GatewayToolName | undefined,
    answer: McpGatewayResponse,
  ): Promise<McpGatewayResponse> => {
    try {
      await deps.recordCall({
        projectId,
        kind: 'gateway_call_rejected',
        channel: 'acp-mcp',
        callId,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(keyed ?? {}),
        rejection,
      });
    } catch {
      // The refusal stands; only its record is missing, and the caller learns nothing
      // from the difference.
    }
    return answer;
  };

  /** Key a call, or give up on it. The MAC is what makes a record reconcilable against the
   *  request that produced it, so a call that cannot be keyed cannot be recorded truthfully:
   *  every rejection the trail can hold except `malformed_request` carries one, and calling a
   *  keying failure malformed would misreport it. So nothing is written and nothing is served
   *  — the caller gets the same refusal it would get from any other unavailable dependency. */
  const key = async (
    projectId: string,
    request: unknown,
  ): Promise<{ requestMac: string; macKeyId: string } | undefined> => {
    try {
      return await deps.requestMac({ projectId, request });
    } catch {
      return undefined;
    }
  };

  const callTool = async (
    projectId: string,
    id: string | number | null,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    caller: McpGatewayCaller | undefined,
  ): Promise<McpGatewayResponse> => {
    // Minted before anything is examined, so every record this call produces — including the
    // ones for a body that never named a tool — can be paired with the others.
    const callId = randomUUID();
    const parsedParams = toolCallParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      // Nothing here names a tool or forms a request, so there is nothing to key.
      return reject(
        projectId,
        callId,
        'malformed_request',
        undefined,
        undefined,
        jsonRpcError(id, INVALID_PARAMS, 'tools/call requires a tool name'),
      );
    }
    const requested = parsedParams.data.name;
    const rawArguments = parsedParams.data.arguments ?? {};
    // Keyed over the call as it arrived, because at this point that is the only form of it
    // that exists: the checks that follow decide whether it is ever validated. Once it is,
    // the record keys the validated request instead, which is what actually ran.
    const rawKeyed = await key(projectId, { name: requested, arguments: rawArguments });
    if (rawKeyed === undefined) return toolError(id, UNRECORDED_CALL_MESSAGE);

    const unauthorized: McpGatewayResponse = { status: 401, body: { error: 'unauthorized' } };
    // The name is read before the credential, because an `unauthenticated` record has to say
    // which tool the attempt was for and only an authenticated caller would ever get that far
    // otherwise. The answer still does not: an unauthenticated caller is turned away with the
    // same 401 whichever name it used, so the served set stays unlearnable from outside.
    const parsedName = gatewayToolNameSchema.safeParse(requested);
    const toolName =
      parsedName.success && toolsForProject(projectId).has(parsedName.data)
        ? parsedName.data
        : undefined;
    if (toolName === undefined) {
      // A well-formed call for a tool this gateway does not serve: it keys, but the name it
      // asked for is not one the record's enum can hold. A contract tool left out of the
      // served set lands here too — to this caller it is simply not a tool that exists.
      return reject(
        projectId,
        callId,
        'unknown_tool',
        rawKeyed,
        undefined,
        caller === undefined
          ? unauthorized
          : jsonRpcError(id, METHOD_NOT_FOUND, `unknown tool ${requested}`),
      );
    }
    if (caller === undefined) {
      return reject(projectId, callId, 'unauthenticated', rawKeyed, toolName, unauthorized);
    }
    const request = TOOL_SCHEMAS[toolName].safeParse(rawArguments);
    if (!request.success) {
      return reject(
        projectId,
        callId,
        'malformed_request',
        undefined,
        undefined,
        jsonRpcError(id, INVALID_PARAMS, `${toolName} rejected the arguments`),
      );
    }
    const keyed = await key(projectId, request.data);
    if (keyed === undefined) return toolError(id, UNRECORDED_CALL_MESSAGE);
    const { sessionId, turnId } = caller;

    // Fail-closed, and before anything resolves a secret: a call the trail could not record
    // is a call that leaves no trace at all, which is the one thing this record exists to
    // prevent (ADR 0014 D3). Nothing below runs if this write does not land.
    try {
      await deps.recordCall({
        projectId,
        kind: 'gateway_call_received',
        channel: 'acp-mcp',
        callId,
        toolName: toolName,
        ...keyed,
      });
    } catch {
      return reject(
        projectId,
        callId,
        'unavailable',
        keyed,
        toolName,
        toolError(id, UNRECORDED_CALL_MESSAGE),
      );
    }

    // The one refusal shape two places produce: a control-plane tool declining a call, whether
    // it declines before the card (`authorizeCall`) or while serving it (`invokeTool`). Written
    // once so the two cannot classify the same throw differently — the bucket is the only thing
    // that tells an attempted crossing of the control-plane boundary from an outage, and a
    // reader of the trail has no other signal to fall back on.
    //
    // Relayed rather than redacted: this refusal names a session, a project or a next step the
    // caller can act on, and by construction it quotes no secret material. A caller told only
    // that the call could not be served would retry the same wrong target.
    //
    // Every refusal that is not an authority failure lands in `unavailable`, which overstates
    // the case: the call was well-formed, authorised and served — the tool declined the target.
    // The enum has no "refused by policy" member, and `malformed_request` cannot stand in for
    // one, because the audit schema rejects a `malformed_request` record that carries a MAC
    // (`audit.ts`) and this one is keyed. Reading the trail, the two are told apart by the
    // relayed message, not by the bucket. Widening the enum is an ADR 0014 contract change.
    const refuseControlPlane = (error: ControlPlaneSessionToolError) =>
      reject(
        projectId,
        callId,
        error instanceof ControlPlaneSessionAuthorityError ? 'unauthenticated' : 'unavailable',
        keyed,
        toolName,
        toolError(id, error.message),
      );

    if (deps.authorizeCall !== undefined) {
      try {
        await deps.authorizeCall({ projectId, sessionId, turnId, toolName });
      } catch (error) {
        if (error instanceof ControlPlaneSessionToolError) return refuseControlPlane(error);
        return reject(
          projectId,
          callId,
          'unavailable',
          keyed,
          toolName,
          toolError(id, 'Verity could not serve this call.'),
        );
      }
    }

    const timeout = AbortSignal.timeout(approvalTimeoutMs);
    let answer: ExternalPermissionAnswer;
    try {
      answer = await deps.requestApproval({
        projectId,
        sessionId,
        callId,
        toolName: toolName,
        input: request.data,
        signal: timeout,
      });
    } catch {
      return reject(
        projectId,
        callId,
        'unavailable',
        keyed,
        toolName,
        toolError(id, 'Verity could not ask for approval. Try again in a moment.'),
      );
    }
    if (answer.decision.behavior !== 'allow') {
      return reject(
        projectId,
        callId,
        'denied',
        keyed,
        toolName,
        toolError(id, answer.decision.message),
      );
    }
    if (answer.decision.updatedInput !== undefined) {
      // An edited approval is an approval of a different request than the one keyed and
      // recorded. Serving it would put a record in the trail that does not describe what
      // ran, so the edit is refused rather than silently reconciled.
      return reject(
        projectId,
        callId,
        'denied',
        keyed,
        toolName,
        toolError(id, 'The approved request was edited; edits are not supported here.'),
      );
    }
    // A card can be parked for minutes, and the caller's turn may settle while it waits —
    // which retires the bearer that admitted this call. Re-check the credential on the way
    // out of the wait, so an approval cannot land a call on a turn that no longer exists.
    //
    // This is the last point at which a check means anything, and it does not need a lease
    // to be exact: nothing awaits between the resolve below and entering `invokeTool`, so a
    // release cannot interleave there. A turn that settles once the call is on the wire is
    // not a window any check could close — the request has left. What bounds that case is
    // the tool's own at-most-once fence, which keys on the turn this bearer named.
    const still = token === undefined ? undefined : await deps.resolveCaller({ projectId, token });
    if (still === undefined || still.sessionId !== sessionId || still.turnId !== turnId) {
      return reject(projectId, callId, 'unauthenticated', keyed, toolName, unauthorized);
    }

    let result: unknown;
    try {
      result = await deps.invokeTool({
        projectId,
        sessionId,
        turnId,
        callId,
        invocationId: `${typeof id}:${String(id)}:${toolName}:${keyed.requestMac}`,
        toolName: toolName,
        request: request.data,
      });
    } catch (error) {
      if (error instanceof DopplerSecretResolutionError) {
        const message = dopplerResolutionMessage(error);
        if (message !== undefined) {
          return reject(projectId, callId, 'unavailable', keyed, toolName, toolError(id, message));
        }
      }
      // An authority failure should have been caught by `authorizeCall` before the card, but it
      // is classified the same way here: that dep is optional, and a session can also lose its
      // Control binding while the card is parked.
      if (error instanceof ControlPlaneSessionToolError) return refuseControlPlane(error);
      if (error instanceof TrustedCliDispatchError) {
        return reject(
          projectId,
          callId,
          'unavailable',
          keyed,
          toolName,
          toolError(id, trustedCliDispatchMessage(error)),
        );
      }
      return reject(
        projectId,
        callId,
        'unavailable',
        keyed,
        toolName,
        toolError(id, 'Verity could not serve this call.'),
      );
    }

    try {
      await deps.recordCall({
        projectId,
        kind: 'gateway_call_served',
        channel: 'acp-mcp',
        callId,
        toolName: toolName,
        ...keyed,
        decision: answer.decidedBy,
      });
    } catch {
      // The call already ran. Withholding the result is the only lever left, and the reply
      // says so plainly — a model told merely "failed" would retry a non-idempotent call.
      return toolError(
        id,
        'The request was sent, but Verity could not record it. Do not retry; report this.',
      );
    }
    return toolSuccess(id, result);
  };

  return {
    async handle({ projectId, token, body }): Promise<McpGatewayResponse> {
      const envelope = jsonRpcRequestSchema.safeParse(body);
      if (!envelope.success) {
        // Not addressed to any tool, so it is not a gateway call and gets no record.
        return jsonRpcError(null, Array.isArray(body) ? INVALID_REQUEST : PARSE_ERROR, 'invalid');
      }
      const { method, params } = envelope.data;
      const id = envelope.data.id ?? null;
      const isNotification = envelope.data.id === undefined;
      const caller =
        token === undefined || token === ''
          ? undefined
          : await deps.resolveCaller({ projectId, token });

      // `tools/call` authenticates inside, where the request can still be keyed and the
      // refusal recorded. Everything else is lifecycle: it reaches no secret, so an
      // unauthenticated one is simply turned away.
      if (method !== 'tools/call' && caller === undefined) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
      if (isNotification) {
        // A tool call is a request by definition — it has a result to return. Dropping an
        // id-less one silently would leave a caller believing a call was made that never
        // was, so it is answered as the malformed request it is. Nothing is recorded: no
        // tool ran, and the envelope never became a call.
        if (method === 'tools/call') {
          return jsonRpcError(null, INVALID_REQUEST, 'tools/call must carry an id');
        }
        // Other notifications carry no id to answer. `notifications/initialized` is the only
        // one the handshake needs; anything else is accepted and ignored rather than answered
        // with an error the client has nowhere to put.
        return { status: 202 };
      }

      switch (method) {
        case 'initialize': {
          const asked = params?.['protocolVersion'];
          const version =
            typeof asked === 'string' &&
            (MCP_GATEWAY_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
              ? asked
              : MCP_GATEWAY_PROTOCOL_VERSIONS[0];
          return jsonRpcResult(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_GATEWAY_SERVER_NAME, version: '1' },
          });
        }
        case 'ping':
          return jsonRpcResult(id, {});
        case 'tools/list':
          return jsonRpcResult(id, { tools: toolDeclarations(toolsForProject(projectId)) });
        case 'tools/call':
          return callTool(projectId, id, params, token, caller);
        default:
          return jsonRpcError(id, METHOD_NOT_FOUND, `unsupported method ${method}`);
      }
    },
  };
}
