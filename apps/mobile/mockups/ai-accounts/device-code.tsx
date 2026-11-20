import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Button, Card, StepIntro, Text } from '../../components/ui';
import { ignore, Page } from './parts';

/** Connecting Codex: the device code from the provider's own sign-in, waiting for confirmation. */
export default function DeviceCodeMockup() {
  const { theme } = useUnistyles();
  return (
    <Page footer={<Button label="Cancel" variant="secondary" onPress={ignore} fullWidth />}>
      <StepIntro headline="Connect" accent="Codex" lead="Sign in with your ChatGPT account." />
      <Card stacked>
        <Text variant="label" tone="muted">
          1 · Open the sign-in page
        </Text>
        <Button label="Open auth.openai.com/codex/device" onPress={ignore} fullWidth />
        <Text variant="label" tone="muted">
          2 · Enter this code
        </Text>
        <Text variant="title">K7QF-2MXR</Text>
        <Button label="Copy code" size="small" variant="secondary" onPress={ignore} />
      </Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <ActivityIndicator color={theme.colors.action} />
        <Text variant="bodySmall" tone="muted">
          Waiting for you to confirm on the sign-in page…
        </Text>
      </View>
    </Page>
  );
}
