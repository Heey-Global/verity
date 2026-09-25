import { requestRunnerSupervisor, runSupervisorTrustedCli } from '@verity/session';
import { join } from 'node:path';

import type { McpGatewayDeps } from './mcp-gateway.js';
import { ControlPlaneSessionToolError } from './session-handoff-tool.js';
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
  googleSlides?:
    | ((input: {
        projectId: string;
        sessionId: string;
        turnId: string;
        invocationId: string;
        request: unknown;
      }) => Promise<unknown>)
    | undefined;
  googleDocs?:
    | ((input: {
        projectId: string;
        sessionId: string;
        turnId: string;
        invocationId: string;
        request: unknown;
      }) => Promise<unknown>)
    | undefined;
  googleSheets?:
    | ((input: {
        projectId: string;
        sessionId: string;
        turnId: string;
        invocationId: string;
        request: unknown;
      }) => Promise<unknown>)
    | undefined;
  gmail?:
    | ((input: {
        projectId: string;
        sessionId: string;
        turnId: string;
        invocationId: string;
        request: unknown;
      }) => Promise<unknown>)
    | undefined;
  googleDrive?:
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
    if (toolName === 'verity_google_slides') {
      if (options.googleSlides === undefined) throw new Error('Google Slides is unavailable');
      return options.googleSlides({ projectId, sessionId, turnId, invocationId, request });
    }
    if (toolName === 'verity_google_docs') {
      if (options.googleDocs === undefined) throw new Error('Google Docs is unavailable');
      return options.googleDocs({ projectId, sessionId, turnId, invocationId, request });
    }
    if (toolName === 'verity_google_sheets') {
      if (options.googleSheets === undefined) throw new Error('Google Sheets is unavailable');
      return options.googleSheets({ projectId, sessionId, turnId, invocationId, request });
    }
    if (toolName === 'verity_gmail') {
      if (options.gmail === undefined) throw new Error('Gmail is unavailable');
      return options.gmail({ projectId, sessionId, turnId, invocationId, request });
    }
    if (toolName === 'verity_google_drive') {
      if (options.googleDrive === undefined) throw new Error('Google Drive is unavailable');
      return options.googleDrive({ projectId, sessionId, turnId, invocationId, request });
    }
    if (toolName === 'verity_knowledge') {
      throw new Error('knowledge tools are unavailable');
    }
    if (
      toolName === 'verity_list_sessions' ||
      toolName === 'verity_session_handoff' ||
      toolName === 'verity_session_progress' ||
      toolName === 'verity_recent_session_messages' ||
      toolName === 'verity_publish_session_progress' ||
      toolName === 'verity_send_session_message' ||
      toolName === 'verity_list_linked_sessions'
    ) {
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

export const SCRIPT_ISOLATION_UNAVAILABLE_MESSAGE =
  "Worktree entry scripts are unavailable in this project's Sandbox: its container runtime " +
  'cannot enforce the filesystem boundary for approved scripts. The request ' +
  'was not shown for approval and nothing ran. Run an installed executable without ' +
  '`entryScript` instead, or use a container runtime with script isolation support.';

/**
 * Refuse a `verity_secret_run` entry script before its approval card is raised when the
 * project's Sandbox reports it cannot confine one. The supervisor and the spawn broker
 * refuse the same request on their own, so
 * this only moves the refusal ahead of a card whose answer could not change the outcome.
 *
 * Only an explicit `scriptIsolation: false` refuses. A supervisor that predates the field
 * started only after the helper's probe passed, and an unreachable supervisor fails the call
 * on its own after approval, exactly as before this check existed.
 */
export function createTrustedCliPreflight(options: {
  runnerRoot: string;
  requestStatus?: (socketPath: string) => Promise<Record<string, unknown>>;
}): NonNullable<McpGatewayDeps['authorizeCall']> {
  const requestStatus =
    options.requestStatus ??
    ((socketPath: string) => requestRunnerSupervisor(socketPath, { kind: 'status' }));
  return async ({ projectId, toolName, request }) => {
    if (toolName !== 'verity_secret_run') return;
    if (
      typeof request !== 'object' ||
      request === null ||
      (request as { entryScript?: unknown }).entryScript === undefined
    ) {
      return;
    }
    let status: Record<string, unknown>;
    try {
      status = await requestStatus(join(options.runnerRoot, projectId, 'supervisor.sock'));
    } catch {
      return;
    }
    if (status['scriptIsolation'] === false) {
      throw new ControlPlaneSessionToolError(SCRIPT_ISOLATION_UNAVAILABLE_MESSAGE);
    }
  };
}
