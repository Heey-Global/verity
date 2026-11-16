import type { MockupSpec } from '../types';
import HomeGroups from './home';
import ProjectGroups from './project';
import DesktopGroups from './desktop';
export const sessionGroupsSpec: MockupSpec = {
  id: 'session-groups',
  title: 'Consistent session groups',
  screens: {
    home: { title: 'Home', Component: HomeGroups },
    project: { title: 'verity', Component: ProjectGroups },
    desktop: { title: 'verity', Component: DesktopGroups },
  },
};
