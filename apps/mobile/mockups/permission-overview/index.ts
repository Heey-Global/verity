import type { MockupSpec } from '../types';
import Desktop from './desktop';
import Phone from './phone';
import Project from './project';

export const permissionOverviewSpec: MockupSpec = {
  id: 'permission-overview',
  title: 'Readable permission requests',
  screens: {
    desktop: { title: 'Home', Component: Desktop },
    phone: { title: 'Home', Component: Phone },
    project: { title: 'Verity', Component: Project },
  },
};
