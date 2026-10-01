import { describe, expect, it } from 'vitest';
import { githubReleases as releases } from './__fixtures__/githubReleases.js';
import { serverReleaseNotes } from './releaseNotes.js';

describe('serverReleaseNotes', () => {
  it('lists the target release without commit links, scopes or markdown', () => {
    const notes = serverReleaseNotes(releases, '4.1.1', '4.2.0');

    expect(notes?.sections.map((section) => section.title)).toEqual(['New']);
    expect(notes?.sections[0]?.items).toContain(
      'Add session Calendar and Contacts with incremental consent',
    );
    for (const item of notes?.sections.flatMap((section) => section.items) ?? []) {
      expect(item).not.toMatch(/[[\]()*#]|https?:/);
    }
    expect(notes?.url).toBe('https://github.com/Heey-Global/verity/releases/tag/v4.2.0');
  });

  // A skipped release ships with the update, so leaving it out would hide the
  // changes an operator is about to receive.
  it('includes every release skipped since the running version', () => {
    const notes = serverReleaseNotes(releases, '4.0.1', '4.2.0');
    const items = notes?.sections.flatMap((section) => section.items) ?? [];

    expect(notes?.sections.map((section) => section.title)).toEqual(['New', 'Fixes']);
    expect(items).toContain('Accept PIN from share URL query'); // 4.1.0
    expect(items).toContain(
      'Report a server update the Updater accepted instead of a failed start',
    ); // 4.1.1
  });

  it('leaves out releases the Server already runs', () => {
    const items =
      serverReleaseNotes(releases, '4.1.0', '4.2.0')?.sections.flatMap(
        (section) => section.items,
      ) ?? [];

    expect(items).not.toContain('Accept PIN from share URL query');
  });

  it('drops dependency bumps', () => {
    const items =
      serverReleaseNotes(releases, '4.0.1', '4.1.0')?.sections.flatMap(
        (section) => section.items,
      ) ?? [];

    expect(items.some((item) => /sharp/.test(item))).toBe(false);
    expect(items).toContain('Keep mobile fixtures out of server releases');
  });

  // An unknown starting point must not turn into a guessed range that lists
  // changes the Server already has.
  it('shows only the target release when the running version is unusable', () => {
    for (const running of [undefined, '4.1.1-dev', 'dev']) {
      const items =
        serverReleaseNotes(releases, running, '4.2.0')?.sections.flatMap(
          (section) => section.items,
        ) ?? [];
      expect(items).not.toContain('Accept PIN from share URL query');
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it('ignores drafts, prereleases and other release trains', () => {
    const extra = [
      { tag_name: 'v4.1.5', draft: true, body: '### Features\n\n* draft only' },
      { tag_name: 'v4.1.6', prerelease: true, body: '### Features\n\n* pre only' },
      { tag_name: 'mobile-v4.1.7', body: '### Features\n\n* mobile only' },
    ];
    const items =
      serverReleaseNotes([...extra, ...releases], '4.1.1', '4.2.0')?.sections.flatMap(
        (section) => section.items,
      ) ?? [];

    expect(items.filter((item) => /only$/.test(item))).toEqual([]);
  });

  // The link is opened without asking, so it must not be whatever GitHub — or
  // anything answering in its place — chose to put there.
  it('links only to this repository’s release page', () => {
    const hostile = releases.map((release) =>
      (release as { tag_name: string }).tag_name === 'v4.2.0'
        ? { ...(release as object), html_url: 'intent://evil' }
        : release,
    );

    expect(serverReleaseNotes(hostile, '4.1.1', '4.2.0')?.url).toBe(
      'https://github.com/Heey-Global/verity/releases/tag/v4.2.0',
    );
    expect(serverReleaseNotes(releases, '4.1.1', 'v4.2.0')?.url).toBe(
      'https://github.com/Heey-Global/verity/releases/tag/v4.2.0',
    );
  });

  it('returns null rather than an empty section for nothing readable', () => {
    expect(serverReleaseNotes(releases, '4.2.0', '4.2.0')).toBeNull();
    expect(serverReleaseNotes({ message: 'API rate limit exceeded' }, '4.1.1', '4.2.0')).toBeNull();
    expect(serverReleaseNotes(releases, '4.1.1', 'not-a-version')).toBeNull();
  });
});
