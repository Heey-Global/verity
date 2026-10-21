// The "Action needed" card on the GitHub settings screen: a permission the
// GitHub App still lacks, why Verity wants it, and the GitHub page that grants
// it. It renders only when GitHub confirmed the gap — a failed check shows
// nothing, because a guess would send the operator to change settings that
// may already be right.
import { type VerityClient } from '@verity/mobile';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';

import {
  checkGithubPermission,
  githubActionNeeded,
  type GithubPermissionState,
} from '../lib/githubPermission';
import { settingsStyles as styles } from './settings/settingsStyles';
import { Button, HintBox } from './ui';

export function GithubPermissionNotice({
  client,
  permission,
}: {
  client: VerityClient;
  permission: GithubPermissionState;
}) {
  const [stepsShown, setStepsShown] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  if (!githubActionNeeded(permission)) return null;
  const { state, url } = permission.result!.commitStatusPermission!;
  const appUpdate = state === 'app_update_required';
  return (
    <HintBox
      title="Allow reading CI statuses"
      message="Some build and test results reach GitHub as commit statuses. Verity can't see them yet, so CI checks may be incomplete."
    >
      <Text style={styles.footnote}>Read-only. Verity can't change any status.</Text>
      {stepsShown ? (
        <Text style={styles.footnote}>
          {appUpdate
            ? '1. In the GitHub App settings, set Repository permissions → Commit statuses to Read-only and save.\n2. Approve the new permission for the installation when GitHub asks.\nOnly an owner or manager of the App can change it.'
            : 'The App already requests this permission. Approve it in the installation settings on GitHub. Only the installation owner can approve it.'}
        </Text>
      ) : null}
      <View style={styles.actionRowStart}>
        <Button
          label={stepsShown ? 'Hide steps' : 'Show steps'}
          variant="text"
          size="compact"
          onPress={() => setStepsShown(!stepsShown)}
        />
      </View>
      <View style={styles.actionRowStart}>
        {url ? (
          <Button
            label="Open GitHub"
            icon="external-link"
            role="link"
            size="compact"
            onPress={() => {
              setOpenFailed(false);
              void Linking.openURL(url).catch(() => setOpenFailed(true));
            }}
          />
        ) : null}
        <Button
          label="Check again"
          variant="secondary"
          size="compact"
          loading={permission.checking}
          onPress={() => void checkGithubPermission(client, true)}
        />
      </View>
      {openFailed ? <Text style={styles.footnote}>Could not open GitHub. Try again.</Text> : null}
    </HintBox>
  );
}
