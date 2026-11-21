// After joining a shared project: what the personal AI account is for, and
// that a subscription the person already has is enough. Nothing is wrong yet,
// so it reads as a plain next step, without a status colour that looks like
// an error.
import { Group, Row, SectionHeader } from './ui';

export function AiAccountNextStep() {
  return (
    <>
      <SectionHeader title="Next: your AI account" />
      <Group>
        <Row
          leading={{ icon: 'zap' }}
          title="Why it is needed"
          subtitle="Verity’s agents work with your own AI account. Your sessions use your own plan and limits."
          wrap
        />
        <Row
          leading={{ icon: 'user-check' }}
          title="Use the subscription you already have"
          subtitle="Claude and Codex sign in with your Claude or ChatGPT plan, no API key needed. OpenCode uses your own provider and API key."
          wrap
        />
        <Row
          leading={{ icon: 'lock' }}
          title="Private to you"
          subtitle="Teammates can’t see or use your account. GitHub and other connections can be added later."
          wrap
        />
      </Group>
    </>
  );
}
