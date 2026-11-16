import type { MockupSpec } from '../types';
import DesignSettingsMockup from './design-settings';
import HomeReviewMockup from './home';
import SessionReviewMockup from './session';
import ViewerMockup from './viewer';

/**
 * Design module and mockup review (software factory, step 2): the per-project
 * Design setting, the chat message and status bar a session shows after the agent presented
 * mockups, and the Home item that points to it. Sample content only.
 */
export const mockupReviewSpec: MockupSpec = {
  id: 'mockup-review',
  title: 'Design module and mockup review',
  screens: {
    'design-settings': { title: 'Design', Component: DesignSettingsMockup },
    session: { title: 'Website', Component: SessionReviewMockup },
    home: { title: 'Verity', Component: HomeReviewMockup },
    viewer: { title: 'Review', Component: ViewerMockup },
  },
};
