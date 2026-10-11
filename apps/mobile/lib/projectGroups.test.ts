import type { DevServer, ProjectRecord, SessionSummary } from '@verity/mobile';
import { projectGroups } from './projectGroups';

function project(id: string): ProjectRecord {
  return {
    id,
    owner: 'owner',
    repo: id,
    kind: 'github',
    containerName: id,
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '',
    updatedAt: '',
  };
}
function session(id: string, projectId?: string): SessionSummary {
  return {
    sessionId: id,
    ...(projectId ? { projectId } : {}),
    worktree: '/',
    model: 'test',
    name: id,
    status: 'idle',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    },
  };
}

it('retains groups, project snapshots and session arrays across identical project refreshes', () => {
  const projects = [project('p'), project('q')];
  const sessions = [session('a', 'p'), session('b', 'q')];
  const before = projectGroups(projects, sessions, new Map(), new Map(), null);
  const next = projectGroups(
    projects.map((value) => ({ ...value })),
    [...sessions],
    new Map(),
    new Map(),
    null,
    before,
  );
  expect(next).toBe(before);
  expect(next[0]?.project).toBe(projects[0]);
  expect(next[0]?.sessions).toBe(before[0]?.sessions);
});

it('updates only a changed session group and preserves repository props through project status changes', () => {
  const projects = [project('p'), project('q')];
  const sessions = [session('a', 'p'), session('b', 'q')];
  const before = projectGroups(projects, sessions, new Map(), new Map(), null);
  const changedSession = { ...sessions[0]!, usage: { ...sessions[0]!.usage, turns: 2 } };
  const next = projectGroups(
    projects,
    [changedSession, sessions[1]!],
    new Map(),
    new Map(),
    null,
    before,
  );
  expect(next[0]).not.toBe(before[0]);
  expect(next[0]?.sessions[0]).toBe(changedSession);
  expect(next[1]).toBe(before[1]);
  const changedProject = { ...projects[0]!, state: 'cloning' as const };
  const status = projectGroups(
    [changedProject, projects[1]!],
    [changedSession, sessions[1]!],
    new Map(),
    new Map(),
    null,
    next,
  );
  expect(status[0]?.project).toBe(changedProject);
  expect(status[0]?.status).not.toEqual(next[0]?.status);
  expect(status[0]?.sessions).toBe(next[0]?.sessions);
  expect(status[0]?.repo).toBe(next[0]?.repo);
  const renamed = projectGroups(
    [{ ...changedProject, repo: 'renamed' }, projects[1]!],
    [changedSession, sessions[1]!],
    new Map(),
    new Map(),
    null,
    status,
  );
  expect(renamed[0]?.repo).not.toBe(status[0]?.repo);
  expect(renamed[0]?.repo?.repo).toBe('renamed');
});

it('keeps nested project changes, optional removals and group membership observable', () => {
  const p = {
    ...project('p'),
    collapsed: true,
    toolkitDrift: { verdict: 'matches' as const, carrier: 'devcontainer' as const },
  };
  const defaultSession = session('default');
  const orphan = session('orphan', 'missing');
  const initial = projectGroups([p], [defaultSession, orphan], new Map(), new Map(), null);
  expect(initial.map((group) => group.id)).toEqual(['default', 'p', 'orphan:missing']);
  const { collapsed: _collapsed, ...expanded } = p;
  const changed = {
    ...expanded,
    toolkitDrift: { ...expanded.toolkitDrift, verdict: 'drifted' as const },
  };
  const next = projectGroups([changed], [orphan], new Map(), new Map(), null, initial);
  expect(next.map((group) => group.id)).toEqual(['p', 'orphan:missing']);
  expect(next[0]?.project?.collapsed).toBeUndefined();
  expect(next[0]?.project?.toolkitDrift?.verdict).toBe('drifted');
  expect(next[0]?.project).not.toBe(initial[1]?.project);
  expect(next[0]?.repo).toBe(initial[1]?.repo);
  expect(next[1]).toBe(initial[2]);
  const restored = projectGroups(
    [expanded, project('missing')],
    [orphan],
    new Map(),
    new Map(),
    null,
    next,
  );
  expect(restored.map((group) => group.id)).toEqual(['p', 'missing']);
  expect(restored[1]?.sessions).toEqual([orphan]);
});

it('publishes changed preview links without replacing unchanged session or repository props', () => {
  const p = project('p');
  const sessions = [session('a', 'p')];
  const server = { id: 'dev', running: true, hostPort: '3099', url: null } as DevServer;
  const before = projectGroups(
    [p],
    sessions,
    new Map([['p', [server]]]),
    new Map(),
    'https://first.example',
  );
  const next = projectGroups(
    [p],
    sessions,
    new Map([['p', [server]]]),
    new Map(),
    'https://second.example',
    before,
  );
  expect(next[0]?.portLinks[0]?.url).toBe('http://second.example:3099/');
  expect(next[0]?.portLinks).not.toBe(before[0]?.portLinks);
  expect(next[0]?.sessions).toBe(before[0]?.sessions);
  expect(next[0]?.repo).toBe(before[0]?.repo);
  const stopped = projectGroups(
    [p],
    sessions,
    new Map([['p', [{ ...server, running: false }]]]),
    new Map(),
    'https://second.example',
    next,
  );
  expect(stopped[0]?.portLinks).toEqual([]);
});
