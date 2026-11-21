import { Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { QAPage, QAStatusCard, QATabs, ignore } from './parts';

/** The QA page: the source status, then the issues QA tracks, without a composer. */
export default function IssuesMockup() {
  return (
    <QAPage>
      <QAStatusCard />
      <QATabs value="issues" />
      <SectionHeader title="Needs you · 1" variant="eyebrow" />
      <Group>
        <Row
          title="Renovate PR #88 failed"
          subtitle="Typecheck · stopped after 2 rounds"
          leading={{ icon: 'git-pull-request', intent: 'needsSetup' }}
          tag={<StatusTag intent="needsSetup" label="Needs you" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="In progress · 2" variant="eyebrow" />
      <Group>
        <Row
          title="PR #91 failed"
          subtitle="Back in its session “Login flow rework” · round 1 of 2"
          leading={{ icon: 'git-pull-request', quiet: true }}
          tag={<StatusTag intent="transient" label="Repairing" />}
          navigates
          onPress={ignore}
        />
        <Row
          title="Renovate PRs #86, #87"
          subtitle="Same cause · queued, 3 repairs already running"
          leading={{ icon: 'git-pull-request', quiet: true }}
          tag={<StatusTag intent="optional" label="Queued" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Resolved this week · 4" variant="eyebrow" />
      <Group>
        <Row
          title="Nightly build on main"
          subtitle="Fixed by “Pin Node 24” · verified on 3f2a9c1"
          leading={{ icon: 'check-circle', intent: 'ready' }}
          navigates
          onPress={ignore}
        />
        <Row title="Show 3 more" leading={{ icon: 'chevron-down', quiet: true }} onPress={ignore} />
      </Group>
    </QAPage>
  );
}
