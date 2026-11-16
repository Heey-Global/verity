import { Fragment, type ReactNode } from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import type { SessionProjectGroup } from '../../lib/projectGroups';
import { OtherServerProjects } from './OtherServerProjects';

/**
 * Below the Home project list: the projects of the other servers this app knows,
 * then the paused projects. Styled by the list it closes, so it reads as one.
 */
export function ProjectListFooter({
  pausedGroups,
  renderGroup,
  styles,
}: {
  pausedGroups: readonly SessionProjectGroup[];
  renderGroup: (group: SessionProjectGroup) => ReactNode;
  styles: {
    pausedSection: StyleProp<ViewStyle>;
    sectionHeaderRow: StyleProp<ViewStyle>;
    sectionHeader: StyleProp<TextStyle>;
    pausedCount: StyleProp<TextStyle>;
    pausedList: StyleProp<ViewStyle>;
  };
}) {
  return (
    <>
      <OtherServerProjects />
      {pausedGroups.length > 0 ? (
        <View style={styles.pausedSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeader}>Paused</Text>
            <Text style={styles.pausedCount}>{pausedGroups.length}</Text>
          </View>
          <View style={styles.pausedList}>
            {pausedGroups.map((group) => (
              <Fragment key={group.id}>{renderGroup(group)}</Fragment>
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}
