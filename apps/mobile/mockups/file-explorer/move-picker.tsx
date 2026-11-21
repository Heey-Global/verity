import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FileBreadcrumb } from '../../components/files/FileBreadcrumb';
import { FileSheetHeader, HeaderTextButton } from '../../components/files/FileSheetHeader';
import { ResizableSheetPanel } from '../../components/files/ResizableSheet';
import { EntryList, ExplorerBar, ignore, LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/**
 * "Move…" opens the explorer as a folder picker in the same sheet as Files:
 * Cancel and Move where the selection has Select All and Done, the breadcrumb
 * always shown because it names the destination, files dimmed, and the bar
 * under the list for New folder…. It stays inside the entry's own area.
 */
export default function MovePickerMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      overlay={
        <View style={styles.overlay}>
          <View style={styles.scrim} />
          <ResizableSheetPanel>
            <FileSheetHeader
              leading={<HeaderTextButton label="Cancel" onPress={ignore} />}
              title="Move 1 item"
              trailing={<HeaderTextButton label="Move" emphasis="strong" onPress={ignore} />}
            />
            <FileBreadcrumb
              rootIcon="book-open"
              rootLabel="Wiki"
              segments={[{ key: 'verity-uplink', name: 'verity-uplink' }]}
              onNavigate={ignore}
            />
            <EntryList
              picker
              entries={[
                { name: 'protocols', folder: true, meta: '5 items' },
                { name: 'pricing', folder: true, meta: '2 items' },
                { name: 'overview.md', meta: '2 KB · Nov 10' },
                { name: 'roadmap.md', meta: '1 KB · Nov 4' },
              ]}
            />
            <ExplorerBar>
              <HeaderTextButton label="New folder…" onPress={ignore} />
            </ExplorerBar>
          </ResizableSheetPanel>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 10 },
  scrim: { flex: 1, backgroundColor: theme.colors.scrim },
}));
