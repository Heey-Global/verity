import { runSupervisorTrustedCli } from '@verity/session';
import { join } from 'node:path';

import type { McpGatewayDeps } from './mcp-gateway.js';
import type { createBrokeredHttpTool } from './brokered-http-tool.js';
import type { createTrustedCliTool } from './trusted-cli-tool.js';

type BrokeredHttpTool = ReturnType<typeof createBrokeredHttpTool>;
type TrustedCliTool = ReturnType<typeof createTrustedCliTool>;

export function createMcpGatewayToolExecutor(options: {
  brokeredHttpTool: BrokeredHttpTool;
  trustedCliTool: TrustedCliTool;
  /** Root containing one supervisor runtime directory per project. */
  runnerRoot?: string | undefined;
  runTrustedCli?: typeof runSupervisorTrustedCli | undefined;
  createDelivery?:
    | ((input: {
        projectId: string;
        sessionId: string;
        turnId: string;
        invocationId: string;
        request: unknown;
      }) => Promise<unknown>)
    | undefined;
}): McpGatewayDeps['invokeTool'] {
  const runTrustedCli = options.runTrustedCli ?? runSupervisorTrustedCli;
  const runnerRoot = options.runnerRoot;
  return async ({ projectId, sessionId, turnId, callId, invocationId, toolName, request }) => {
    if (toolName === 'verity_secret_run') {
      if (runnerRoot === undefined) throw new Error('trusted CLI execution is unavailable');
      return await options.trustedCliTool(
        projectId,
        sessionId,
        turnId,
        { id: callId, name: 'verity_secret_run', input: request },
        (input) => runTrustedCli(join(runnerRoot, projectId), input),
      );
    }
    if (toolName === 'verity_http_request') {
      return await options.brokeredHttpTool(projectId, sessionId, turnId, {
        id: callId,
        name: 'verity_http_request',
        input: request,
      });
    }
    if (toolName === 'verity_create_delivery') {
      if (options.createDelivery === undefined) throw new Error('delivery creation is unavailable');
      return options.createDelivery({
        projectId,
        sessionId,
        turnId,
        invocationId,
        request,
      });
    }
    if (toolName === 'verity_list_sessions' || toolName === 'verity_session_handoff') {
      // Not served from here. Both need the conductor and the route's session projection,
      // neither of which exists in the composition that builds this executor, so `buildServer`
      // intercepts them ahead of it — the same reason `requestApproval` is bound there. A call
      // reaching this branch means that seam is missing, which is a composition fault and not
      // something a retry fixes.
      throw new Error('control-plane session tools are unavailable');
    }
    toolName satisfies never;
    throw new Error('unsupported MCP gateway tool');
  };
}
