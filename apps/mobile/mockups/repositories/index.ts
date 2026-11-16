import type { MockupSpec } from '../types';
import FixSheet from './fix-sheet';
import MergeConfirm from './merge-confirm';
import MergeSheet from './merge-sheet';
import Multiple from './multiple';
import Project from './project';
import Single from './single';

export const repositoriesSpec: MockupSpec = {
  id: 'repositories',
  title: 'Repositories with pull requests',
  screens: {
    project: { title: 'verity', Component: Project },
    single: { title: 'Repositories', Component: Single },
    multiple: { title: 'Repositories', Component: Multiple },
    'fix-sheet': { title: 'Repositories', Component: FixSheet },
    'merge-sheet': { title: 'Repositories', Component: MergeSheet },
    'merge-confirm': { title: 'Repositories', Component: MergeConfirm },
  },
};
