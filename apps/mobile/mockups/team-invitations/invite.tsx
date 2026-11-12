import { Button, Group, Row, SectionHeader, StatusTag, Text, TextField } from '../../components/ui';
import { ignore, Page } from './parts';

/**
 * Invite a person to one project: the inviter's own display name (asked once),
 * the right, what the person sees, and the connections they bring themselves.
 */
export default function InviteMockup() {
  return (
    <Page footer={<Button label="Create invitation" onPress={ignore} fullWidth />}>
      <TextField label="Your name, as invited people see it" value="Holger Teske" onChangeText={ignore} />
      <Text variant="footnote" tone="muted">
        Suggested from your GitHub account. Asked only once; change it later in your profile.
      </Text>
      <TextField label="Who are you inviting?" value="Lena" onChangeText={ignore} />
      <SectionHeader title="Right in verity" variant="eyebrow" />
      <Group>
        <Row selected={false} title="Can read" onPress={ignore} />
        <Row selected title="Can run" subtitle="Starts turns with their own connections" onPress={ignore} />
        <Row selected={false} title="Can manage" onPress={ignore} />
      </Group>
      <SectionHeader title="Lena sees" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'eye', quiet: true }}
          title="Only the project verity"
          subtitle="Its 48 sessions, files, Sources and wiki · nothing else on your server"
          wrap
        />
        <Row leading={{ icon: 'cpu' }} title="Brings their own AI connection" trailing={<StatusTag intent="needsSetup" label="Required" />} />
      </Group>
      <Text variant="footnote" tone="muted">
        Your AI accounts, GitHub, Google, secrets and other projects are never shared.
      </Text>
    </Page>
  );
}
