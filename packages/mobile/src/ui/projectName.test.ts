import { describe, expect, it } from 'vitest';
import { projectDisplayName, projectRepoRef, projectTitle } from './projectName.js';

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

  it('names a project by its own name, whatever repository is behind it', () => {
    // The repository reference still comes from the repository, never the name.
    const github = {
      name: 'Verity Plattform',
      owner: 'acme',
      repo: 'web',
      kind: 'github' as const,
    };
    expect(projectDisplayName(github)).toBe('Verity Plattform');
    expect(projectRepoRef(github)).toBe('acme/web');
    const local = {
      name: 'Kundenportal',
      owner: '__local__',
      repo: 'kundenportal',
      kind: 'local' as const,
    };
    expect(projectDisplayName(local)).toBe('Kundenportal');
  });

  it('titles a project by its name, and by its repository on a server without names', () => {
    expect(projectTitle({ name: 'Verity Plattform', repo: 'verity' })).toBe('Verity Plattform');
    expect(projectTitle({ repo: 'verity' })).toBe('verity');
  });
});
