import { Button, Group, Row, SectionHeader, StatusTag, Text } from '../../components/ui';
import { Avatar, ignore, Page } from './parts';

/**
 * Project › Settings › Team: who can do what in this project, the invitations
 * still open, and the per-person actions behind each row.
 */
export function TeamPage() {
  return (
    <Page>
      <Text variant="bodySmall" tone="muted">
        People on this project see its sessions, files and project knowledge. Each person works
        with their own AI and service connections.
      </Text>
      <SectionHeader title="Members · 3" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <Avatar initials="HT" you /> }}
          title="Holger Teske (you)"
          subtitle="Owner of this project"
          trailing={<StatusTag intent="action" label="Manage" />}
        />
        <Row
          leading={{ element: <Avatar initials="AM" /> }}
          title="Anna Meier"
          subtitle="Joined 3 Nov · last active today"
          trailing={<StatusTag intent="ready" label="Can run" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ element: <Avatar initials="JK" /> }}
          title="Jonas Krüger"
          subtitle="Joined 10 Nov · no AI connection yet"
          trailing={<StatusTag intent="optional" label="Can read" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Open invitations · 2" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'link', quiet: true }}
          title="Invitation for Lena"
          subtitle="Can run · expires in 5 days"
          trailing={<StatusTag intent="transient" label="Waiting" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'link', intent: 'needsSetup' }}
          title="Invitation for Max"
          subtitle="Can read · expired yesterday"
          trailing={<StatusTag intent="needsSetup" label="Expired" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <Button label="Invite a person" icon="user-plus" onPress={ignore} fullWidth />
    </Page>
  );
}

export default function TeamMockup() {
  return <TeamPage />;
}
