import type { MockupSpec } from '../types';
import Blocked from './blocked';
import Scheduled from './scheduled';
import Recovery from './recovery';
export const sandboxUpdatesSpec: MockupSpec = {
  id: 'sandbox-updates',
  title: 'Sandbox updates',
  screens: {
    blocked: { title: 'Sandbox', Component: Blocked },
    scheduled: { title: 'Sandbox', Component: Scheduled },
    recovery: { title: 'Sandbox', Component: Recovery },
  },
};
