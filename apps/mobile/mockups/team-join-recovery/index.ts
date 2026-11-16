import type { MockupSpec } from '../types';
import Accept from './accept';
import Joining from './joining';
import Resume from './resume';
import Interrupted from './interrupted';
import Unavailable from './unavailable';
import Complete from './complete';
export const teamJoinRecoverySpec: MockupSpec = {
  id: 'team-join-recovery',
  title: 'Join and recovery',
  screens: {
    accept: { title: 'Join project', Component: Accept },
    joining: { title: 'Join project', Component: Joining },
    resume: { title: 'Join project', Component: Resume },
    interrupted: { title: 'Join project', Component: Interrupted },
    unavailable: { title: 'Join project', Component: Unavailable },
    complete: { title: 'Join project', Component: Complete },
  },
};
