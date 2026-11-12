import { Button, Group, Row, StatusTag, StepIntro, Text, TextField } from '../../components/ui';
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { Avatar, ignore, Page, PROJECT } from './parts';

/** Accepting on the invited person's phone: who shares which project, with which right. */
export default function AcceptMockup() {
  return (
    <Page
      footer={
        <>
          <Button label="Join and continue" onPress={ignore} fullWidth />
          <Button label="Decline" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <OnboardingProgress current={1} total={3} />
      <StepIntro
        headline="Holger Teske shares"
        accent={PROJECT}
        lead="Join to work on this project with your own AI connection."
      />
      <Group>
        <Row
          leading={{ element: <Avatar initials="HT" /> }}
          title="Holger Teske"
          subtitle="Server verified through Uplink · key 4F2C 9A17"
          trailing={<StatusTag intent="ready" label="Verified" />}
        />
        <Row
          leading={{ icon: 'folder', quiet: true }}
          title={`Only the project ${PROJECT}`}
          subtitle="48 sessions · files · wiki and decisions"
        />
        <Row leading={{ icon: 'user-check', quiet: true }} title="Can run" subtitle="Read everything in the project and start turns" />
      </Group>
      <TextField label="Your name, as the team sees it" value="Lena" onChangeText={ignore} />
      <Text variant="footnote" tone="muted">
        Holger and other members see your name and messages in shared sessions, never your
        connections. Your own Verity server and its sign-in stay unchanged.
      </Text>
    </Page>
  );
}
