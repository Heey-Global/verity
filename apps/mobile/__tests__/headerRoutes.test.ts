import { showsMessageSearch, usesExpandedHeaderTitle } from '../lib/headerRoutes';

describe('showsMessageSearch', () => {
  it('shows search for a native session header even when the pathname is stale', () => {
    expect(showsMessageSearch('session/[id]')).toBe(true);
  });

  it('shows search on the overview', () => {
    expect(showsMessageSearch('index')).toBe(true);
  });

  it('keeps search hidden on unrelated routes', () => {
    expect(showsMessageSearch('settings')).toBe(false);
  });
});

describe('usesExpandedHeaderTitle', () => {
  it.each(['project/[id]/vulnerability-scan', 'project/[id]/settings/index', 'settings'])(
    'reserves more title space and a compact back button for %s',
    (route) => expect(usesExpandedHeaderTitle(route)).toBe(true),
  );

  it.each(['index', 'session/[id]', 'project/[id]/index'])(
    'keeps the existing header proportions for %s',
    (route) => expect(usesExpandedHeaderTitle(route)).toBe(false),
  );
});
