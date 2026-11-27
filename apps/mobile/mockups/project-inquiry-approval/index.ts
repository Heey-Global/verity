import type { MockupSpec } from '../types';
import HomeInquiryMockup from './home';
import SessionInquiryMockup from './session';
import AgentsSettingsMockup from './settings';

export const projectInquiryApprovalSpec: MockupSpec = {
  id: 'project-inquiry-approval',
  title: 'Project inquiries approved per request',
  screens: {
    session: { title: 'Request in the asking session', Component: SessionInquiryMockup },
    home: { title: 'Request on Home', Component: HomeInquiryMockup },
    settings: { title: 'Allowed project inquiries', Component: AgentsSettingsMockup },
  },
};
