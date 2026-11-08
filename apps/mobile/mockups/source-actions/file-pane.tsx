import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FileContentPreview } from '../../components/files/FileContentPreview';
import { FileSheetHeader, HeaderIconButton } from '../../components/files/FileSheetHeader';
import { MarkdownItem } from '../../components/files/MarkdownItem';
import { Group, Row } from '../../components/ui';
import { LibraryLayout, LibraryPath } from './parts';

const ignore = () => undefined;

const FILE = '2026-10-06-live-meeting-2c5fda9c.md';
const CONTENT = `# Live meeting 2026-10-06 21:44 UTC

- Date: 2026-10-06
- Duration: 01:57
- Source: live meeting recording (audio not kept)

## Transcript

_Nothing was transcribed._
`;

/**
 * An open source in the right column: the header keeps the same side margin as
 * the text below it and some room above, instead of sitting on the edge.
 */
export default function FilePaneMockup() {
  return (
    <LibraryLayout
      list={
        <>
          <LibraryPath levels={['Sources', 'meetings']} />
          <Group>
            <Row leading={{ icon: 'file-text' }} title={FILE} navigates onPress={ignore} />
            <Row
              leading={{ icon: 'file-text' }}
              title="2026-10-07-live-meeting-b8b01bbc.md"
              navigates
              onPress={ignore}
            />
          </Group>
        </>
      }
      pane={
        <View style={styles.pane}>
          <View style={styles.header}>
            <FileSheetHeader
              title={FILE}
              subtitle="meetings"
              trailing={
                <View style={styles.actions}>
                  <HeaderIconButton
                    icon="download"
                    accessibilityLabel="Download original"
                    onPress={ignore}
                  />
                  <HeaderIconButton icon="x" accessibilityLabel="Close file" onPress={ignore} />
                </View>
              }
            />
          </View>
          <View style={styles.reader}>
            <FileContentPreview
              path={FILE}
              content={CONTENT}
              listStyle={styles.list}
              bodyStyle={styles.listBody}
              renderMarkdown={(item) => <MarkdownItem item={item} />}
            />
          </View>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  reader: { flex: 1, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm },
  list: { flex: 1 },
  listBody: { paddingVertical: theme.spacing.md, gap: theme.spacing.xs },
}));
