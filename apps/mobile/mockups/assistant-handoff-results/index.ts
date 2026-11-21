import type { MockupSpec } from '../types';
import PanelDoneMockup from './panel-done';
import PanelOpenMockup from './panel-open';
import PanelSentMockup from './panel-sent';
import PushPhoneMockup from './push-phone';
import PushWatchMockup from './push-watch';

/**
 * A handoff's published result reaches the user without an assistant turn: the
 * handoff card in the Verity panel shows it, and a push carries it to the phone
 * and, mirrored by iOS, the Watch. Sample content only.
 */
export const assistantHandoffResultsSpec: MockupSpec = {
  id: 'assistant-handoff-results',
  title: 'Handoff results',
  screens: {
    'panel-sent': { title: 'Verity', Component: PanelSentMockup },
    'panel-done': { title: 'Verity', Component: PanelDoneMockup },
    'panel-open': { title: 'Verity', Component: PanelOpenMockup },
    'push-phone': { title: 'Push notification', Component: PushPhoneMockup },
    'push-watch': { title: 'Push on Apple Watch', Component: PushWatchMockup },
  },
};
