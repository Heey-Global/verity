import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('authorizes every mobile bundle for HTTPS callbacks and credentials', () => {
  const config = readFileSync('apps/mobile/app.config.ts', 'utf8');
  const identifiers = config.match(/bundleIdentifier: staging \? '([^']+)' : '([^']+)'/);
  expect(identifiers).not.toBeNull();
  const association = JSON.parse(
    readFileSync('docs/website/site/apple-app-site-association.json', 'utf8'),
  ) as {
    applinks: { details: { appIDs: string[]; components: { '/': string }[] }[] };
    webcredentials: { apps: string[] };
  };
  // Missing a variant silently strands HTTPS auth callbacks in the browser.
  for (const bundle of identifiers!.slice(1)) {
    const appId = '__APPLE_TEAM_ID__.' + bundle;
    expect(association.webcredentials.apps).toContain(appId);
    for (const callback of ['/github/app/callback', '/mcp/oauth/callback'])
      expect(
        association.applinks.details.some(
          (entry) =>
            entry.appIDs.includes(appId) &&
            entry.components.some((component) => component['/'] === callback),
        ),
      ).toBe(true);
  }
});
