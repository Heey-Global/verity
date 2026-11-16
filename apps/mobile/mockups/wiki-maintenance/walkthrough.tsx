import { Text } from '../../components/ui';
import { Session, UserMessage, VerityMessage } from './parts';

/**
 * Going through a proposal with Verity: one change at a time, in plain words,
 * and only what you confirm is written.
 */
export default function WalkthroughMockup() {
  return (
    <Session placeholder="Reply to Verity…">
      <VerityMessage>
        <Text variant="body">
          Three changes from the meeting of 7 November. The first two match your decision of the
          same day, so I suggest taking them as they are.
        </Text>
        <Text variant="body">
          The third: Anna, a guest in the meeting, said they need a PDF export by March. Should it
          go on the Roadmap as her request, or stay out of the Wiki?
        </Text>
      </VerityMessage>
      <UserMessage>Take it as her request, but not as something we promised.</UserMessage>
      <VerityMessage>
        <Text variant="body">
          Done. The Roadmap now says “Customer request (Anna, 7 Nov): PDF export by March. Not yet
          planned.” All three changes are in the Wiki and recorded in the change log.
        </Text>
      </VerityMessage>
    </Session>
  );
}
