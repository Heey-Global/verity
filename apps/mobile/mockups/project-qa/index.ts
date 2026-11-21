import type { MockupSpec } from '../types';
import Chat from './chat';
import Home from './home';
import Issue from './issue';
import Issues from './issues';
import Project from './project';
import ProjectSettings from './project-settings';
import RowStates from './row-states';
import SystemSettings from './system-settings';

export const projectQASpec: MockupSpec = {
  id: 'project-qa',
  title: 'Project QA',
  screens: {
    project: { title: 'website', Component: Project },
    'row-states': { title: 'QA row states', Component: RowStates },
    issues: { title: 'QA · website', Component: Issues },
    chat: { title: 'QA · website', Component: Chat },
    issue: { title: 'Renovate PR #88', Component: Issue },
    home: { title: 'Home', Component: Home },
    'system-settings': { title: 'QA', Component: SystemSettings },
    'project-settings': { title: 'Project settings', Component: ProjectSettings },
  },
};
