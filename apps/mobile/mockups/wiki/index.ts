import type { MockupSpec } from '../types';
import HomeMockup from './home';
import HomeScrolledMockup from './home-scrolled';
import MaintenanceMockup from './maintenance';
import PageMockup from './page';

/**
 * The project Wiki as maintained knowledge: its start page, one page with
 * working links, and what a maintenance run reports on the project page.
 * Sample content only; nothing here talks to a server.
 */
export const wikiSpec: MockupSpec = {
  id: 'wiki',
  title: 'Maintained project Wiki',
  screens: {
    home: { title: 'Wiki', Component: HomeMockup },
    'home-scrolled': { title: 'Wiki', Component: HomeScrolledMockup },
    page: { title: 'Navigation concept', Component: PageMockup },
    maintenance: { title: 'verity', Component: MaintenanceMockup },
  },
};
