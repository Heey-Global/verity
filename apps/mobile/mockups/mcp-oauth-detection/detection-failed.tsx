import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import {
  Button,
  Card,
  CardHead,
  Group,
  HintBox,
  Text,
  TextField,
  ToggleRow,
} from '../../components/ui';

const ignore = () => undefined;
const URL = 'https://heey-docs.serengeti-panga.ts.net/mcp/privat';

/**
 * Add MCP connection after "Detect OAuth settings" failed. The hint carries
 * the server's reason for the failed step instead of a fixed "check the URL";
 * the manual fallback opens as before.
 */
export default function DetectionFailedMockup() {
  return (
    <View style={styles.root}>
      <SettingsScaffold
        title="Add MCP connection"
        detail
        footer={
          <View style={styles.footerStack}>
            <HintBox
              title="OAuth not detected"
              message={`${URL} answered HTTP 200 without an OAuth challenge, so Verity cannot tell how to sign in. Check the URL or enter the provider settings under Advanced.`}
            />
            <Button
              label="Add connection"
              accessibilityLabel="Add MCP connection"
              disabled
              onPress={ignore}
              fullWidth
            />
          </View>
        }
      >
        <SettingsGroup title="Server">
          <SettingsPanel>
            <TextField
              label="Connection name"
              value="heey-docs-privat"
              onChangeText={ignore}
              literal
            />
            <TextField label="Remote HTTPS MCP URL" value={URL} onChangeText={ignore} literal />
          </SettingsPanel>
        </SettingsGroup>
        <SettingsGroup title="Authentication">
          <Card flush>
            <ToggleRow title="Use OAuth 2.0" value onValueChange={ignore} />
          </Card>
          <Card stacked>
            <CardHead title="Provider" subtitle="Read the provider settings from the server URL." />
            <Button
              label="Detect OAuth settings"
              variant="secondary"
              size="compact"
              onPress={ignore}
            />
          </Card>
          <SettingsPanel>
            <TextField
              label="OAuth client ID"
              value=""
              onChangeText={ignore}
              placeholder="Leave empty for automatic registration"
              literal
            />
          </SettingsPanel>
        </SettingsGroup>
        <SettingsGroup
          title="Callback"
          description="When using your own OAuth app, register this exact callback URL with the provider. Automatic registration configures it for you."
        >
          <Card stacked>
            <Text variant="code" selectable>
              https://verity:8082/app/mcp/oauth/callback
            </Text>
          </Card>
        </SettingsGroup>
        <SettingsGroup title="Advanced">
          <Card flush>
            <ToggleRow title="Advanced OAuth settings" value onValueChange={ignore} />
          </Card>
          <Group>
            <SettingsChoiceRow title="Client secret in request body" selected onPress={ignore} />
            <SettingsChoiceRow
              title="Public client (PKCE only)"
              selected={false}
              onPress={ignore}
            />
          </Group>
        </SettingsGroup>
      </SettingsScaffold>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  footerStack: { gap: theme.spacing.sm },
}));
