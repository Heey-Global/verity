import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, SystemNotice } from '../ui';

/** A session's Code tab when its checkout is missing on the server: what happened,
 * and the restore that brings it back, instead of a silent switch to Documents. */
export function CodeWorkspaceNotice({
  restoring,
  failure,
  onRestore,
  onOpenDocuments,
}: {
  restoring: boolean;
  /** Why the last restore failed, shown under Details. */
  failure: string | null;
  onRestore: () => void;
  onOpenDocuments: (() => void) | undefined;
}) {
  if (restoring)
    return (
      <View style={styles.root}>
        <SystemNotice
          intent="transient"
          title="Restoring code workspace…"
          detail="Checking out this session's branch and moving its working directory to it. Pending document edits are carried over. The agent waits until this is done."
        />
      </View>
    );
  return (
    <View style={styles.root}>
      <SystemNotice
        intent="needsSetup"
        title="Code workspace unavailable"
        detail={
          failure
            ? 'Restoring did not succeed. Your documents are not affected; try again, or Repair the project Sandbox in its settings.'
            : "This session's code checkout is missing on the server. Restore brings it back on its branch and keeps any unpushed work. Your documents are not affected."
        }
        actions={
          <View style={styles.actions}>
            <Button label="Restore" size="small" onPress={onRestore} />
            {onOpenDocuments ? (
              <Button
                label="Open Documents"
                variant="secondary"
                size="small"
                onPress={onOpenDocuments}
              />
            ) : null}
          </View>
        }
        technical={failure ?? undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { paddingTop: theme.spacing.md },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
}));
