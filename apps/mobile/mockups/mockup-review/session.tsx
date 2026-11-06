import { MockupPager, SAMPLE_SCREENS } from './parts';
import { SessionChat } from './session-chat';

/** The chat shows one screen at full width with dots, like the review. */
export default function SessionReviewMockup() {
  return <SessionChat gallery={<MockupPager screens={SAMPLE_SCREENS} index={0} />} />;
}
