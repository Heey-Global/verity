import {
  Kind,
  OperationTypeNode,
  parse,
  visit,
  valueFromASTUntyped,
  type FieldNode,
  type SelectionSetNode,
} from 'graphql';
import type { IncomingMessage } from 'node:http';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

export type ForgeAction =
  'git-read' | 'git-write' | 'issues-read' | 'issues-write' | 'pulls-read' | 'pulls-write';
export interface ForgeBinding {
  projectId: string;
  owner: string;
  repo: string;
  containerGeneration?: string | undefined;
}
export interface ForgeRequest {
  hostname: string;
  method: string;
  path: string;
  body?: Buffer;
}
export interface ForgeAuthorization {
  action: ForgeAction;
  authorization: string;
  credentials: readonly { value: string; alias: string }[];
}

/** Provider-specific policy and credential resolution; the transport knows no GitHub paths. */
export interface BrokeredForgeAdapter {
  readonly hosts: ReadonlySet<string>;
  streams(request: ForgeRequest): boolean;
  authorize(
    request: ForgeRequest,
    binding: ForgeBinding,
    actions: ReadonlySet<ForgeAction>,
    signal: AbortSignal,
  ): Promise<ForgeAuthorization>;
}

const REPOSITORY_METADATA_FIELDS = new Set([
  'id',
  'databaseId',
  'sshUrl',
  'mergeCommitAllowed',
  'rebaseMergeAllowed',
  'squashMergeAllowed',
  'name',
  'nameWithOwner',
  'url',
  'owner',
  'description',
  'isPrivate',
  'isFork',
  'isArchived',
  'hasIssuesEnabled',
  'hasWikiEnabled',
  'viewerPermission',
  'defaultBranchRef',
  '__typename',
]);

const MUTATIONS: Readonly<Record<string, { action: ForgeAction; id: string; type: string }>> = {
  createIssue: { action: 'issues-write', id: 'repositoryId', type: 'Repository' },
  updateIssue: { action: 'issues-write', id: 'id', type: 'Issue' },
  closeIssue: { action: 'issues-write', id: 'issueId', type: 'Issue' },
  reopenIssue: { action: 'issues-write', id: 'issueId', type: 'Issue' },
  createPullRequest: { action: 'pulls-write', id: 'repositoryId', type: 'Repository' },
  updatePullRequest: { action: 'pulls-write', id: 'pullRequestId', type: 'PullRequest' },
  closePullRequest: { action: 'pulls-write', id: 'pullRequestId', type: 'PullRequest' },
  reopenPullRequest: { action: 'pulls-write', id: 'pullRequestId', type: 'PullRequest' },
  mergePullRequest: { action: 'pulls-write', id: 'pullRequestId', type: 'PullRequest' },
  addComment: { action: 'issues-write', id: 'subjectId', type: 'IssueOrPullRequest' },
};
function rejected(): never {
  throw new Error('forge request rejected');
}
function assertAction(actions: ReadonlySet<ForgeAction>, action: ForgeAction): void {
  if (!actions.has(action)) rejected();
}
function sameRepo(value: unknown, binding: ForgeBinding): boolean {
  return (
    typeof value === 'string' &&
    value.toLowerCase() === `${binding.owner}/${binding.repo}`.toLowerCase()
  );
}
async function collectJson(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    const chunk = Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > 65_536) {
      response.destroy();
      rejected();
    }
    chunks.push(chunk);
  }
  if (response.statusCode !== 200) rejected();
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createGitHubForgeAdapter(options: {
  mint(binding: { owner: string; repo: string }): Promise<string | undefined>;
  transport: BrokeredHttpStreamTransport;
}): BrokeredForgeAdapter {
  return {
    hosts: new Set(['github.com', 'api.github.com']),
    streams: (request) => request.hostname === 'github.com',
    async authorize(request, binding, actions, signal) {
      if (!/^[A-Za-z0-9_.-]+$/.test(binding.owner) || !/^[A-Za-z0-9_.-]+$/.test(binding.repo))
        rejected();
      // Check the unnormalized target: URL normalization must not erase traversal before policy.
      if (
        !request.path.startsWith('/') ||
        request.path.split('?', 1)[0]!.includes('%') ||
        request.path.includes('\\') ||
        request.path.split(/[/?]/).some((part) => part === '.' || part === '..')
      )
        rejected();
      const url = new URL(request.path, `https://${request.hostname}`);
      if (url.hostname !== request.hostname || url.hash) rejected();
      const repoPath = `${binding.owner}/${binding.repo}`.toLowerCase();
      let action: ForgeAction;
      let graph:
        { query: string; variables: Record<string, unknown>; operationName?: string } | undefined;
      if (request.hostname === 'github.com') {
        const match = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
          url.pathname,
        );
        if (!match || `${match[1]}/${match[2]!.replace(/\.git$/, '')}`.toLowerCase() !== repoPath)
          rejected();
        const operation = match[3] === 'info/refs' ? url.searchParams.get('service') : match[3];
        if (
          (match[3] === 'info/refs' ? request.method !== 'GET' : request.method !== 'POST') ||
          (match[3] === 'info/refs'
            ? [...url.searchParams.keys()].some((key) => key !== 'service')
            : url.search !== '')
        )
          rejected();
        if (operation !== 'git-upload-pack' && operation !== 'git-receive-pack') rejected();
        action = operation === 'git-upload-pack' ? 'git-read' : 'git-write';
      } else if (request.hostname === 'api.github.com') {
        if (url.pathname === '/graphql' && request.method === 'POST' && !url.search) {
          const raw = JSON.parse(request.body?.toString('utf8') ?? '') as Record<string, unknown>;
          if (
            typeof raw.query !== 'string' ||
            (raw.variables !== undefined &&
              (raw.variables === null ||
                typeof raw.variables !== 'object' ||
                Array.isArray(raw.variables))) ||
            (raw.operationName !== undefined && typeof raw.operationName !== 'string')
          )
            rejected();
          graph = {
            query: raw.query,
            variables: (raw.variables ?? {}) as Record<string, unknown>,
            ...(typeof raw.operationName === 'string' ? { operationName: raw.operationName } : {}),
          };
          // Detailed GraphQL policy below checks every operation/root before minting.
          action = 'pulls-read';
        } else {
          const prefix = `/repos/${repoPath}`;
          const path = url.pathname.toLowerCase();
          if (path !== prefix && !path.startsWith(`${prefix}/`)) rejected();
          const suffix = path.slice(prefix.length);
          const read = request.method === 'GET';
          if (read && (suffix === '' || /^\/(branches|commits|compare)(\/[^/]+)?$/.test(suffix)))
            action = 'git-read';
          else if (
            /^\/issues(?:\/\d+)?(?:\/comments)?$/.test(suffix) ||
            /^\/issues\/comments\/\d+$/.test(suffix)
          )
            action = read ? 'issues-read' : 'issues-write';
          else if (/^\/pulls(?:\/\d+)?(?:\/(commits|files|merge))?$/.test(suffix))
            action = read ? 'pulls-read' : 'pulls-write';
          else rejected();
          if (!['GET', 'POST', 'PATCH', 'PUT'].includes(request.method)) rejected();
        }
      } else rejected();
      if (!graph) {
        assertAction(actions, action);
        if (request.hostname === 'api.github.com' && /\/issues(?:\/|$)/.test(url.pathname))
          assertAction(actions, request.method === 'GET' ? 'pulls-read' : 'pulls-write');
      }

      const verifyNode = async (
        id: unknown,
        type: string,
        token: string,
      ): Promise<'Issue' | 'PullRequest' | 'Repository'> => {
        if (typeof id !== 'string' || id.length === 0 || id.length > 256) rejected();
        const body = Buffer.from(
          JSON.stringify({
            query:
              'query($id:ID!){node(id:$id){__typename ... on Repository{nameWithOwner} ... on Issue{repository{nameWithOwner}} ... on PullRequest{repository{nameWithOwner}}}}',
            variables: { id },
          }),
        );
        const response = await options.transport({
          hostname: 'api.github.com',
          path: '/graphql',
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(body.length),
            'user-agent': 'verity-forge-broker',
            'accept-encoding': 'identity',
          },
          body,
          signal,
        });
        const result = (await collectJson(response)) as {
          errors?: unknown;
          data?: {
            node?: {
              __typename?: string;
              nameWithOwner?: string;
              repository?: { nameWithOwner?: string };
            };
          };
        };
        const node = result.data?.node;
        if (
          result.errors ||
          !node ||
          !['Issue', 'PullRequest', 'Repository'].includes(node.__typename ?? '') ||
          (type === 'IssueOrPullRequest'
            ? !['Issue', 'PullRequest'].includes(node.__typename ?? '')
            : node.__typename !== type) ||
          !sameRepo(
            node.__typename === 'Repository' ? node.nameWithOwner : node.repository?.nameWithOwner,
            binding,
          )
        )
          rejected();
        return node.__typename as 'Issue' | 'PullRequest' | 'Repository';
      };
      const pendingNodes: Array<{ id: unknown; type: string; comment: boolean }> = [];
      if (graph) {
        const document = parse(graph.query, { maxTokens: 10_000 });
        const operations = document.definitions.filter(
          (node) => node.kind === Kind.OPERATION_DEFINITION,
        );
        const operation = graph.operationName
          ? operations.find((node) => node.name?.value === graph.operationName)
          : operations.length === 1
            ? operations[0]
            : undefined;
        if (!operation || operation.operation === OperationTypeNode.SUBSCRIPTION) rejected();
        const fragments = new Map(
          document.definitions
            .filter((node) => node.kind === Kind.FRAGMENT_DEFINITION)
            .map((node) => [node.name.value, node.selectionSet]),
        );
        let expandedFields = 0;
        const fields = (set: SelectionSetNode, seen = new Set<string>()): FieldNode[] => {
          expandedFields += set.selections.length;
          if (expandedFields > 10_000) rejected();
          return set.selections.flatMap((node): FieldNode[] => {
            if (node.kind === Kind.FIELD) return [node];
            if (node.kind === Kind.INLINE_FRAGMENT) return fields(node.selectionSet, seen);
            if (seen.has(node.name.value)) rejected();
            const fragment = fragments.get(node.name.value);
            if (!fragment) rejected();
            return fields(fragment, new Set([...seen, node.name.value]));
          });
        };
        const argument = (field: FieldNode, name: string): unknown => {
          const arg = field.arguments?.find((entry) => entry.name.value === name);
          return arg ? valueFromASTUntyped(arg.value, graph.variables) : undefined;
        };
        const scalarFields = (
          set: SelectionSetNode | undefined,
          allowed: readonly string[],
        ): void => {
          if (
            !set ||
            fields(set).some((child) => !allowed.includes(child.name.value) || child.selectionSet)
          )
            rejected();
        };
        const metadataSelection = (node: FieldNode): void => {
          if (node.name.value === 'owner') {
            scalarFields(node.selectionSet, ['login', 'id', 'name', '__typename']);
          } else if (node.name.value === 'defaultBranchRef') {
            if (!node.selectionSet) rejected();
            for (const child of fields(node.selectionSet)) {
              if (child.name.value === 'target')
                scalarFields(child.selectionSet, ['oid', '__typename']);
              else if (
                !['name', 'prefix', 'id', '__typename'].includes(child.name.value) ||
                child.selectionSet
              )
                rejected();
            }
          } else if (node.selectionSet) rejected();
        };
        const roots = fields(operation.selectionSet);
        if (!roots.length || roots.length > 8) rejected();
        // Side channels such as search, organization, arbitrary nodes, and introspection
        // cannot inherit repository authority simply by sharing a GraphQL envelope.
        for (const field of roots) {
          const name = field.name.value;
          if (operation.operation === OperationTypeNode.QUERY) {
            if (name === 'repository') {
              if (
                !sameRepo(
                  `${String(argument(field, 'owner'))}/${String(argument(field, 'name'))}`,
                  binding,
                )
              )
                rejected();
              assertAction(actions, 'git-read');
              const allowed = new Set([
                ...REPOSITORY_METADATA_FIELDS,
                'parent',
                'issue',
                'issues',
                'issueOrPullRequest',
                'pullRequest',
                'pullRequests',
                'issueTypes',
              ]);
              if (
                !field.selectionSet ||
                fields(field.selectionSet).some((child) => !allowed.has(child.name.value))
              )
                rejected();
              const checkReads = (set: SelectionSetNode, depth = 0): void => {
                if (depth > 32) rejected();
                for (const child of fields(set)) {
                  if (child.name.value === 'issueOrPullRequest') {
                    assertAction(actions, 'issues-read');
                    assertAction(actions, 'pulls-read');
                  }
                  if (['issue', 'issues', 'issueTypes'].includes(child.name.value))
                    assertAction(actions, 'issues-read');
                  if (
                    ['pullRequest', 'pullRequests', 'associatedPullRequests'].includes(
                      child.name.value,
                    )
                  )
                    assertAction(actions, 'pulls-read');
                  if (child.selectionSet) checkReads(child.selectionSet, depth + 1);
                }
              };
              checkReads(field.selectionSet);
            } else if (name === '__type') {
              if (
                !['PullRequest', 'StatusCheckRollupContextConnection', 'WorkflowRun'].includes(
                  String(argument(field, 'name')),
                ) ||
                !field.selectionSet
              )
                rejected();
              for (const child of fields(field.selectionSet)) {
                if (
                  child.name.value !== 'fields' ||
                  !child.selectionSet ||
                  fields(child.selectionSet).some((entry) => entry.name.value !== 'name')
                )
                  rejected();
              }
              assertAction(actions, 'pulls-read');
              action = 'pulls-read';
            } else if (name === 'node') {
              if (
                !field.selectionSet ||
                fields(field.selectionSet).some(
                  (child) =>
                    ![
                      '__typename',
                      'id',
                      'viewerMergeHeadlineText',
                      'viewerMergeBodyText',
                    ].includes(child.name.value),
                )
              )
                rejected();
              assertAction(actions, 'pulls-read');
              pendingNodes.push({ id: argument(field, 'id'), type: 'PullRequest', comment: false });
              action = 'pulls-read';
            } else if (name === 'viewer') {
              if (
                !field.selectionSet ||
                fields(field.selectionSet).some(
                  (child) => !['login', 'id', '__typename'].includes(child.name.value),
                )
              )
                rejected();
              assertAction(actions, 'git-read');
            } else rejected();
          } else {
            const rule = MUTATIONS[name];
            if (!rule) rejected();
            const input = argument(field, 'input') as Record<string, unknown> | undefined;
            if (!input || typeof input !== 'object' || Array.isArray(input)) rejected();
            // Cross-repository references and actor changes require their own policies.
            if (
              Object.keys(input).some(
                (key) =>
                  /ids?$/i.test(key) &&
                  key !== rule.id &&
                  key !== 'clientMutationId' &&
                  key !== 'expectedHeadOid',
              )
            )
              rejected();
            if (
              input.expectedHeadOid !== undefined &&
              (typeof input.expectedHeadOid !== 'string' ||
                !/^[a-f0-9]{40}$/.test(input.expectedHeadOid))
            )
              rejected();
            // Mutation payloads return identifiers; they must not become an unrelated read channel.
            if (!field.selectionSet) rejected();
            for (const child of fields(field.selectionSet)) {
              if (['issue', 'pullRequest'].includes(child.name.value)) {
                scalarFields(child.selectionSet, ['id', 'url', 'number', '__typename']);
              } else if (child.name.value === 'commentEdge') {
                if (!child.selectionSet) rejected();
                for (const edge of fields(child.selectionSet)) {
                  if (edge.name.value === 'node')
                    scalarFields(edge.selectionSet, ['id', 'url', '__typename']);
                  else if (edge.name.value !== '__typename' || edge.selectionSet) rejected();
                }
              } else if (
                !['clientMutationId', '__typename'].includes(child.name.value) ||
                child.selectionSet
              )
                rejected();
            }
            assertAction(actions, rule.action);
            pendingNodes.push({
              id: input[rule.id],
              type: rule.type,
              comment: name === 'addComment',
            });
            action = rule.action;
          }
        }
        // Block nested cross-repository discovery surfaces, including fragment-hidden ones.
        visit(document, {
          Field(node) {
            if (['owner', 'defaultBranchRef'].includes(node.name.value)) metadataSelection(node);
            if (
              ['parent', 'headRepository', 'baseRepository'].includes(node.name.value) ||
              (node.name.value === 'repository' && !node.arguments?.length)
            ) {
              if (
                !node.selectionSet ||
                fields(node.selectionSet).some(
                  (child) => !REPOSITORY_METADATA_FIELDS.has(child.name.value),
                )
              )
                rejected();
              for (const child of fields(node.selectionSet)) metadataSelection(child);
            }
            if (
              node.name.value === 'repository' &&
              node.arguments?.length &&
              !sameRepo(
                `${String(argument(node, 'owner'))}/${String(argument(node, 'name'))}`,
                binding,
              )
            )
              rejected();
            if (['search', 'organization', 'repositories', '__schema'].includes(node.name.value))
              rejected();
          },
        });
      }
      const token = await options.mint(binding);
      if (!token || token.length > 4096 || /[\r\n]/.test(token)) rejected();
      for (const node of pendingNodes) {
        const type = await verifyNode(node.id, node.type, token);
        if (node.comment && type === 'PullRequest') {
          assertAction(actions, 'pulls-write');
          action = 'pulls-write';
        }
      }
      return {
        action,
        credentials: [
          { value: token, alias: 'FORGE_TOKEN' },
          ...(request.hostname === 'github.com'
            ? [{ value: `x-access-token:${token}`, alias: 'FORGE_GIT_CREDENTIAL' }]
            : []),
        ],
        authorization:
          request.hostname === 'github.com'
            ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
            : `Bearer ${token}`,
      };
    },
  };
}
