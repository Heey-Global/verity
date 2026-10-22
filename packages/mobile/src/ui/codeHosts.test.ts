import { describe, expect, it } from 'vitest';
import type { ForgeConnection } from '../api.js';
import {
  codeHostForProject,
  connectedCodeHosts,
  preferredCodeHost,
  repositoryWebUrl,
} from './codeHosts.js';

const legacyGithub: ForgeConnection = {
  id: 'legacy-github',
  provider: 'github',
  baseUrl: 'https://github.com',
  label: 'GitHub',
};
const team: ForgeConnection = {
  id: 'forgejo-team',
  provider: 'forgejo',
  baseUrl: 'https://git.example.org',
  label: 'Team',
};

function hosts(github: boolean, forgejo: boolean, forProjects = false, available = true) {
  return connectedCodeHosts(
    {
      githubConnected: github,
      connections: {
        connections: [...(github ? [legacyGithub] : []), ...(forgejo ? [team] : [])],
        forgejoProjectsAvailable: available,
      },
    },
    { forProjects },
  ).map((host) => host.title);
}

describe('connectedCodeHosts', () => {
  // The four setups the UI must render: each one hides or offers a provider.
  it.each([
    ['GitHub only', true, false, ['GitHub']],
    ['Forgejo only', false, true, ['Forgejo']],
    ['both', true, true, ['GitHub', 'Forgejo']],
    ['none', false, false, []],
  ] as const)('%s', (_name, github, forgejo, expected) => {
    expect(hosts(github, forgejo)).toEqual(expected);
    expect(hosts(github, forgejo, true)).toEqual(expected);
  });

  it('never derives GitHub from the connection row alone', () => {
    // `legacy-github` can outlive a disconnect for a moment; Settings decide.
    expect(
      connectedCodeHosts({
        githubConnected: false,
        connections: { connections: [legacyGithub], forgejoProjectsAvailable: true },
      }),
    ).toEqual([]);
  });

  it('hides Forgejo from project pickers when the server cannot run it', () => {
    expect(hosts(true, true, false, false)).toEqual(['GitHub', 'Forgejo']);
    expect(hosts(true, true, true, false)).toEqual(['GitHub']);
  });

  it('falls back to GitHub alone when connections are unavailable', () => {
    expect(
      connectedCodeHosts({ githubConnected: true, connections: null }).map((h) => h.id),
    ).toEqual(['legacy-github']);
  });

  it('offers one Forgejo instance and shows its path prefix', () => {
    // The server may hold several; the app must still render a single Forgejo row.
    const hosts = connectedCodeHosts({
      githubConnected: false,
      connections: {
        connections: [
          { ...team, baseUrl: 'https://example.org/git/' },
          { ...team, id: 'second', baseUrl: 'https://second.test' },
        ],
        forgejoProjectsAvailable: true,
      },
    });
    expect(hosts).toEqual([
      expect.objectContaining({ id: team.id, title: 'Forgejo', host: 'example.org/git' }),
    ]);
  });
});

describe('preferredCodeHost', () => {
  const list = connectedCodeHosts({
    githubConnected: true,
    connections: { connections: [team], forgejoProjectsAvailable: true },
  });
  it('keeps the remembered host and otherwise picks the first', () => {
    expect(preferredCodeHost(list, 'forgejo-team')?.id).toBe('forgejo-team');
    expect(preferredCodeHost(list, 'removed')?.id).toBe('legacy-github');
    expect(preferredCodeHost([], 'forgejo-team')).toBeUndefined();
  });
});

describe('project code hosts', () => {
  it('resolves the Forgejo instance and its repository URL', () => {
    const host = codeHostForProject({ kind: 'forgejo', forgeConnectionId: team.id }, [team]);
    expect(host?.title).toBe('Forgejo');
    expect(repositoryWebUrl(host!, 'team', 'website')).toBe('https://git.example.org/team/website');
    expect(codeHostForProject({ kind: 'forgejo', forgeConnectionId: 'gone' }, [team])).toBe(
      undefined,
    );
    expect(codeHostForProject({ kind: 'local' }, [team])).toBeUndefined();
    expect(codeHostForProject({ kind: 'github' }, null)?.baseUrl).toBe('https://github.com');
  });
});
