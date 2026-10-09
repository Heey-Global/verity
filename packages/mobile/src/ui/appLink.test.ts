import { describe, expect, it } from 'vitest';
import {
  APP_LINK_PROJECT_SETTINGS_PAGES,
  APP_LINK_SETTINGS_ROUTES,
  parseAppLink,
} from './appLink.js';

describe('parseAppLink', () => {
  it('resolves every whitelisted settings screen to its router path', () => {
    for (const path of APP_LINK_SETTINGS_ROUTES) {
      expect(parseAppLink(`verity:/${path}`)).toEqual({ kind: 'route', path });
    }
  });

  it('resolves the project settings index and each sub-page of the current project', () => {
    expect(parseAppLink('verity://project/settings')).toEqual({
      kind: 'project-settings',
      page: null,
    });
    for (const page of APP_LINK_PROJECT_SETTINGS_PAGES) {
      expect(parseAppLink(`verity://project/settings/${page}`)).toEqual({
        kind: 'project-settings',
        page,
      });
    }
  });

  it('resolves the session sheets and the new-project screen', () => {
    expect(parseAppLink('verity://session/preview')).toEqual({ kind: 'preview' });
    expect(parseAppLink('verity://session/files')).toEqual({ kind: 'files', root: 'worktree' });
    expect(parseAppLink('verity://project/knowledge')).toEqual({
      kind: 'files',
      root: 'knowledge',
    });
    expect(parseAppLink('verity://project/new')).toEqual({ kind: 'new-project' });
  });

  it('accepts the Connections path for GitHub and Google as an alias of their screens', () => {
    expect(parseAppLink('verity://settings/services/github')).toEqual({
      kind: 'route',
      path: '/settings/github',
    });
    expect(parseAppLink('verity://settings/services/google')).toEqual({
      kind: 'route',
      path: '/settings/google',
    });
  });

  it('ignores case, surrounding whitespace, a trailing slash, a query string and a fragment', () => {
    expect(parseAppLink(' Verity://Settings/Services/Doppler/ ')).toEqual({
      kind: 'route',
      path: '/settings/services/doppler',
    });
    expect(parseAppLink('verity://settings?from=chat#top')).toEqual({
      kind: 'route',
      path: '/settings',
    });
  });

  // The whitelist is the whole point: a path the agent invents must not open
  // anything, and in particular must not reach another project or session.
  it('rejects paths outside the whitelist', () => {
    for (const url of [
      'verity://',
      'verity://foo',
      'verity://settings/unknown',
      'verity://settings/live-meeting-stt',
      'verity://settings/services/doppler/extra',
      'verity://project',
      'verity://project/settings/unknown',
      'verity://project/settings/github/extra',
      'verity://project/abc123/settings',
      'verity://session',
      'verity://session/abc123',
      'verity://session/settings',
      'verity://session/preview/extra',
      'verity://new-project',
    ]) {
      expect(parseAppLink(url), url).toBeNull();
    }
  });

  it('rejects traversal segments even when the rest would match', () => {
    expect(parseAppLink('verity://settings/../settings')).toBeNull();
    expect(parseAppLink('verity://settings/./github')).toBeNull();
  });

  it('leaves other schemes and plain paths alone', () => {
    for (const url of [
      'https://verity.build/settings',
      'verity:settings',
      'verity-staging://settings',
      '/settings',
      'settings/github',
      'file:///work/.verity-sessions/a/README.md',
    ]) {
      expect(parseAppLink(url), url).toBeNull();
    }
  });
});
