import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeWorkspaceNotice } from '../../components/files/CodeWorkspaceNotice';
import { FileRootTabs } from '../../components/files/FileRootTabs';
import { FileSheetHeader, HeaderIconButton } from '../../components/files/FileSheetHeader';

const ignore = () => undefined;

/** Sample composition of the session files panel with the production components. */
export function CodeWorkspacePanel({ state }: { state: 'unavailable' | 'restoring' }) {
  return (
    <View style={styles.root}>
      <FileSheetHeader
        title="Files"
        subtitle="heey-docs · Website relaunch"
        trailing={<HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={ignore} />}
      />
      <FileRootTabs
        codeIcon="folder"
        codeActive
        codeDisabled={false}
        driveActive={false}
        drive
        disabled={false}
        onCode={ignore}
        onDrive={ignore}
      />
      <CodeWorkspaceNotice
        restoring={state === 'restoring'}
        failure={null}
        onRestore={ignore}
        onOpenDocuments={ignore}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.lg },
}));
