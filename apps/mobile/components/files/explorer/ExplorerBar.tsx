import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HeaderTextButton } from '../FileSheetHeader';

/** The bar under an explorer's list for what applies to the whole screen:
 *  the selection's Move…/Delete…, the folder picker's New folder…. */
export function ExplorerBar({ children }: { children: ReactNode }) {
  return <View style={styles.bar}>{children}</View>;
}

/** Move… and Delete… for every selected entry; disabled until one is chosen. */
export function SelectionBar({
  count,
  disabled = false,
  onMove,
  onDelete,
  deleteLabel = 'Delete…',
}: {
  count: number;
  disabled?: boolean;
  onMove?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  deleteLabel?: string;
}) {
  const off = disabled || count === 0;
  return (
    <ExplorerBar>
      {onMove ? (
        <HeaderTextButton
          label="Move…"
          disabled={off}
          accessibilityLabel="Move selected files"
          onPress={onMove}
        />
      ) : (
        <View />
      )}
      {onDelete ? (
        <HeaderTextButton
          label={deleteLabel}
          emphasis="destructive"
          disabled={off}
          accessibilityLabel="Delete selected files"
          onPress={onDelete}
        />
      ) : null}
    </ExplorerBar>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));
