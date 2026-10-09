import { existsSync, readFileSync } from 'node:fs';
import { APP_HELP_TOPICS } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { parseAppLink } from './appLink.js';

// The help catalog lives in @verity/events and the link whitelist here, so
// nothing ties the two together at compile time. A catalog link the app does
// not resolve still reaches the agent, which hands it to the user as a link
// that renders as dead text.
describe('app help catalog links', () => {
  it.each(APP_HELP_TOPICS.filter((topic) => topic.appLink !== undefined))(
    '$id links to a target the app can open',
    (topic) => {
      expect(parseAppLink(topic.appLink ?? '')).not.toBeNull();
    },
  );

  // A connection added to the Connections screen without a catalog entry leaves
  // the agent unable to explain it. The routes are read from the screen itself,
  // so a new row is covered the moment it is added.
  it('covers every service on the Connections screen', () => {
    const source = readFileSync(
      new URL('../../../../apps/mobile/app/settings/services/index.tsx', import.meta.url),
      'utf8',
    );
    const routes = [
      ...source.matchAll(/route: '([^']+)'/g),
      ...source.matchAll(/router\.push\('([^']+)'\)/g),
    ].map((match) => match[1]);
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const covered = new Set(
      APP_HELP_TOPICS.map((topic) => parseAppLink(topic.appLink ?? ''))
        .filter((target) => target?.kind === 'route')
        .map((target) => (target?.kind === 'route' ? target.path : '')),
    );
    for (const route of routes) expect(covered, route).toContain(route);
  });
});

// The docs are only readable as GitHub blob URLs, so a moved or renamed file
// turns every answer that cites it into a 404 the agent hands to the user. The
// check lives here because the catalog's own package compiles without Node types.
describe('app help catalog docs', () => {
  it.each(APP_HELP_TOPICS.filter((topic) => topic.docsPath !== undefined))(
    '$id cites a file that exists in the repository',
    (topic) => {
      expect(existsSync(new URL(`../../../../${topic.docsPath ?? ''}`, import.meta.url))).toBe(
        true,
      );
    },
  );
});
