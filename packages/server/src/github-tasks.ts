import type { GitOutput } from './branches.js';
import {
  createGitHubIdentityResolver,
  makeTokenResolver,
  type GitHubIdentityResolver,
  type GitHubTokenSource,
  type HttpFetch,
} from './github.js';

/**
 * The task-management backend (ADR 0007). Tasks are GitHub issues; the planning layer
 * is a GitHub **Projects v2** board — drafts (the inbox), manual ordering (the rank)
 * and custom fields (Priority/Status). Projects v2 is GraphQL-only, so this module is
 * Verity's ONE sanctioned GraphQL surface.
 *
 * Access-pattern rule (AGENTS.md / ADR 0007): every call here is **user-initiated and
 * on-demand** — never a poll loop. PR/CI status stays on REST (`github.ts`). A board
 * read costs ~1 rate-limit point, so interactive use sits far inside the shared
 * 5000-points/hour GraphQL budget; do not reintroduce polling against it.
 *
 * Like the REST services this is best-effort: inert (returns `null`/`[]`/`false`)
 * without a resolvable token or a GitHub origin, and degrades rather than throwing on
 * any API error — a planning view that can't reach GitHub simply shows nothing.
 */

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

/** A single field-level GraphQL error (GitHub returns these alongside partial `data`). */
export interface GraphQLError {
  message: string;
}

/**
 * The outcome of one GraphQL request. `ok` reflects HTTP + transport success only: a
 * `200` can carry field-level `errors` next to a partial `data` (e.g. the org/user
 * probe below deliberately errors one branch), so callers interpret `data` and
 * `errors` themselves rather than treating any error as fatal.
 */
export interface GraphQLResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  errors?: GraphQLError[];
}

/** GraphQL auth + content headers. Unlike the REST helper this negotiates JSON, not
 *  `application/vnd.github+json`. The token is never logged. */
function graphqlHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'verity-server',
  };
}

/**
 * POST one GraphQL operation to GitHub. Never throws: a network error or non-2xx
 * degrades to `{ ok: false }`. On a 2xx it returns the parsed `data`/`errors` verbatim
 * so the caller can act on a partial result. Exported for direct use + testing.
 */
export async function githubGraphQL<T>(
  doFetch: HttpFetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
): Promise<GraphQLResult<T>> {
  try {
    const res = await doFetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: graphqlHeaders(token),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { data?: T; errors?: GraphQLError[] } | null;
    if (body === null || typeof body !== 'object') return { ok: false, status: res.status };
    const errors = Array.isArray(body.errors) ? body.errors : undefined;
    return {
      ok: true,
      status: res.status,
      ...(body.data !== undefined ? { data: body.data } : {}),
      ...(errors && errors.length > 0 ? { errors } : {}),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** The three content kinds a Projects v2 item can hold. A draft has no repo/number
 *  until it's converted into a real issue. */
export type TaskContentType = 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE';

/** One resolved custom-field value on a board item (e.g. `{ field: 'Priority', value: 'P1' }`).
 *  Single-select → the option name, number → its string form, text → the text, date → the date. */
export interface TaskFieldValue {
  field: string;
  value: string;
}

/** A single-select option (id + display name) available on a board field. */
export interface TaskFieldOption {
  id: string;
  name: string;
}

/** A board field DEFINITION (not a value): its node id, display name, and — for a
 *  single-select field like Priority/Status — the selectable options. `options` is
 *  empty for non-single-select fields (text/number/date/iteration); those aren't
 *  settable via {@link GitHubTaskService.setField} yet. */
export interface TaskField {
  id: string;
  name: string;
  options: TaskFieldOption[];
}

/**
 * One item on the board, flattened to what a planning UI needs. `id` is the
 * ProjectV2Item node id — the handle for reorder/convert. `contentId` is the
 * underlying Issue/PR/DraftIssue node id — the handle for `updateIssue` and as the
 * convert target. Drafts carry no `number`/`url` and a `null` `state`.
 */
export interface TaskItem {
  id: string;
  type: TaskContentType;
  number: number | null;
  title: string;
  body: string;
  url: string;
  state: string | null;
  contentId: string | null;
  fields: TaskFieldValue[];
}

/** A board read: the project handle, its items in stored order (index = rank), and its
 *  field definitions (so a UI/CLI can offer valid Priority/Status values). */
export interface TaskBoard {
  projectId: string;
  number: number;
  title: string;
  items: TaskItem[];
  fields: TaskField[];
}

export interface TaskRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubTaskServiceOptions {
  /** The repo whose `origin` remote identifies the GitHub owner (the board's owner). */
  repoDir: string;
  /** The Projects v2 board number under that owner (`github.com/orgs/<owner>/projects/<number>`). */
  projectNumber: number;
  /** GitHub token or token provider — see {@link GitHubTokenSource}. Used as the
   *  fallback when {@link GitHubTaskServiceOptions.asyncToken} is unset or yields
   *  undefined (deployments without App creds). */
  token?: GitHubTokenSource | undefined;
  /** Preferred token source: a dedicated least-privilege mint scoped to only what
   *  the task engine needs (`organization_projects` + `issues`), minted on demand
   *  (ADR 0007). Async because minting is a network call. Preferred over
   *  {@link GitHubTaskServiceOptions.token}; falls back to it when it yields
   *  undefined. */
  asyncToken?: ((repo?: TaskRepositoryRef) => Promise<string | undefined>) | undefined;
  /** Installation-wide task token for board-level operations. It is still bounded
   *  by the task permission subset, but not by one repository, so ProjectV2 reads
   *  can hydrate issue content from every repository the App installation covers. */
  asyncBoardToken?: (() => Promise<string | undefined>) | undefined;
  /** Injected git runner (tests); defaults to the real `git`. */
  git?: GitOutput;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Board-read cache TTL in ms (default 30s). Writes bypass it and invalidate on success. */
  ttlMs?: number;
  /** Per-request timeout in ms (default 10s) — an abort degrades to the inert result. */
  timeoutMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

/**
 * The task-management surface over a single repo's owner + Projects v2 board. Every
 * method is best-effort and never throws (ADR 0007). Reads return `null`/`[]`, writes
 * return `null`/`false`, when GitHub is unconfigured or unreachable.
 */
export interface GitHubTaskService {
  /** The board with its items in stored (rank) order. `null` when inert or on error;
   *  the last good board is served while a transient error clears (TTL-cached). */
  getBoard(): Promise<TaskBoard | null>;
  /** The origin repo's node id — required as `repositoryId` for {@link createIssue}
   *  and {@link convertDraftToIssue}. `null` when inert/unresolvable. */
  repositoryId(): Promise<string | null>;
  /** Resolve a SPECIFIC `owner/repo`'s node id — for filing a task's issue into a repo
   *  other than the origin (the repo picker). `null` when inert/unresolvable. */
  repositoryIdFor(input: { owner: string; repo: string }): Promise<string | null>;
  /** Add a draft item (the inbox capture) to the board. Returns the new item or `null`. */
  createDraft(input: { title: string; body?: string }): Promise<TaskItem | null>;
  /** Convert a draft item into a real issue in `repositoryId`, keeping it on the board. */
  convertDraftToIssue(input: {
    itemId: string;
    repositoryId: string;
    repo?: TaskRepositoryRef | undefined;
  }): Promise<{ itemId: string; number: number | null; url: string } | null>;
  /** Create an issue in `repositoryId` and add it to the board. Returns both node ids. */
  createIssue(input: {
    repositoryId: string;
    repo?: TaskRepositoryRef | undefined;
    title: string;
    body?: string;
  }): Promise<{
    issueId: string;
    itemId: string | null;
    number: number | null;
    url: string;
  } | null>;
  /** Edit an issue's title/body/state by its node id (`contentId`). Omitted fields are
   *  left unchanged. `true` on success. */
  updateIssue(input: {
    issueId: string;
    title?: string | undefined;
    body?: string | undefined;
    state?: ('OPEN' | 'CLOSED') | undefined;
  }): Promise<boolean>;
  /** Move `itemId` to sit right after `afterId` (null/omitted → to the top). `true` on success. */
  reorder(input: { itemId: string; afterId?: string | null }): Promise<boolean>;
  /** Remove a Projects v2 item from the board without deleting or closing its content. */
  removeItem(input: { itemId: string }): Promise<boolean>;
  /** Set a single-select field (e.g. Priority/Status) on an item by field + option NAME
   *  (case-insensitive; resolved against the board's field definitions). `false` when the
   *  field or option isn't found, the field isn't single-select, or the write fails. */
  setField(input: { itemId: string; field: string; option: string }): Promise<boolean>;
}

// --- GraphQL documents -------------------------------------------------------

// A repo's owner can be a User or an Organization; there's no single by-login field
// that returns the ProjectV2 owner interface. Probing BOTH in one request lets GitHub
// populate whichever matches and error the other (ignored) — one round trip, no
// owner-type config needed.
const BOARD_QUERY = `
query($owner:String!, $number:Int!, $after:String) {
  organization(login:$owner) { projectV2(number:$number) { ...proj } }
  user(login:$owner) { projectV2(number:$number) { ...proj } }
}
fragment proj on ProjectV2 {
  id
  number
  title
  fields(first: 30) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name }
      ... on ProjectV2SingleSelectField { options { id name } }
    }
  }
  items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      fieldValues(first: 20) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
        }
      }
      content {
        __typename
        ... on Issue { id number title body url state }
        ... on PullRequest { id number title body url state }
        ... on DraftIssue { id title body }
      }
    }
  }
}`;

const REPO_ID_QUERY = `
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) { id }
}`;

const CREATE_DRAFT_MUTATION = `
mutation($projectId:ID!, $title:String!, $body:String) {
  addProjectV2DraftIssue(input:{projectId:$projectId, title:$title, body:$body}) {
    projectItem {
      id
      content { __typename ... on DraftIssue { id title body } }
    }
  }
}`;

const CONVERT_DRAFT_MUTATION = `
mutation($itemId:ID!, $repositoryId:ID!) {
  convertProjectV2DraftIssueItemToIssue(input:{itemId:$itemId, repositoryId:$repositoryId}) {
    item { id content { ... on Issue { number url } } }
  }
}`;

const CREATE_ISSUE_MUTATION = `
mutation($repositoryId:ID!, $title:String!, $body:String) {
  createIssue(input:{repositoryId:$repositoryId, title:$title, body:$body}) {
    issue { id number url }
  }
}`;

const ADD_ITEM_MUTATION = `
mutation($projectId:ID!, $contentId:ID!) {
  addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {
    item { id }
  }
}`;

const UPDATE_ISSUE_MUTATION = `
mutation($id:ID!, $title:String, $body:String, $state:IssueState) {
  updateIssue(input:{id:$id, title:$title, body:$body, state:$state}) {
    issue { id }
  }
}`;

const REORDER_MUTATION = `
mutation($projectId:ID!, $itemId:ID!, $afterId:ID) {
  updateProjectV2ItemPosition(input:{projectId:$projectId, itemId:$itemId, afterId:$afterId}) {
    clientMutationId
  }
}`;

const DELETE_ITEM_MUTATION = `
mutation($projectId:ID!, $itemId:ID!) {
  deleteProjectV2Item(input:{projectId:$projectId, itemId:$itemId}) {
    deletedItemId
  }
}`;

const SET_FIELD_MUTATION = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input:{projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:{singleSelectOptionId:$optionId}}) {
    projectV2Item { id }
  }
}`;

// --- parsing -----------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

const CONTENT_TYPE: Record<string, TaskContentType> = {
  Issue: 'ISSUE',
  PullRequest: 'PULL_REQUEST',
  DraftIssue: 'DRAFT_ISSUE',
};

/** Map a raw fieldValues node to a {@link TaskFieldValue}, or null when it's an empty /
 *  unrecognized field-value kind (only the four fragmented kinds carry a value + name). */
function toFieldValue(raw: unknown): TaskFieldValue | null {
  const node = asRecord(raw);
  if (node === null) return null;
  const field = asRecord(node.field);
  const name = field?.name;
  if (typeof name !== 'string') return null;
  let value: string | null = null;
  if (typeof node.text === 'string') value = node.text;
  else if (typeof node.number === 'number') value = String(node.number);
  else if (typeof node.name === 'string')
    value = node.name; // single-select option
  else if (typeof node.date === 'string') value = node.date;
  if (value === null) return null;
  return { field: name, value };
}

/** Flatten a raw ProjectV2 item to a {@link TaskItem}, or null when it has no usable
 *  content (a redacted/unknown item is dropped rather than crashing the board). */
function toTaskItem(raw: unknown): TaskItem | null {
  const node = asRecord(raw);
  if (node === null) return null;
  const id = node.id;
  if (typeof id !== 'string') return null;
  const content = asRecord(node.content);
  const typename = content ? content.__typename : undefined;
  const type = typeof typename === 'string' ? CONTENT_TYPE[typename] : undefined;
  if (content === null || type === undefined) return null;

  const fieldNodes = asRecord(node.fieldValues)?.nodes;
  const fields = Array.isArray(fieldNodes)
    ? fieldNodes.map(toFieldValue).filter((f): f is TaskFieldValue => f !== null)
    : [];

  return {
    id,
    type,
    number: typeof content.number === 'number' ? content.number : null,
    title: typeof content.title === 'string' ? content.title : '',
    body: typeof content.body === 'string' ? content.body : '',
    url: typeof content.url === 'string' ? content.url : '',
    state: typeof content.state === 'string' ? content.state : null,
    contentId: typeof content.id === 'string' ? content.id : null,
    fields,
  };
}

/** Flatten a raw ProjectV2 field node to a {@link TaskField}, or null when it lacks a
 *  string id/name (a redacted/unknown field is dropped). Options are only present on
 *  single-select fields. */
function toField(raw: unknown): TaskField | null {
  const node = asRecord(raw);
  if (node === null) return null;
  const { id, name } = node;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  const options = Array.isArray(node.options)
    ? node.options
        .map(asRecord)
        .filter((o): o is Record<string, unknown> => o !== null)
        .filter((o) => typeof o.id === 'string' && typeof o.name === 'string')
        .map((o) => ({ id: o.id as string, name: o.name as string }))
    : [];
  return { id, name, options };
}

interface RawProject {
  id: unknown;
  number: unknown;
  title: unknown;
  items?: { nodes?: unknown };
  fields?: { nodes?: unknown };
}

/** Pick whichever of the org/user probe resolved to a project, and flatten it. */
function toBoard(data: unknown): TaskBoard | null {
  const root = asRecord(data);
  if (root === null) return null;
  const org = asRecord(root.organization);
  const usr = asRecord(root.user);
  const proj = (asRecord(org?.projectV2) ?? asRecord(usr?.projectV2)) as RawProject | null;
  if (proj === null) return null;
  if (typeof proj.id !== 'string' || typeof proj.number !== 'number') return null;
  const nodes = proj.items?.nodes;
  const items = Array.isArray(nodes)
    ? nodes.map(toTaskItem).filter((i): i is TaskItem => i !== null)
    : [];
  const fieldNodes = proj.fields?.nodes;
  const fields = Array.isArray(fieldNodes)
    ? fieldNodes.map(toField).filter((f): f is TaskField => f !== null)
    : [];
  return {
    projectId: proj.id,
    number: proj.number,
    title: typeof proj.title === 'string' ? proj.title : '',
    items,
    fields,
  };
}

function boardItemsPage(data: unknown): { hasNextPage: boolean; endCursor: string | null } | null {
  const root = asRecord(data);
  const org = asRecord(root?.organization);
  const usr = asRecord(root?.user);
  const project = asRecord(asRecord(org?.projectV2) ?? asRecord(usr?.projectV2));
  const items = asRecord(project?.items);
  const pageInfo = asRecord(items?.pageInfo);
  if (pageInfo === null || typeof pageInfo.hasNextPage !== 'boolean') return null;
  return {
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null,
  };
}

// --- service -----------------------------------------------------------------

export function createGitHubTaskService(opts: GitHubTaskServiceOptions): GitHubTaskService {
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? ((): number => Date.now());
  const projectNumber = opts.projectNumber;
  const resolveToken = makeTokenResolver(opts.token);
  const identity: GitHubIdentityResolver = createGitHubIdentityResolver(opts.repoDir, opts.git);

  let cache: { board: TaskBoard; at: number } | undefined;

  /** Resolve token + owner/repo up front; both are preconditions for any call.
   *  The dedicated least-privilege mint (asyncToken) is preferred; the shared sync
   *  token is the fallback when it's unset or yields undefined. asyncToken is a mint
   *  (a network call) that MAY reject; the service contract is never-throws, so a
   *  rejection degrades to the sync fallback rather than propagating as a 500. */
  const preflight = async (
    repo?: TaskRepositoryRef,
    tokenKind: 'repo' | 'board' = 'repo',
  ): Promise<{ token: string; owner: string; repo: string } | null> => {
    const id = await identity();
    if (id === null) return null;
    const tokenRepo = repo ?? id;
    const minted =
      tokenKind === 'board' && opts.asyncBoardToken !== undefined
        ? await opts.asyncBoardToken().catch(() => undefined)
        : undefined;
    const repoMinted =
      minted === undefined && opts.asyncToken
        ? await opts.asyncToken(tokenRepo).catch(() => undefined)
        : undefined;
    const token = minted ?? repoMinted ?? resolveToken();
    if (token === undefined) return null;
    return { token, owner: id.owner, repo: id.repo };
  };

  const run = <T>(query: string, variables: Record<string, unknown>, token: string) =>
    githubGraphQL<T>(doFetch, token, query, variables, timeoutMs);

  return {
    async getBoard(): Promise<TaskBoard | null> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return null;
      if (cache !== undefined && now() - cache.at < ttlMs) return cache.board;
      let cursor: string | null = null;
      let board: TaskBoard | null = null;
      for (let page = 0; page < 100; page += 1) {
        const res = await run<unknown>(
          BOARD_QUERY,
          { owner: pre.owner, number: projectNumber, after: cursor },
          pre.token,
        );
        if (!res.ok) return cache?.board ?? null;
        const next = toBoard(res.data);
        if (next === null) return cache?.board ?? null;
        if (board === null) board = next;
        else {
          board.items.push(...next.items);
          board.fields = next.fields;
        }
        const pagination = boardItemsPage(res.data);
        if (pagination === null || !pagination.hasNextPage) break;
        if (pagination.endCursor === null || pagination.endCursor === cursor) {
          return cache?.board ?? null;
        }
        cursor = pagination.endCursor;
        if (page === 99) return cache?.board ?? null;
      }
      if (board === null) return cache?.board ?? null; // board/owner not found — don't cache a miss
      cache = { board, at: now() };
      return board;
    },

    async repositoryId(): Promise<string | null> {
      const pre = await preflight();
      if (pre === null) return null;
      return this.repositoryIdFor({ owner: pre.owner, repo: pre.repo });
    },

    async repositoryIdFor(input): Promise<string | null> {
      const pre = await preflight(input);
      if (pre === null) return null;
      const res = await run<{ repository?: { id?: unknown } | null }>(
        REPO_ID_QUERY,
        { owner: input.owner, name: input.repo },
        pre.token,
      );
      const id = res.data?.repository?.id;
      return typeof id === 'string' ? id : null;
    },

    async createDraft(input): Promise<TaskItem | null> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return null;
      const board = await this.getBoard();
      if (board === null) return null;
      const res = await run<{ addProjectV2DraftIssue?: { projectItem?: unknown } }>(
        CREATE_DRAFT_MUTATION,
        { projectId: board.projectId, title: input.title, body: input.body ?? '' },
        pre.token,
      );
      if (!res.ok) return null;
      cache = undefined; // the board changed
      const item = toTaskItem(res.data?.addProjectV2DraftIssue?.projectItem);
      // The mutation returns a draft item with no `type`-bearing content in the same
      // shape; toTaskItem covers DraftIssue content, so a null here means the write
      // failed (errors present) — surface null rather than a fabricated item.
      return item;
    },

    async convertDraftToIssue(
      input,
    ): Promise<{ itemId: string; number: number | null; url: string } | null> {
      const pre = await preflight(input.repo);
      if (pre === null) return null;
      const res = await run<{
        convertProjectV2DraftIssueItemToIssue?: {
          item?: { id?: unknown; content?: { number?: unknown; url?: unknown } | null };
        };
      }>(
        CONVERT_DRAFT_MUTATION,
        { itemId: input.itemId, repositoryId: input.repositoryId },
        pre.token,
      );
      const item = res.data?.convertProjectV2DraftIssueItemToIssue?.item;
      if (!res.ok || typeof item?.id !== 'string') return null;
      cache = undefined;
      return {
        itemId: item.id,
        number: typeof item.content?.number === 'number' ? item.content.number : null,
        url: typeof item.content?.url === 'string' ? item.content.url : '',
      };
    },

    async createIssue(input): Promise<{
      issueId: string;
      itemId: string | null;
      number: number | null;
      url: string;
    } | null> {
      const issuePre = await preflight(input.repo);
      if (issuePre === null) return null;
      const boardPre = await preflight(undefined, 'board');
      if (boardPre === null) return null;
      const board = await this.getBoard();
      if (board === null) return null;
      const created = await run<{
        createIssue?: { issue?: { id?: unknown; number?: unknown; url?: unknown } | null };
      }>(
        CREATE_ISSUE_MUTATION,
        { repositoryId: input.repositoryId, title: input.title, body: input.body ?? '' },
        issuePre.token,
      );
      const issue = created.data?.createIssue?.issue;
      if (!created.ok || typeof issue?.id !== 'string') return null;
      // Best-effort add to the board — the issue exists regardless; a failed add just
      // leaves it off the board (still returned so the caller can retry the add).
      const added = await run<{ addProjectV2ItemById?: { item?: { id?: unknown } } }>(
        ADD_ITEM_MUTATION,
        { projectId: board.projectId, contentId: issue.id },
        boardPre.token,
      );
      cache = undefined;
      const itemId = added.data?.addProjectV2ItemById?.item?.id;
      return {
        issueId: issue.id,
        itemId: typeof itemId === 'string' ? itemId : null,
        number: typeof issue.number === 'number' ? issue.number : null,
        url: typeof issue.url === 'string' ? issue.url : '',
      };
    },

    async updateIssue(input): Promise<boolean> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return false;
      const res = await run<{ updateIssue?: { issue?: { id?: unknown } | null } }>(
        UPDATE_ISSUE_MUTATION,
        {
          id: input.issueId,
          title: input.title ?? null,
          body: input.body ?? null,
          state: input.state ?? null,
        },
        pre.token,
      );
      const okWrite = res.ok && typeof res.data?.updateIssue?.issue?.id === 'string';
      if (okWrite) cache = undefined;
      return okWrite;
    },

    async reorder(input): Promise<boolean> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return false;
      const board = await this.getBoard();
      if (board === null) return false;
      const res = await run<{ updateProjectV2ItemPosition?: unknown }>(
        REORDER_MUTATION,
        { projectId: board.projectId, itemId: input.itemId, afterId: input.afterId ?? null },
        pre.token,
      );
      const okWrite = res.ok && res.errors === undefined;
      if (okWrite) cache = undefined;
      return okWrite;
    },

    async removeItem(input): Promise<boolean> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return false;
      const board = await this.getBoard();
      if (board === null) return false;
      const res = await run<{ deleteProjectV2Item?: { deletedItemId?: unknown } }>(
        DELETE_ITEM_MUTATION,
        { projectId: board.projectId, itemId: input.itemId },
        pre.token,
      );
      const okWrite = res.ok && res.data?.deleteProjectV2Item?.deletedItemId === input.itemId;
      if (okWrite) cache = undefined;
      return okWrite;
    },

    async setField(input): Promise<boolean> {
      const pre = await preflight(undefined, 'board');
      if (pre === null) return false;
      const board = await this.getBoard();
      if (board === null) return false;
      // Resolve field + option by NAME (case-insensitive) against the board's definitions.
      const wantField = input.field.trim().toLowerCase();
      const field = board.fields.find((f) => f.name.toLowerCase() === wantField);
      if (field === undefined) return false;
      const wantOption = input.option.trim().toLowerCase();
      const option = field.options.find((o) => o.name.toLowerCase() === wantOption);
      if (option === undefined) return false; // unknown option, or a non-single-select field
      const res = await run<{
        updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: unknown } };
      }>(
        SET_FIELD_MUTATION,
        {
          projectId: board.projectId,
          itemId: input.itemId,
          fieldId: field.id,
          optionId: option.id,
        },
        pre.token,
      );
      const okWrite =
        res.ok && typeof res.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id === 'string';
      if (okWrite) cache = undefined;
      return okWrite;
    },
  };
}
