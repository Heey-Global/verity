import { FilterChips, Group, Row, SectionHeader, StatusTag, TileMark } from '../../components/ui';
import { ProjectHeroSample } from '../repositories/parts';
import { QARoleRow, Screen, ignore } from './parts';

/**
 * The project page with a pinned Roles group above the work: the QA row shows
 * state and source freshness instead of a last message. Sessions QA started
 * stay ordinary sessions, marked "From QA" and filterable.
 */
export default function ProjectMockup() {
  return (
    <Screen>
      <ProjectHeroSample line="Company website and blog" />
      <SectionHeader title="Roles" variant="eyebrow" />
      <Group>
        <QARoleRow state="needsYou" />
      </Group>
      <FilterChips
        accessibilityLabel="Sessions"
        options={[
          { value: 'all', label: 'All' },
          { value: 'qa', label: 'From QA · 2' },
        ]}
        value="all"
        onChange={ignore}
      />
      <SectionHeader title="Needs you · 1" variant="eyebrow" />
      <Group>
        <Row
          title="Contact form"
          subtitle="Which spam check should we use?"
          leading={{ dot: 'needsSetup' }}
          tag={<StatusTag intent="needsSetup" label="Question" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="In progress · 3" variant="eyebrow" />
      <Group>
        <Row
          title="Fix Renovate typecheck"
          subtitle="From QA · Renovate PR #88 · round 1 of 2"
          leading={{
            icon: 'shield',
            quiet: true,
            marks: { bottom: <TileMark tone="action" glyph="loader" /> },
          }}
          navigates
          onPress={ignore}
        />
        <Row
          title="Login flow rework"
          subtitle="From QA · PR #91 failed · back in its session"
          leading={{
            icon: 'message-square',
            quiet: true,
            marks: { top: <TileMark tone="signature" pulsing /> },
          }}
          navigates
          onPress={ignore}
        />
        <Row
          title="Blog search"
          subtitle="PR #90 · CI running"
          leading={{
            icon: 'git-pull-request',
            quiet: true,
            marks: { bottom: <TileMark tone="action" glyph="loader" /> },
          }}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Content" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'book-open' }}
          title="Wiki"
          subtitle="Maintained knowledge and decisions"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'git-pull-request' }}
          title="Repositories"
          subtitle="1 repository · 4 open PRs"
          navigates
          onPress={ignore}
        />
      </Group>
    </Screen>
  );
}
