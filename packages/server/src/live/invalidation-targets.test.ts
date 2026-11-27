import { describe, expect, it } from 'vitest';
import { ALL_PROJECTS, invalidatedBranches, invalidatedProject } from './invalidation-targets.js';

describe('invalidatedProject', () => {
  it('names the project of its routes and their subresources', () => {
    expect(invalidatedProject('/projects/p%201')).toBe('p 1');
    expect(invalidatedProject('/projects/p1/settings?x=1')).toBe('p1');
    expect(invalidatedProject('/projects/p1/qa')).toBe('p1');
  });

  it('names the whole list for a reorder or a new project', () => {
    expect(invalidatedProject('/projects')).toBe(ALL_PROJECTS);
    expect(invalidatedProject('/projects/order')).toBe(ALL_PROJECTS);
  });

  it('leaves out what the project routes do not show, and other collections', () => {
    expect(invalidatedProject('/projects/p1/knowledge/proposals')).toBeUndefined();
    expect(invalidatedProject('/projects/p1/vulnerability-scan')).toBeUndefined();
    expect(invalidatedProject('/sessions/s1')).toBeUndefined();
    expect(invalidatedProject('/projects/%E0')).toBeUndefined();
  });
});

describe('invalidatedBranches', () => {
  // Mirrors the resource observer: a write of these families never changed
  // the branch list, and reading it again for each would cost every open
  // session a request per read marker or permission decision.
  it('names the session for writes that may change its branch list', () => {
    expect(invalidatedBranches('/sessions/s1/branches')).toBe('s1');
    expect(invalidatedBranches('/sessions/s1/merge')).toBe('s1');
    expect(invalidatedBranches('/sessions/s1')).toBe('s1');
  });

  it('leaves out writes that cannot, and the session list', () => {
    for (const family of ['seen', 'permissions', 'queue', 'activity', 'links'])
      expect(invalidatedBranches(`/sessions/s1/${family}`)).toBeUndefined();
    expect(invalidatedBranches('/sessions')).toBeUndefined();
    expect(invalidatedBranches('/projects/p1')).toBeUndefined();
  });
});
