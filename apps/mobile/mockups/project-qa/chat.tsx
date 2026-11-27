import { StatusTag, Text } from '../../components/ui';
import { Composer, IssueReference, QAPage, QAStatusCard, QATabs, UserMessage } from './parts';

/** The QA chat: an ordinary conversation that points at issues instead of repeating them. */
export default function ChatMockup() {
  return (
    <QAPage footer={<Composer placeholder="Message QA" />}>
      <QAStatusCard />
      <QATabs value="chat" />
      <Text variant="footnote" tone="faint">
        Today 08:20
      </Text>
      <UserMessage text="Why did the Renovate PR stop?" />
      <Text variant="bodySmall">
        Both rounds fixed the import errors, but typecheck still fails: sigstore v5 changed its
        signing API in 4 files. That is a migration, not a routine update, so I stopped and asked
        you.
      </Text>
      <IssueReference
        title="Renovate PR #88"
        subtitle="Issue · stopped after 2 rounds"
        tag={<StatusTag intent="needsSetup" label="Needs you" />}
      />
      <UserMessage text="Then plan the migration in a separate session." />
      <Text variant="footnote" tone="faint">
        QA updated the issue · 08:22
      </Text>
      <Text variant="bodySmall">
        Done. A new session plans the migration; the PR stays open until you review its result.
      </Text>
      <IssueReference
        title="Renovate PR #88"
        subtitle="Issue · migration planned in “sigstore v5”"
        tag={<StatusTag intent="transient" label="Planning" />}
      />
    </QAPage>
  );
}
