import type { MockupSpec } from '../types';
import HomeIpadMockup from './home-ipad';
import HomePhoneMockup from './home-phone';
import SharedKnowledgeMockup from './shared-knowledge';

/**
 * Home without Verity's header: the floating V is the one way to Verity, and a
 * quiet row at the end of Home opens Shared knowledge directly.
 */
export const homeVerityEntrySpec: MockupSpec = {
  id: 'home-verity-entry',
  title: 'Home without Verity header',
  screens: {
    'home-phone': { title: 'Home', Component: HomePhoneMockup },
    'home-ipad': { title: 'Verity', Component: HomeIpadMockup },
    'shared-knowledge': { title: 'Shared knowledge', Component: SharedKnowledgeMockup },
  },
};
