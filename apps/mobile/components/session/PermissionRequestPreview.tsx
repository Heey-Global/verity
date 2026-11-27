import {
  NETWORK_SHARE_DELETE_WARNING,
  networkShareApprovalEffect,
  networkShareApprovalSummary,
  networkShareItemName,
  spellOutBidiControls,
} from '@verity/mobile';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, Text } from '../ui';
import { PermissionRequestDetails } from './PermissionRequestDetails';

/**
 * The body of an approval card for a tool without a summary of its own: a
 * network share change in words, or else the full request.
 */
export function PermissionRequestPreview({ tool, input }: { tool: string; input: unknown }) {
  const share = tool === 'verity_network_shares' ? networkShareApprovalSummary(input) : null;
  const [full, setFull] = useState(false);
  if (share === null) return <PermissionRequestDetails input={input} inline />;
  const destinationLabel = share.action === 'rename' ? 'New name' : 'To';
  return (
    <View style={styles.content} testID="network-share-approval">
      <Text variant="label">{share.destination === null ? capitalized(share.kind) : 'From'}</Text>
      <Text selectable>{spellOutBidiControls(share.location)}</Text>
      {share.destination === null ? null : (
        <>
          <Text variant="label">{destinationLabel}</Text>
          <Text selectable>
            {spellOutBidiControls(
              share.action === 'rename'
                ? networkShareItemName(share.destination)
                : share.destination,
            )}
          </Text>
        </>
      )}
      <Text variant="subtitle" tone="muted">
        {networkShareApprovalEffect(share)}
      </Text>
      {share.action === 'delete' && share.kind === 'file' ? (
        <Text variant="subtitle" tone="attention">
          {NETWORK_SHARE_DELETE_WARNING}
        </Text>
      ) : null}
      {share.content?.preview != null ? (
        <>
          <Text variant="label">New content</Text>
          <Card>
            <Text variant="code" selectable numberOfLines={full ? undefined : 6}>
              {spellOutBidiControls(share.content.preview)}
            </Text>
          </Card>
        </>
      ) : null}
      {full ? (
        <PermissionRequestDetails input={input} inline />
      ) : (
        <Button
          label="Show full request"
          variant="text"
          size="compact"
          onPress={() => setFull(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { flexDirection: 'column', gap: theme.spacing.xs },
}));

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
