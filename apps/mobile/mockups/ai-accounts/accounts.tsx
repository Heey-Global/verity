import { Button, Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { ignore, Page, ProviderMark } from './parts';

/** Settings › My AI accounts: the person's own provider logins. */
export default function AccountsMockup() {
  return (
    <Page>
      <SectionHeader title="Connected" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <ProviderMark provider="claude" /> }}
          title="Claude"
          subtitle="Max 5x · signed in as lena@example.org"
          trailing={<StatusTag intent="ready" label="Connected" />}
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Not connected" variant="eyebrow" />
      <Group>
        <Row
          leading={{ element: <ProviderMark provider="codex" /> }}
          title="Codex"
          subtitle="Sign in with your ChatGPT account"
          trailing={<Button label="Connect" size="small" variant="secondary" onPress={ignore} />}
        />
        <Row
          leading={{ element: <ProviderMark provider="opencode" /> }}
          title="OpenCode"
          subtitle="Your own provider address and API key"
          trailing={<Button label="Set up" size="small" variant="secondary" onPress={ignore} />}
        />
      </Group>
    </Page>
  );
}
