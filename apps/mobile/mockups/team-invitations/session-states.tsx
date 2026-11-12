import { Button, SectionHeader, SystemNotice, Text } from '../../components/ui';
import { ignore, Page } from './parts';

/** What replaces the composer of a shared session when this person cannot send a turn. */
export default function SessionStatesMockup() {
  return (
    <Page>
      <Text variant="bodySmall" tone="muted">
        The history stays readable in each case; only sending is affected.
      </Text>
      <SectionHeader title="No AI connection" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="Connect your own AI to send turns"
        detail="This session ran on Holger's Codex. Verity never uses another person's account for you."
        actions={<Button label="Connect AI" size="small" onPress={ignore} />}
      />
      <SectionHeader title="Missing service connection" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="This turn needs your GitHub connection"
        detail="The agent wants to open a pull request. Connect GitHub or ask it to continue locally."
        actions={<Button label="Connect GitHub" size="small" variant="secondary" onPress={ignore} />}
      />
      <SectionHeader title="Can read only" variant="eyebrow" />
      <SystemNotice
        intent="unknown"
        title="You can read this project but not run turns"
        detail="Ask Holger for the right to run. You can still follow sessions, files and the wiki."
      />
      <SectionHeader title="Access ended" variant="eyebrow" />
      <SystemNotice
        intent="needsSetup"
        title="Your access to verity ended"
        detail="Holger removed you from the project. Your running turn was stopped and local project data on this phone was deleted."
        actions={<Button label="Back to my projects" size="small" variant="secondary" onPress={ignore} />}
      />
    </Page>
  );
}
