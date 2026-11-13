import { Button, Group, Row, SectionHeader, StatusTag, SystemNotice } from '../../components/ui';
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { ignore, Page, ProviderMark } from './parts';

/**
 * After joining: the connections this person sets up for the project, required
 * before optional, with what each unlocks and what is still missing.
 */
export default function ConnectionsMockup() {
  return (
    <Page footer={<Button label="Open “verity”" onPress={ignore} fullWidth />}>
      <OnboardingProgress current={3} total={3} />
      <SectionHeader title="Required" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <ProviderMark provider="claude" /> }}
          title="Claude"
          subtitle="Signed in as lena@example.org"
          trailing={<StatusTag intent="ready" label="Connected" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Optional" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'github', intent: 'needsSetup' }}
          title="GitHub"
          subtitle="Pull requests and pushes in heey-global/verity"
          trailing={<StatusTag intent="needsSetup" label="No access" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'hard-drive' }}
          title="Google Drive"
          subtitle="Project folder »Verity Docs«"
          trailing={<StatusTag intent="optional" label="Connect" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'key' }}
          title="Doppler secrets"
          subtitle="Staging configuration for deploy checks"
          trailing={<StatusTag intent="optional" label="Connect" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SystemNotice
        intent="needsSetup"
        title="GitHub account lena-dev has no access to heey-global/verity"
        detail="You can work locally. To open pull requests, ask a repository owner on GitHub to add lena-dev, then check again."
        actions={<Button label="Check again" size="small" variant="secondary" onPress={ignore} />}
      />
    </Page>
  );
}
