// Every target `parseAppLink` can resolve must still be a screen in this app.
// The whitelist in @verity/mobile is a list of router paths, and nothing else
// ties it to the route files: renaming `settings/services/doppler.tsx` would
// leave the resolver happily producing a path Expo Router no longer serves, and
// a tapped chat link would land on "not found" without any test going red.
// The paths are derived from the resolver's own constants so a new entry is
// covered the moment it is added.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_LINK_PROJECT_SETTINGS_PAGES,
  APP_LINK_SETTINGS_ROUTES,
  parseAppLink,
} from '@verity/mobile';

const appDir = join(__dirname, '..', 'app');

function routeFileExists(routePath: string): boolean {
  const relative = routePath.replace(/^\//, '');
  return (
    existsSync(join(appDir, `${relative}.tsx`)) || existsSync(join(appDir, relative, 'index.tsx'))
  );
}

describe('app link whitelist', () => {
  it.each(APP_LINK_SETTINGS_ROUTES)('%s is a route file under app/', (routePath) => {
    expect(routeFileExists(routePath)).toBe(true);
  });

  it.each([null, ...APP_LINK_PROJECT_SETTINGS_PAGES])(
    'project settings page %s is a route file under app/project/[id]/',
    (page) => {
      const routePath = page === null ? '/project/[id]/settings' : `/project/[id]/settings/${page}`;
      expect(routeFileExists(routePath)).toBe(true);
    },
  );

  it('points the new-project link at the new-project screen', () => {
    expect(parseAppLink('verity://project/new')).toEqual({ kind: 'new-project' });
    expect(routeFileExists('/new-project')).toBe(true);
  });
});
