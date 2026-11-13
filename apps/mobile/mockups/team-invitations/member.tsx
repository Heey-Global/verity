import { Button, Group, Row, SectionHeader, Sheet, StatusTag, Text } from '../../components/ui';
import { Avatar, ignore } from './parts';
import { TeamPage } from './team';

/** A member's sheet from the Team page: change the right or remove the person. */
export default function MemberMockup() {
  return (
    <>
      <TeamPage />
      <Sheet
        visible
        title="Anna Meier"
        titleLeading={<Avatar initials="AM" />}
        onClose={ignore}
        footer={
          <Button label="Remove from “verity”" variant="destructive" onPress={ignore} fullWidth />
        }
      >
        <Text variant="footnote" tone="muted">
          Joined 3 Nov · 2 devices · Claude connected
        </Text>
        <SectionHeader title="Right in “verity”" variant="eyebrow" flush />
        <Group>
          <Row selected={false} title="Can read" onPress={ignore} />
          <Row selected title="Can edit" onPress={ignore} />
          <Row selected={false} title="Can manage" onPress={ignore} />
        </Group>
        <SectionHeader title="Also on your server" variant="eyebrow" flush />
        <Group>
          <Row
            leading={{ icon: 'folder', quiet: true }}
            title="Website relaunch"
            trailing={<StatusTag intent="optional" label="Can read" />}
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'plus', intent: 'action' }}
            title="Add to another project"
            subtitle="No new invitation; Anna sees it right away"
            onPress={ignore}
          />
        </Group>
      </Sheet>
    </>
  );
}
