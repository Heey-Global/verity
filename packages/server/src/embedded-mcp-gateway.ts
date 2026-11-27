import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';
import { brokeredSecretReferences, referencedSnapshot } from './brokered-http-tool.js';
import { join } from 'node:path';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { createEmbeddedBrokeredHttp } from './embedded-brokered-http.js';
import type { createEmbeddedTrustedCli } from './embedded-trusted-cli.js';
import type { createEmbeddedIntegrationTools } from './embedded-integration-tools.js';
import type { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { gatewayRequestMac, type createGatewayRequestMacKeyring } from './gateway-request-mac.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { createMcpGatewayToolExecutor, createTrustedCliPreflight } from './mcp-gateway-tools.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import { createBrokeredToolApprovalStore } from './brokered-tool-approval-store.js';
import type { Kysely } from 'kysely';
import type { Database } from '@verity/store';
import { CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';

type EmbeddedMcpGatewayContext = Pick<
  ReturnType<typeof createEmbeddedBrokeredHttp>,
  'getBrokeredProjectBindings' | 'brokeredHttpTool'
> &
  ReturnType<typeof createEmbeddedTrustedCli> &
  Pick<
    ReturnType<typeof createEmbeddedIntegrationTools>,
    | 'invokeGoogleSlides'
    | 'invokeGoogleDocs'
    | 'invokeGoogleSheets'
    | 'invokeGmail'
    | 'matrixTool'
    | 'invokeGoogleCalendar'
    | 'invokeGoogleContacts'
    | 'invokeGoogleDrive'
  > & {
    secretAuditLog: ReturnType<typeof createPostgresSecretAuditLog>;
    gatewayRequestMacKeys: ReturnType<typeof createGatewayRequestMacKeyring>;
  };

export function createEmbeddedMcpGateway(
  config: Pick<EmbeddedServerConfig, 'runnerSupervisor' | 'dataVolumeRoot'>,
  db: Kysely<Database>,
  {
    secretAuditLog,
    gatewayRequestMacKeys,
    getBrokeredProjectBindings,
    brokeredHttpTool,
    trustedCliTool,
    trustedCliOutput,
    invokeGoogleSlides,
    invokeGoogleDocs,
    invokeGoogleSheets,
    invokeGmail,
    matrixTool,
    invokeGoogleCalendar,
    invokeGoogleContacts,
    invokeGoogleDrive,
  }: EmbeddedMcpGatewayContext,
) {
  const mcpGatewayTokens = createMcpGatewayTokens({
    onResolveRejected: (input) => {
      // Keep the bearer and its digest out of logs. The reason and the two already-known
      // project identities are enough to distinguish a stale turn from a relay binding bug.
      console.warn(`verity: MCP gateway bearer rejected ${JSON.stringify(input)}`);
    },
  });
  const mcpProxyTokens = createMcpGatewayTokens();
  const mcpGateway: Omit<McpGatewayDeps, 'requestApproval'> = {
    detachedApprovals: createBrokeredToolApprovalStore(db),
    hasSecretExecutionClaim: createBrokeredHttpConsumptionStore(db).has,
    // Trusted CLI needs the project supervisor: it is the authority that proves this bearer
    // still names a live turn whose start request enabled execution. Deployments without the
    // supervisor omit the tool completely rather than advertising a permanently failing call.
    servedTools:
      config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? [
            'verity_http_request',
            'verity_secret_run',
            'verity_secret_output',
            'verity_publish_session_progress',
            'verity_send_session_message',
            'verity_project_inquiry',
            'verity_session_coordinate',
            'verity_list_linked_sessions',
            'verity_start_planning',
            'verity_present_plan',
            'verity_end_planning',
            'verity_present_mockups',
            'verity_complete_mockups',
            'verity_tasks',
            'verity_repairs',
            'verity_qa_analysis',
            'verity_app_help',
            'verity_vulnerabilities',
            'verity_google_slides',
            'verity_google_docs',
            'verity_knowledge',
            'verity_memory_append',
            'verity_google_sheets',
            'verity_gmail',
            'verity_matrix',
            'verity_google_calendar',
            'verity_scheduling',
            'verity_google_contacts',
            'verity_google_drive',
          ]
        : [
            'verity_http_request',
            'verity_publish_session_progress',
            'verity_send_session_message',
            'verity_project_inquiry',
            'verity_session_coordinate',
            'verity_list_linked_sessions',
            'verity_start_planning',
            'verity_present_plan',
            'verity_end_planning',
            'verity_present_mockups',
            'verity_complete_mockups',
            'verity_tasks',
            'verity_repairs',
            'verity_qa_analysis',
            'verity_app_help',
            'verity_vulnerabilities',
            'verity_google_slides',
            'verity_google_docs',
            'verity_knowledge',
            'verity_memory_append',
            'verity_google_sheets',
            'verity_gmail',
            'verity_matrix',
            'verity_google_calendar',
            'verity_scheduling',
            'verity_google_contacts',
            'verity_google_drive',
          ],
    // Control-plane session tools are handled in `buildServer`, which owns session
    // creation and dispatch. Keep their advertisement scoped to the control project.
    extraToolsForProject: (projectId) =>
      projectId === CONTROL_PLANE_RUNNER_PROJECT_ID
        ? [
            'verity_diagnostics',
            'verity_list_sessions',
            'verity_session_handoff',
            'verity_session_progress',
            'verity_recent_session_messages',
            // Advertised to every Control session; only the assistant session may call it.
            'verity_assistant',
          ]
        : [],
    // An approval is bound to the Doppler bindings the call reads from (ADR 0031).
    authorizationSnapshot: async ({ projectId, toolName, request }) => {
      if (toolName !== 'verity_http_request' && toolName !== 'verity_secret_run') return undefined;
      return JSON.stringify(
        referencedSnapshot(
          await getBrokeredProjectBindings(projectId),
          brokeredSecretReferences(toolName, request),
        ),
      );
    },
    resolveCaller: (input) => Promise.resolve(mcpGatewayTokens.resolve(input)),
    ...(config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
      ? {
          authorizeCall: createTrustedCliPreflight({
            runnerRoot: join(config.dataVolumeRoot, 'runners'),
          }),
        }
      : {}),
    // Both tools reuse the brokered execution implementations, including their at-most-once
    // approval fence. The gateway bearer supplies the project/session/turn identity; its
    // stable invocation ID prevents transport retries from consuming approval twice.
    invokeTool: createMcpGatewayToolExecutor({
      brokeredHttpTool: brokeredHttpTool,
      trustedCliTool,
      trustedCliOutput,
      ...(config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? { runnerRoot: join(config.dataVolumeRoot, 'runners') }
        : {}),
      googleSlides: invokeGoogleSlides,
      googleDocs: invokeGoogleDocs,
      googleSheets: invokeGoogleSheets,
      gmail: invokeGmail,
      matrix: (input) => matrixTool.invoke(input),
      googleCalendar: invokeGoogleCalendar,
      googleContacts: invokeGoogleContacts,
      googleDrive: invokeGoogleDrive,
    }),
    recordCall: async ({ projectId, kind, ...gateway }) => {
      await secretAuditLog.append({
        projectId,
        kind,
        aliases: [],
        providerBindings: [],
        gateway,
        recordedAt: new Date().toISOString(),
      });
    },
    requestMac: async ({ projectId, request }) => {
      const key = await gatewayRequestMacKeys.active();
      try {
        return { requestMac: gatewayRequestMac(key, projectId, request), macKeyId: key.keyId };
      } finally {
        key.material.fill(0);
      }
    },
  };

  return { mcpGatewayTokens, mcpProxyTokens, mcpGateway };
}
