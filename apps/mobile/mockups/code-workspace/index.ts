import type { MockupSpec } from '../types';
import Restoring from './restoring';
import Unavailable from './unavailable';

export const codeWorkspaceSpec: MockupSpec = {
  id: 'code-workspace',
  title: 'Code workspace recovery',
  screens: {
    unavailable: { title: 'Website relaunch', Component: Unavailable },
    restoring: { title: 'Website relaunch', Component: Restoring },
  },
};
