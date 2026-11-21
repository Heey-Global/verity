import { assistantHandoffResultsSpec } from './assistant-handoff-results';
import { nativeMcpAppsSpec } from './native-mcp-apps';
import { teamJoinRecoverySpec } from './team-join-recovery';
import { sandboxUpdatesSpec } from './sandbox-updates';
import { aiAccountsSpec } from './ai-accounts';
import { codeWorkspaceSpec } from './code-workspace';
import { connectionStatusSpec } from './connection-status';
import { sessionStabilitySpec } from './session-stability';
import { sessionGroupsSpec } from './session-groups';
import { factorySpec } from './factory-spec';
import { homeAnswersSpec } from './home-answers';
import { homeVerityEntrySpec } from './home-verity-entry';
import { fileExplorerSpec } from './file-explorer';
import { instructionSourcesSpec } from './instruction-sources';
import { mcpOAuthDetectionSpec } from './mcp-oauth-detection';
import { mockupReviewSpec } from './mockup-review';
import { meetingRecoverySpec } from './meeting-recovery';
import { planCardSpec } from './plan-card';
import { projectInquiryApprovalSpec } from './project-inquiry-approval';
import { projectNamesSpec } from './project-names';
import { projectQASpec } from './project-qa';
import { repositoriesSpec } from './repositories';
import { sourceActionsSpec } from './source-actions';
import { teamInvitationsSpec } from './team-invitations';
import type { MockupScreen, MockupSpec } from './types';
import { wikiSpec } from './wiki';
import { wikiMaintenanceSpec } from './wiki-maintenance';

/** Every spec with mockups. A new spec folder is added here. */
export const MOCKUP_SPECS: readonly MockupSpec[] = [
  assistantHandoffResultsSpec,
  nativeMcpAppsSpec,
  teamJoinRecoverySpec,
  sandboxUpdatesSpec,
  aiAccountsSpec,
  codeWorkspaceSpec,
  sessionStabilitySpec,
  connectionStatusSpec,
  sessionGroupsSpec,
  factorySpec,
  homeAnswersSpec,
  homeVerityEntrySpec,
  mockupReviewSpec,
  meetingRecoverySpec,
  instructionSourcesSpec,
  fileExplorerSpec,
  mcpOAuthDetectionSpec,
  planCardSpec,
  projectInquiryApprovalSpec,
  projectNamesSpec,
  projectQASpec,
  repositoriesSpec,
  sourceActionsSpec,
  teamInvitationsSpec,
  wikiSpec,
  wikiMaintenanceSpec,
];

export function findMockup(
  specId: string | undefined,
  screenId: string | undefined,
): { spec: MockupSpec; screen: MockupScreen } | null {
  const spec = MOCKUP_SPECS.find((candidate) => candidate.id === specId);
  if (!spec || screenId === undefined || !Object.hasOwn(spec.screens, screenId)) return null;
  const screen = spec.screens[screenId];
  return screen ? { spec, screen } : null;
}
