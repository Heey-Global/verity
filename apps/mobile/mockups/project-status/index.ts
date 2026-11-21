import type { MockupSpec } from '../types';
import Asleep from './asleep';
import ErrorScreen from './error';
import Running from './running';
import Starting from './starting';

export const projectStatusSpec: MockupSpec = {
  id: 'project-status',
  title: 'Project status on the project page',
  screens: {
    starting: { title: 'K8s', Component: Starting },
    asleep: { title: 'Heey Docs', Component: Asleep },
    error: { title: 'K8s', Component: ErrorScreen },
    running: { title: 'Kundenportal', Component: Running },
  },
};
