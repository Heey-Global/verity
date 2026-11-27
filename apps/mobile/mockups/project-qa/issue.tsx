import {
  Button,
  Card,
  CardHead,
  Group,
  Row,
  SectionHeader,
  StatusTag,
  Text,
} from '../../components/ui';
import { Actions, QAPage, Stack, ignore } from './parts';

const value = (text: string) => <Text variant="bodySmall">{text}</Text>;

/**
 * One issue: why QA stopped and what you can do, then its timeline and the
 * evidence QA checked rather than a session's own report.
 */
export default function IssueMockup() {
  return (
    <QAPage>
      <Card stacked divided attention>
        <CardHead
          title="Renovate PR #88 failed"
          subtitle="website · typecheck · opened by Renovate"
          leading={{ icon: 'git-pull-request', intent: 'needsSetup' }}
          trailing={<StatusTag intent="needsSetup" label="Needs you" />}
        />
        <Stack>
          <Text variant="row">Repair stopped after 2 rounds</Text>
          <Text variant="bodySmall" tone="muted">
            Import errors are fixed; typecheck still fails because sigstore v5 changed its signing
            API in 4 files. This needs a migration beyond the repair mandate.
          </Text>
          <Actions>
            <Button label="Another round" size="small" onPress={ignore} />
            <Button label="Take over" size="small" variant="secondary" onPress={ignore} />
            <Button label="Defer" size="small" variant="secondary" onPress={ignore} />
          </Actions>
        </Stack>
      </Card>
      <SectionHeader title="Timeline" />
      <Group>
        <Row
          title="Detected"
          subtitle="07:40 · typecheck failed on 4e1b7d2"
          leading={{ dot: 'ready' }}
        />
        <Row
          title="Assigned"
          subtitle="07:41 · new session, the PR has no origin session"
          leading={{ dot: 'ready' }}
        />
        <Row title="Repair" subtitle="07:41–08:05 · 2 rounds" leading={{ dot: 'ready' }} />
        <Row
          title="Review"
          subtitle="08:09 · typecheck still failing on 9c03e1f"
          leading={{ dot: 'needsSetup' }}
        />
        <Row title="Done" subtitle="Waiting for your decision" leading={{ dot: 'unknown' }} />
      </Group>
      <SectionHeader title="Evidence" />
      <Group>
        <Row title="Failing check" trailing={value('typecheck · 6 errors')} />
        <Row title="Revision" trailing={value('9c03e1f · head of PR')} />
        <Row
          title="Session"
          subtitle="Fix Renovate typecheck"
          leading={{ icon: 'message-square' }}
          navigates
          onPress={ignore}
        />
        <Row title="Rounds" trailing={value('2 of 2 used')} />
      </Group>
    </QAPage>
  );
}
