import type { MockupSpec } from '../types';
import HomeMockup from './home';
import SpecMockup from './spec';

/**
 * Spec with mockup approval, from the software factory concept: the spec as a
 * Home item and the spec itself with its sections and approval bar. Sample
 * content only; nothing here talks to a server.
 */
export const factorySpec: MockupSpec = {
  id: 'factory-spec',
  title: 'Spec with mockup approval',
  screens: {
    home: { title: 'Verity', Component: HomeMockup },
    spec: { title: 'Spec', Component: SpecMockup },
  },
};
