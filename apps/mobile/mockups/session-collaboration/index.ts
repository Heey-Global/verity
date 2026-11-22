import type { MockupSpec } from '../types';
import ApprovalMockup from './approval';
import SeveralCollaboratorsMockup from './several';
import CollaborationSheetMockup from './sheet';
import SingleCollaboratorMockup from './single';
import TargetSessionMockup from './target';

export const sessionCollaborationSpec: MockupSpec = {
  id: 'session-collaboration',
  title: 'Collaboration line in the session header',
  screens: {
    single: { title: 'Header concept', Component: SingleCollaboratorMockup },
    several: { title: 'Header concept', Component: SeveralCollaboratorsMockup },
    approval: { title: 'Header concept', Component: ApprovalMockup },
    sheet: { title: 'Header concept', Component: CollaborationSheetMockup },
    target: { title: 'Auth refactor', Component: TargetSessionMockup },
  },
};
