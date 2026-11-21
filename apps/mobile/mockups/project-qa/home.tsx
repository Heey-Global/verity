import type { InboxItem } from '@verity/mobile';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { InboxCard } from '../../components/inbox/InboxFeed';
import { Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { FramedScreen, ignore } from './parts';

/** Sample only: the item a project's QA raises when it stops and needs the user. */
const stopped: InboxItem = {
  key: 'qa:website:issue-88',
  kind: 'question',
  tag: 'Needs you',
  tone: 'attention',
  title: 'Repair stopped: Renovate PR #88',
  context: 'QA · website',
  message:
    'Typecheck still fails after 2 rounds: sigstore v5 changed its signing API in 4 files. This needs a migration beyond the repair mandate.',
  actions: [
    { kind: 'answer', label: 'Another round', answer: 'another-round', sessionId: 'qa' },
    { kind: 'answer', label: 'Take over', answer: 'take-over', sessionId: 'qa' },
    { kind: 'answer', label: 'Defer', answer: 'defer', sessionId: 'qa' },
  ],
  at: 0,
};

/** Home: a QA item appears with its sender like any other item that needs you. */
export default function HomeMockup() {
  return (
    <FramedScreen footer={<HomeTabBar tab="home" onChange={ignore} count={2} bottomInset={0} />}>
      <SectionHeader title="Needs you · 2" variant="eyebrow" flush />
      <Group>
        <InboxCard
          item={stopped}
          leading={{ icon: 'shield', intent: 'needsSetup' }}
          grouped
          selected={false}
          pending={false}
          disabled={false}
          onAction={ignore}
        />
        <Row
          title="Contact form"
          subtitle="website · Which spam check should we use?"
          leading={{ dot: 'needsSetup' }}
          tag={<StatusTag intent="needsSetup" label="Question" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="In progress · 1" variant="eyebrow" flush />
      <Group>
        <Row
          title="Fix Renovate typecheck"
          subtitle="website · From QA · round 1 of 2"
          leading={{ icon: 'shield', quiet: true }}
          navigates
          onPress={ignore}
        />
      </Group>
    </FramedScreen>
  );
}
