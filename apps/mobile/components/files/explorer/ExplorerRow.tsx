import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { IconName } from '../../Icon';
import { FileEntryRow } from '../FileEntryRow';
import { FileRowActions } from '../FileRowActions';
import { HeaderIconButton } from '../FileSheetHeader';

/**
 * One entry of any explorer — Code, Google Drive, Shared or project knowledge.
 * Folders and files differ only in their glyph; the row ends in exactly one
 * control: "⋯" for its menu, or the check circle while selecting. "⋯" is the
 * path that always works (touch, VoiceOver, mouse); a short swipe offers the
 * same menu ("More") and Delete as shortcuts, a right-click and the Delete key
 * do on the web, and a long press starts selecting.
 */
export function ExplorerRow({
  name,
  icon,
  meta,
  selecting = false,
  picked = false,
  inert = false,
  disabled = false,
  onPress,
  onLongPress,
  onMenu,
  onDelete,
  deleteLabel,
  wrap,
}: {
  name: string;
  icon: IconName;
  meta?: string | undefined;
  selecting?: boolean;
  picked?: boolean;
  /** Not a target here: dimmed and not pressable. */
  inert?: boolean;
  /** Pressable, but no menu or swipe while something else runs. */
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  onMenu?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  deleteLabel?: string;
  /** Wraps the pressable row only, as the native drag source needs. */
  wrap?: (row: ReactNode) => ReactNode;
}) {
  const row = (
    <FileEntryRow
      name={name}
      icon={icon}
      meta={meta}
      selecting={selecting}
      picked={picked}
      inert={inert}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  );
  const menu = !selecting && !inert && !disabled ? onMenu : undefined;
  return (
    <FileRowActions
      label={name}
      menuLabel="More"
      disabled={disabled || selecting || inert}
      onMenu={menu}
      onDelete={onDelete}
      {...(deleteLabel ? { deleteLabel } : {})}
    >
      <View style={styles.row}>
        <View style={styles.main}>{wrap ? wrap(row) : row}</View>
        {menu ? (
          <HeaderIconButton
            icon="more-horizontal"
            accessibilityLabel={`Actions for ${name}`}
            onPress={menu}
          />
        ) : null}
      </View>
    </FileRowActions>
  );
}

const styles = StyleSheet.create(() => ({
  row: { flexDirection: 'row', alignItems: 'center' },
  main: { flex: 1, minWidth: 0 },
}));
