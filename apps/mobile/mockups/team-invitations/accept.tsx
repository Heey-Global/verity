import { Button, Group, Row, StepIntro, TextField } from '../../components/ui';
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { ignore, Page, PROJECT } from './parts';

/** Accepting on the invited person's phone: which project, with which right, under which name. */
export default function AcceptMockup() {
  return (
    <Page
      footer={
        <>
          <Button label="Join project" onPress={ignore} fullWidth />
          <Button label="Decline" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <OnboardingProgress current={1} total={3} />
      <StepIntro
        headline="Holger invites you to"
        accent={PROJECT}
        lead="Work on it together, with your own AI."
      />
      <Group>
        <Row
          leading={{ icon: 'folder', quiet: true }}
          title={`The project “${PROJECT}”`}
          subtitle="48 sessions · files · wiki"
        />
        <Row
          leading={{ icon: 'edit-2', quiet: true }}
          title="Can edit"
          subtitle="See everything and send messages with your own AI account"
          wrap
        />
      </Group>
      <TextField label="Your name in the team" value="Lena" onChangeText={ignore} />
    </Page>
  );
}
