import type { MockupSpec } from '../types';
import AnsweredMockup from './answered';
import CollapsedMockup from './collapsed';
import DecisionMockup from './decision';
import ReadyMockup from './ready';

/**
 * The plan card pinned above the composer: bounded in height, one open
 * decision at a time, answers sent together. Sample content only.
 */
export const planCardSpec: MockupSpec = {
  id: 'plan-card',
  title: 'Plan card',
  screens: {
    decision: { title: 'Wiki planen', Component: DecisionMockup },
    answered: { title: 'Wiki planen', Component: AnsweredMockup },
    ready: { title: 'Wiki planen', Component: ReadyMockup },
    collapsed: { title: 'Wiki planen', Component: CollapsedMockup },
  },
};
