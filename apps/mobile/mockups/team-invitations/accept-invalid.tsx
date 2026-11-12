import { Button, Group, Row, SectionHeader, SystemNotice, Text } from '../../components/ui';
import { ignore, Page } from './parts';

/** Every way an invitation can fail to open, side by side as they would appear. */
export default function AcceptInvalidMockup() {
  return (
    <Page>
      <SectionHeader title="Expired" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="This invitation expired on 11 Nov"
        detail="Ask Holger for a new one. Nothing was added to this phone."
      />
      <SectionHeader title="Revoked" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="Holger revoked this invitation"
        detail="It can no longer be used. Nothing was added to this phone."
      />
      <SectionHeader title="Already used" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="This invitation was already accepted"
        detail="If that was you on another phone, add this phone from there under Devices."
      />
      <SectionHeader title="Invalid or not verifiable" variant="eyebrow" />
      <SystemNotice
        intent="unknown"
        title="This invitation could not be verified"
        detail="The link is damaged or the server that answered does not match its key. Verity did not connect."
        technical="server key 81BD 03E2 does not match invitation key 4F2C 9A17"
      />
      <SectionHeader title="Already a member" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'check', intent: 'ready' }}
          title="You are already on verity"
          subtitle="Shared by Holger Teske · Can run"
          navigates
          onPress={ignore}
        />
      </Group>
      <Button label="Close" variant="secondary" onPress={ignore} fullWidth />
    </Page>
  );
}
