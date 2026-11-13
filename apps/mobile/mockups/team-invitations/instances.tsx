import { Button, Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { Avatar, ignore, Page } from './parts';

/**
 * Settings › Servers: the servers this phone is connected to. Only for
 * managing them; their projects all appear in the one project list.
 */
export default function InstancesMockup() {
  return (
    <Page>
      <SectionHeader title="Your server" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'server' }}
          title="My server"
          subtitle="6 projects · my-server.uplink.verity.build"
          trailing={<StatusTag intent="ready" label="Connected" />}
        />
      </Group>
      <SectionHeader title="Shared with you" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <Avatar initials="HT" /> }}
          title="Holger Teske"
          subtitle="2 projects"
          trailing={<StatusTag intent="ready" label="Connected" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ element: <Avatar initials="SN" /> }}
          title="Sara Nord"
          subtitle="No projects left"
          trailing={<StatusTag intent="optional" label="Access ended" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <Button
        label="Accept an invitation"
        icon="plus"
        variant="secondary"
        onPress={ignore}
        fullWidth
      />
    </Page>
  );
}
