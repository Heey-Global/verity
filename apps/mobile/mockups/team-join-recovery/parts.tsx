import { Button, Group, Row, StepIntro, SystemNotice, TextField } from '../../components/ui';
import { AiAccountNextStep } from '../../components/AiAccountNextStep';
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { Page, ignore } from '../team-invitations/parts';

type State = 'accept' | 'joining' | 'resume' | 'interrupted' | 'unavailable' | 'complete';
const copy = {
  accept: ['Alex invites you to', 'Website relaunch', 'Join the team with your own accounts.'],
  joining: [
    'Joining',
    'Website relaunch',
    'Your access is saved. We’re confirming your membership.',
  ],
  resume: [
    'Continue joining',
    'Website relaunch',
    'Your access is saved on this device. Pick up where you left off.',
  ],
  interrupted: [
    'Connection lost',
    'Your progress is saved',
    'You haven’t joined yet. Try again when you’re back online.',
  ],
  unavailable: [
    'This invitation',
    'can no longer be used',
    'It may have expired or been withdrawn. Ask Alex for a new invitation.',
  ],
  complete: [
    'You’ve joined',
    'Website relaunch',
    'One more step: connect your own AI account so Verity can work for you.',
  ],
} as const;

/** Sample states only; no enrollment, storage, network calls or credentials. */
export function JoinMockup({ state }: { state: State }) {
  const [headline, accent, lead] = copy[state];
  const label = {
    accept: 'Join project',
    joining: 'Leave for now',
    resume: 'Continue joining',
    interrupted: 'Try again',
    unavailable: 'Close',
    complete: 'Set up my AI account',
  }[state];
  return (
    <Page
      footer={
        <>
          <Button
            label={label}
            variant={state === 'joining' || state === 'unavailable' ? 'secondary' : 'primary'}
            onPress={ignore}
            fullWidth
          />
          {state !== 'joining' && state !== 'unavailable' && state !== 'complete' ? (
            <Button
              label={state === 'accept' ? 'Not now' : 'Leave for now'}
              variant="text"
              onPress={ignore}
              fullWidth
            />
          ) : null}
        </>
      }
    >
      <OnboardingProgress
        current={state === 'accept' ? 1 : state === 'complete' ? 3 : 2}
        total={3}
      />
      <StepIntro headline={headline} accent={accent} lead={lead} />
      {state === 'accept' ? (
        <>
          <Group>
            <Row
              leading={{ icon: 'folder', quiet: true }}
              title="Website relaunch"
              subtitle="Shared by Alex"
            />
            <Row
              leading={{ icon: 'edit-2', quiet: true }}
              title="Can edit"
              subtitle="Read the project and send messages with your own AI account"
              wrap
            />
          </Group>
          <TextField label="Your name in the team" value="Sam" onChangeText={ignore} />
        </>
      ) : null}
      {state === 'joining' ? (
        <>
          <Group>
            <Row leading={{ icon: 'check' }} title="Access saved on this device" />
            <Row
              leading={{ icon: 'clock' }}
              title="Confirming your membership"
              subtitle="On Alex’s server"
            />
          </Group>
          <SystemNotice
            intent="transient"
            title="You can leave this screen"
            detail="Your existing server stays connected. You can continue this join later."
          />
        </>
      ) : null}
      {state === 'resume' ? (
        <Group>
          <Row leading={{ icon: 'folder' }} title="Website relaunch" subtitle="Alex’s server" />
          <Row
            leading={{ icon: 'check' }}
            title="Access saved on this device"
            subtitle="We’ll check whether your membership is confirmed."
            wrap
          />
        </Group>
      ) : null}
      {state === 'interrupted' ? (
        <SystemNotice
          intent="needsSetup"
          title="Couldn’t reach Alex’s server"
          detail="Your existing server and its connections haven’t changed."
        />
      ) : null}
      {state === 'unavailable' ? (
        <SystemNotice
          intent="needsSetup"
          title="A new invitation is needed"
          detail="Your existing server and accounts are unchanged."
        />
      ) : null}
      {state === 'complete' ? (
        <>
          <Group>
            <Row
              leading={{ icon: 'check' }}
              title="Membership confirmed"
              subtitle="You can edit Website relaunch as Sam."
              wrap
            />
          </Group>
          <AiAccountNextStep />
        </>
      ) : null}
    </Page>
  );
}
