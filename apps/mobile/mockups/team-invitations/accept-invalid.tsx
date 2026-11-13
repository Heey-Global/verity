import { Button, StepIntro, SystemNotice } from '../../components/ui';
import { ignore, Page } from './parts';

/**
 * An invitation that can no longer be used, here because it expired. A revoked,
 * already used or damaged link shows the same screen with its own message.
 */
export default function AcceptInvalidMockup() {
  return (
    <Page footer={<Button label="Close" variant="secondary" onPress={ignore} fullWidth />}>
      <StepIntro headline="Invitation to" accent="verity" lead="From Holger Teske" />
      <SystemNotice
        intent="needsSetup"
        title="This invitation expired on 11 Nov"
        detail="Ask Holger for a new one."
      />
    </Page>
  );
}
