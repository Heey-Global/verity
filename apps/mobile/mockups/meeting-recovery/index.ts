import type { MockupSpec } from '../types';
import MeetingSyncErrorMockup from './sync-error';

export const meetingRecoverySpec: MockupSpec = {
  id: 'meeting-recovery',
  title: 'Meeting recovery',
  screens: {
    'sync-error': { title: 'Meeting sync recovery', Component: MeetingSyncErrorMockup },
  },
};
