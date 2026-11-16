import { Button, Group, Row, SectionHeader, StatusTag, Text, TextField } from '../../components/ui';
import { ignore, Page } from './parts';

/**
 * Invite a person to one project: the inviter's own display name (asked once),
 * the right, what the person sees, and the connections they bring themselves.
 */
export default function InviteMockup() {
  return (
    <Page footer={<Button label="Create invitation" onPress={ignore} fullWidth />}>
      <TextField
        label="Your name, as invited people see it"
        value="Holger Teske"
        onChangeText={ignore}
      />
      <TextField label="Who are you inviting?" value="Lena" onChangeText={ignore} />
      <SectionHeader title="Right in “verity”" variant="eyebrow" />
      <Group>
        <Row selected={false} title="Can read" onPress={ignore} />
        <Row
          selected
          title="Can edit"
          subtitle="Sends messages with their own AI account"
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Lena sees" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'eye', quiet: true }}
          title="The project “verity”"
          subtitle="48 sessions · files · wiki"
          wrap
        />
        <Row
          leading={{ icon: 'cpu' }}
          title="Brings their own AI connection"
          trailing={<StatusTag intent="needsSetup" label="Required" />}
        />
      </Group>
    </Page>
  );
}
