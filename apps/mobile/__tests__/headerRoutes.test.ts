import { showsMessageSearch } from '../lib/headerRoutes';

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
