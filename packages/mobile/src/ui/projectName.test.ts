import { describe, expect, it } from 'vitest';
import { projectDisplayName, projectRepoRef } from './projectName.js';

describe('project names', () => {
  it('does not expose a local project as a GitHub repository coordinate', () => {
    const local = { owner: '__local__', repo: 'my-project', kind: 'local' as const };
    expect(projectDisplayName(local)).toBe('my-project');
    expect(projectRepoRef(local)).toBeUndefined();
  });

  it('keeps the owner/repo coordinate for GitHub projects', () => {
    const github = { owner: 'acme', repo: 'web', kind: 'github' as const };
    expect(projectDisplayName(github)).toBe('acme/web');
    expect(projectRepoRef(github)).toBe('acme/web');
  });
});
