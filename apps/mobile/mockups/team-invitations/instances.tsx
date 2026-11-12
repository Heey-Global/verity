import { Button, Group, Row, SectionHeader, StatusTag, Text } from '../../components/ui';
import { Avatar, ignore, Page } from './parts';

/**
 * Switching between the own server and projects others share: each shared
 * project is its own profile with its own sign-in, cache and connections.
 */
export default function InstancesMockup() {
  return (
    <Page>
      <Text variant="bodySmall" tone="muted">
        Each person's server keeps its own sign-in and connections on this phone, shared once for all
        projects they share. Your own server is never replaced.
      </Text>
      <SectionHeader title="Your server" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'server' }}
          title="my-server.uplink.verity.build"
          subtitle="6 projects · Administrator"
          selected
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Shared by Holger Teske · 2 projects" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <Avatar initials="HT" /> }}
          title="verity"
          subtitle="Can run"
          trailing={<StatusTag intent="action" label="2 new" />}
          onPress={ignore}
        />
        <Row
          leading={{ element: <Avatar initials="HT" /> }}
          title="Website"
          subtitle="Can read · added 11 Nov"
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Shared by Sara Nord" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <Avatar initials="SN" /> }}
          title="Website relaunch"
          subtitle="Access ended 8 Nov"
          trailing={<StatusTag intent="needsSetup" label="Removed" />}
          onPress={ignore}
        />
      </Group>
      <Button label="Accept an invitation" icon="plus" variant="secondary" onPress={ignore} fullWidth />
      <Text variant="footnote" tone="muted">
        Removing a shared project here deletes its data on this phone. Your membership ends when its
        owner removes you.
      </Text>
    </Page>
  );
}
