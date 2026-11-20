import type { MockupSpec } from '../types';
import HomeGroups from './home';
import ProjectGroups from './project';
import DesktopGroups from './desktop';
export const sessionStabilitySpec: MockupSpec = {
  id: 'session-stability',
  title: 'Stable session lists',
  screens: {
    home: { title: 'Home', Component: HomeGroups },
    project: { title: 'verity', Component: ProjectGroups },
    desktop: { title: 'Home', Component: DesktopGroups },
  },
};
