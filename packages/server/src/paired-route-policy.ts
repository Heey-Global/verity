import { routeScopeKey } from './route-scopes.js';

type ProjectPermission = 'read' | 'execute' | 'manage';
type ResourceRule =
  | {
      readonly kind: 'project' | 'session';
      readonly parameter: string;
      readonly permission: ProjectPermission;
    }
  /** The project's creator, while still a member, or any administrator. */
  | { readonly kind: 'project_creator'; readonly parameter: string };
type PairedRoutePolicy =
  ResourceRule | { readonly kind: 'administrator' } | { readonly kind: 'active_user' };

/** Routes become available to members only after their resource and required
 * permission are declared here. Everything else remains administrator-only,
 * including collections and cross-project actions. */
const resourceRules: ReadonlyMap<string, ResourceRule> = new Map<string, ResourceRule>([
  // Deleting a project, or tearing down its sandboxes, ends everyone's work in it:
  // only the person who created it or an administrator may (members with manage
  // permission may not).
  [routeScopeKey('DELETE', '/projects/:id'), { kind: 'project_creator', parameter: 'id' }],
  [
    routeScopeKey('POST', '/projects/:id/deprovision'),
    { kind: 'project_creator', parameter: 'id' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/mockups'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/inquiry-grants'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PATCH', '/projects/:id/profile'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/inquiry-grants'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/project-inquiries'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/project-inquiries'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/project-inquiries/:inquiryId/decision'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  // Working in a shared project (ADR 0023 §1): reading a session, sending its
  // turns and handling its files and servers follow the project permission.
  [
    routeScopeKey('GET', '/sessions/:id/activity'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/branches'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/events'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/files'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/files/content'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/files/download'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/files/history'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/google-status'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/history/v1'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings/:meetingId/insights'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings/:meetingId/result'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/automation'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:sessionId/dev-servers'),
    { kind: 'session', parameter: 'sessionId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:sessionId/managed-dev-servers'),
    { kind: 'session', parameter: 'sessionId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:sessionId/managed-dev-servers/:serverId/logs'),
    { kind: 'session', parameter: 'sessionId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:sessionId/local-shares'),
    { kind: 'session', parameter: 'sessionId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:sessionId/public-static-directories'),
    { kind: 'session', parameter: 'sessionId', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/turns'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/cancel'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/permissions/:toolUseId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/queue/:itemId/cancel'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/planning'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/files'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/files/move'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/branch'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/merge'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/pull-request/merge'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/recover-worktree'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/save-to-project'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/knowledge-sources'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/meetings/transcripts'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/meetings/transcripts/stream'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/result/retry'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/files/content'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('DELETE', '/sessions/:id/files'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/live-meetings/:meetingId/result/tasks/:taskId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/automation'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/automation'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('DELETE', '/sessions/:id/automation'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-servers/:serverId/start'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-servers/:serverId/stop'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-servers/:serverId/restart'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-servers/:serverId/approve'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-servers/:serverId/local'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/managed-dev-server-instances/:instanceId/stop'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/local-shares'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/public-port-shares'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:sessionId/public-static-shares'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  [
    routeScopeKey('DELETE', '/sessions/:sessionId/managed-dev-servers/:serverId'),
    { kind: 'session', parameter: 'sessionId', permission: 'execute' },
  ],
  // Deleting a shared session removes it for everyone in the project.
  [
    routeScopeKey('DELETE', '/sessions/:id'),
    { kind: 'session', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:projectId/local-shares'),
    { kind: 'project', parameter: 'projectId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:projectId/public-shares'),
    { kind: 'project', parameter: 'projectId', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:projectId/secret-names'),
    { kind: 'project', parameter: 'projectId', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/wake'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/sleep'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:projectId/public-static-shares'),
    { kind: 'project', parameter: 'projectId', permission: 'execute' },
  ],
  // A project's settings, grants and connections are managed by its managers.
  [
    routeScopeKey('PATCH', '/projects/:id/setup-status'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/repair'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/secret-grants'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/secret-grants/:grantId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge-grants'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/knowledge-grants'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/mcp-bindings'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/mcp-bindings/:connectionId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/mcp-bindings/:connectionId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/integrations'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:projectId/secret-permissions'),
    { kind: 'project', parameter: 'projectId', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:projectId/secret-permissions'),
    { kind: 'project', parameter: 'projectId', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:projectId/secret-permissions/:permissionId'),
    { kind: 'project', parameter: 'projectId', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:projectId/secret-providers/doppler/bindings'),
    { kind: 'project', parameter: 'projectId', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:projectId/secret-providers/doppler/bindings'),
    { kind: 'project', parameter: 'projectId', permission: 'manage' },
  ],
  // A project's team: members and invitations need the permission to manage it.
  [
    routeScopeKey('GET', '/projects/:id/team'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/invitations'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/invitations/:invitationId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/invitations/:invitationId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('PATCH', '/projects/:id/members/:userId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/members/:userId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  // A person's own default model for the project, bound to the signed-in person.
  [
    routeScopeKey('PUT', '/projects/:id/default-model'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  // A person's own Doppler token for the project, bound to the signed-in person
  // inside the handlers; using secrets needs execute permission, so does this.
  [
    routeScopeKey('GET', '/projects/:id/doppler/connection'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/doppler/connection'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/doppler/connection'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/repositories'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/repository-instructions'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/pull-requests'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/pull-requests/:repositoryId/:number/merge'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/pull-requests/:repositoryId/:number/fix'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/repositories'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/repositories/:repositoryId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/repositories'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/repositories/:repositoryId/open'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  // The person's own view of a project or session (fold, read mark, dismissed
  // Home items) is stored per user and changes nothing anyone else sees, so
  // reading the resource is enough. Resources the member cannot read are refused
  // exactly as their reads are, so no view state is written for them.
  [
    routeScopeKey('PATCH', '/projects/:id/collapsed'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PATCH', '/projects/:id/inbox-dismissed'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/seen'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/inbox-dismissed'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge/files'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge/files/content'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge/wiki'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge/files/download'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/knowledge/files'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/knowledge/files/content'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/knowledge/files/rename'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  // Proposed Wiki changes are read like the Wiki and decided like an edit of it.
  [
    routeScopeKey('GET', '/projects/:id/knowledge/proposals'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/knowledge/proposals/:proposalId'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/knowledge/proposals/:proposalId/apply'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/knowledge/proposals/:proposalId/reject'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/instructions'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/instructions'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/memory'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/memory'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/disconnect-github'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/mcp-apps/:appId'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/mcp-apps/:appId/call'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/assistant'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/assistant'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/repairs/approval'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/repairs'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('PUT', '/projects/:id/repairs'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/repairs/retry'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/remove-request'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/permanent'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/egress'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/requests'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/decisions'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/reopen'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/egress/revoke'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/vulnerability-scan/ignores'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/vulnerability-scan/ignores'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('DELETE', '/projects/:id/vulnerability-scan/ignores/:ignoreId'),
    { kind: 'project', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/vulnerability-scan'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/vulnerability-fix'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/projects/:id/vulnerability-scan'),
    { kind: 'project', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/online'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/online/stop'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PATCH', '/sessions/:id/live-meetings/:meetingId/online/speakers'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [routeScopeKey('GET', '/projects/:id'), { kind: 'project', parameter: 'id', permission: 'read' }],
  [
    routeScopeKey('GET', '/projects/:id/github/issues'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/projects/:id/issues'),
    { kind: 'project', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/vulnerability-scan'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [routeScopeKey('GET', '/sessions/:id'), { kind: 'session', parameter: 'id', permission: 'read' }],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    // Execute, not read: the view carries the guest's link with its PIN, which can book.
    routeScopeKey('GET', '/sessions/:id/scheduling-requests'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],

  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    // Discarding deletes what everyone in the session heard; like other destructive
    // replacements it needs management rights, not only the right to record.
    routeScopeKey('DELETE', '/sessions/:id/live-meetings/:meetingId'),
    { kind: 'session', parameter: 'id', permission: 'manage' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/addressed'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/speaker-name'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId/notes/:noteId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('GET', '/sessions/:id/live-meetings/:meetingId/commands'),
    { kind: 'session', parameter: 'id', permission: 'read' },
  ],
  [
    routeScopeKey('POST', '/sessions/:id/live-meetings/:meetingId/commands'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
  [
    routeScopeKey('PUT', '/sessions/:id/live-meetings/:meetingId/commands/:commandId'),
    { kind: 'session', parameter: 'id', permission: 'execute' },
  ],
]);

const activeUserRoutes = new Set([
  routeScopeKey('GET', '/project-inquiries/pending'),
  routeScopeKey('GET', '/knowledge/shared/files'),
  routeScopeKey('GET', '/knowledge/shared/recent'),
  routeScopeKey('GET', '/knowledge/shared/files/content'),
  routeScopeKey('GET', '/knowledge/shared/files/download'),
  // Personal context is bound to the authenticated identity inside the handlers.
  routeScopeKey('GET', '/me/context'),
  routeScopeKey('PUT', '/me/context'),
  // The display name is bound to the authenticated identity inside the handlers.
  routeScopeKey('GET', '/me/profile'),
  routeScopeKey('PUT', '/me/profile'),
  // A person's own GitHub connection, bound to the authenticated identity inside the handlers.
  routeScopeKey('GET', '/me/github'),
  routeScopeKey('POST', '/me/github/authorize'),
  routeScopeKey('POST', '/me/github/authorize/complete'),
  routeScopeKey('DELETE', '/me/github'),
  // A person's own AI provider accounts, bound to the authenticated identity inside the handlers.
  routeScopeKey('GET', '/me/provider-connections'),
  routeScopeKey('POST', '/me/provider-connections/:provider/login'),
  routeScopeKey('GET', '/me/provider-connections/logins/:sessionId'),
  routeScopeKey('POST', '/me/provider-connections/logins/:sessionId/code'),
  routeScopeKey('PUT', '/me/provider-connections/opencode'),
  routeScopeKey('DELETE', '/me/provider-connections/:provider'),
  // A person's own commit identity and signing key, bound to the authenticated identity inside the handlers.
  routeScopeKey('GET', '/me/git-identity'),
  routeScopeKey('PUT', '/me/git-identity'),
  routeScopeKey('POST', '/me/git-identity/signing-key'),
  // Any active user may open the live connection; every session it subscribes
  // to is authorized individually, like `GET /sessions/:id`. The WebSocket
  // handshake consumes the ticket, not a paired-device bearer.
  routeScopeKey('POST', '/live/ticket'),
  routeScopeKey('GET', '/projects'),
  // Sessions are filtered to readable projects inside the handler, and creating
  // one is checked against the target project there.
  routeScopeKey('GET', '/sessions'),
  routeScopeKey('POST', '/sessions'),
  routeScopeKey('GET', '/auth/session'),
  routeScopeKey('POST', '/auth/logout'),
  // Tasks are owner-scoped inside the handler (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md §7.2).
  routeScopeKey('GET', '/tasks'),
  // Scheduling requests are filtered and checked per project inside the handler.
  routeScopeKey('GET', '/scheduling-requests'),
  routeScopeKey('POST', '/scheduling-requests/:requestId/revoke'),
  // Running meetings are filtered per session inside the handler; unassigned ones are
  // listed for administrators only. Assigning and discarding stay administrator routes.
  routeScopeKey('GET', '/live-meetings/active'),
  routeScopeKey('GET', '/tasks/:id/attachments/:hash'),
  routeScopeKey('PUT', '/tasks/:id'),
  routeScopeKey('PATCH', '/tasks/:id'),
  routeScopeKey('DELETE', '/tasks/:id'),
]);

/**
 * Session and project routes that deliberately stay administrator-only: creating
 * projects, cross-session links and moves, diagnostics, and everything bound to
 * the administrator's own Google account. Every other session or project route
 * must declare its resource and permission above; a guard test holds that.
 */
export const ADMINISTRATOR_ONLY_RESOURCE_ROUTES: ReadonlySet<string> = new Set([
  // A project's settings include instance-wide choices; managers rename projects
  // and set their own default model through their own routes.
  routeScopeKey('PATCH', '/projects/:id/settings'),
  routeScopeKey('POST', '/projects'),
  routeScopeKey('POST', '/projects/:id/link'),
  routeScopeKey('POST', '/projects/:id/link-github'),
  routeScopeKey('PATCH', '/projects/order'),
  routeScopeKey('PATCH', '/sessions/order'),
  routeScopeKey('POST', '/sessions/:id/project'),
  routeScopeKey('POST', '/sessions/:id/links'),
  routeScopeKey('DELETE', '/sessions/:id/links/:targetId'),
  routeScopeKey('GET', '/sessions/:id/links'),
  routeScopeKey('GET', '/sessions/:id/linked-message-approvals'),
  routeScopeKey('GET', '/sessions/:id/qa-approvals'),
  routeScopeKey('GET', '/sessions/:id/diagnostics'),
  routeScopeKey('POST', '/sessions/:id/debug/scroll'),
  routeScopeKey('POST', '/sessions/:id/google-drive/import'),
  routeScopeKey('GET', '/sessions/:id/calendar'),
  routeScopeKey('PUT', '/sessions/:id/calendar'),
  routeScopeKey('DELETE', '/sessions/:id/calendar'),
  routeScopeKey('GET', '/sessions/:id/contacts'),
  routeScopeKey('PUT', '/sessions/:id/contacts'),
  routeScopeKey('DELETE', '/sessions/:id/contacts'),
  routeScopeKey('GET', '/sessions/:id/gmail'),
  routeScopeKey('PUT', '/sessions/:id/gmail'),
  routeScopeKey('DELETE', '/sessions/:id/gmail'),
  routeScopeKey('GET', '/sessions/:id/google-slides/deck'),
  routeScopeKey('PUT', '/sessions/:id/google-slides/deck'),
  routeScopeKey('DELETE', '/sessions/:id/google-slides/deck'),
  routeScopeKey('GET', '/sessions/:id/google-workspace/file'),
  routeScopeKey('PUT', '/sessions/:id/google-workspace/file'),
  routeScopeKey('DELETE', '/sessions/:id/google-workspace/file'),
  routeScopeKey('GET', '/sessions/:id/google/:service'),
  routeScopeKey('PUT', '/sessions/:id/google/:service'),
  routeScopeKey('GET', '/projects/:id/google/:service'),
  routeScopeKey('PUT', '/projects/:id/google/:service'),
  routeScopeKey('DELETE', '/projects/:id/google/:service'),
  routeScopeKey('PUT', '/projects/:id/google-drive/folder'),
  routeScopeKey('DELETE', '/projects/:id/google-drive/folder'),
  routeScopeKey('GET', '/projects/:id/google-drive/folders'),
  routeScopeKey('DELETE', '/projects/:id/google-drive/folders/:linkId'),
  routeScopeKey('GET', '/projects/:id/google-drive/folders/:folderId/files'),
  routeScopeKey('GET', '/projects/:id/google-drive/folders/:folderId/files/:fileId'),
  routeScopeKey('GET', '/projects/:id/google-drive/folders/:folderId/files/:fileId/download'),
  routeScopeKey('PATCH', '/projects/:id/google-drive/folders/:folderId/files/:fileId'),
  routeScopeKey('DELETE', '/projects/:id/google-drive/folders/:folderId/files/:fileId'),
  routeScopeKey('POST', '/projects/:id/google-drive/folders/:folderId/files/:fileId/import'),
  routeScopeKey('POST', '/projects/:id/google-drive/folders/:folderId/files/create'),
  routeScopeKey('POST', '/projects/:id/google-drive/folders/:folderId/files/upload'),
  routeScopeKey('PUT', '/projects/:id/google-drive/folders/:folderId/files/:fileId/content'),
]);

export function pairedRoutePolicy(method: string, routeUrl: string): PairedRoutePolicy {
  const key = routeScopeKey(method, routeUrl);
  if (activeUserRoutes.has(key)) return { kind: 'active_user' };
  return resourceRules.get(key) ?? { kind: 'administrator' };
}

export interface PairedRoutePolicyStore {
  isActiveLocalUser(userId: string): Promise<boolean>;
  isActiveAdministrator(userId: string): Promise<boolean>;
  hasProjectPermission(
    userId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<boolean>;
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  /** Whether the user created the project; absent, only administrators qualify. */
  isProjectCreator?(userId: string, projectId: string): Promise<boolean>;
}

export async function authorizePairedRoute(
  store: PairedRoutePolicyStore,
  userId: string,
  method: string,
  routeUrl: string,
  params: Record<string, unknown>,
): Promise<'allow' | 'forbidden' | 'not_found'> {
  const policy = pairedRoutePolicy(method, routeUrl);
  if (policy.kind === 'active_user') {
    return (await store.isActiveLocalUser(userId)) ? 'allow' : 'forbidden';
  }
  if (policy.kind === 'administrator') {
    return (await store.isActiveAdministrator(userId)) ? 'allow' : 'forbidden';
  }
  const resourceId = params[policy.parameter];
  if (typeof resourceId !== 'string') return 'not_found';
  if (policy.kind === 'project_creator') {
    if (await store.isActiveAdministrator(userId)) return 'allow';
    return (await store.isActiveLocalUser(userId)) &&
      (await store.isProjectCreator?.(userId, resourceId)) === true &&
      (await store.hasProjectPermission(userId, resourceId, 'read'))
      ? 'allow'
      : 'forbidden';
  }
  // These routes were the administrator's before members could use them; an
  // administrator keeps every one of them.
  if (await store.isActiveAdministrator(userId)) return 'allow';
  const projectId =
    policy.kind === 'project' ? resourceId : (await store.getSession(resourceId))?.projectId;
  if (projectId === undefined) return 'not_found';
  if (projectId === null) {
    return (await store.isActiveAdministrator(userId)) ? 'allow' : 'forbidden';
  }
  return (await store.hasProjectPermission(userId, projectId, policy.permission))
    ? 'allow'
    : 'forbidden';
}
