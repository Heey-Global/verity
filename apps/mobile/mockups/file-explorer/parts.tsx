import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { IconName } from '../../components/Icon';
import { FileBreadcrumb } from '../../components/files/FileBreadcrumb';
import { FileEntryRow } from '../../components/files/FileEntryRow';
import { FileTabs, type FileTab } from '../../components/files/FileRootTabs';
import {
  FileSheetHeader,
  HeaderIconButton,
  HeaderTextButton,
} from '../../components/files/FileSheetHeader';
import { ResizableSheetPanel } from '../../components/files/ResizableSheet';
import { SwipeActionLane } from '../../components/ui/SwipeActions';

export const ignore = () => undefined;

export interface SampleEntry {
  name: string;
  folder?: boolean;
  icon?: IconName;
  meta?: string;
  inert?: boolean;
}

export interface ListState {
  selecting?: boolean;
  picked?: readonly string[];
  /** The row held open by a swipe, showing its two shortcuts. */
  swiped?: string;
  /** A folder picker: folders navigate, files are dimmed, no row has a menu. */
  picker?: boolean;
}

/**
 * One row layout for every place and kind: glyph, name over detail, and one
 * trailing control — "⋯" for the row's menu, or the check circle while
 * selecting. Folders and files differ only in their glyph, as in Drive and
 * Files; tapping a folder opens it. Swipe, long press and right-click are
 * shortcuts to the menu's actions, never the only way to them.
 */
export function EntryList({
  entries,
  selecting = false,
  picked = [],
  swiped,
  picker = false,
}: { entries: readonly SampleEntry[] } & ListState) {
  return (
    <ScrollView style={styles.list}>
      {entries.map((entry) => {
        const folder = entry.folder === true;
        const inert = (entry.inert ?? false) || (picker && !folder) || (selecting && folder);
        const more = !selecting && !picker && !inert;
        return (
          <View key={entry.name} style={styles.entry}>
            <View style={[styles.entryRow, swiped === entry.name ? styles.slid : null]}>
              <View style={styles.flex}>
                <FileEntryRow
                  name={entry.name}
                  icon={entry.icon ?? (folder ? 'folder' : 'file-text')}
                  meta={entry.meta}
                  inert={inert}
                  selecting={selecting && !folder}
                  picked={picked.includes(entry.name)}
                  onPress={ignore}
                />
              </View>
              {more ? (
                <HeaderIconButton
                  icon="more-horizontal"
                  accessibilityLabel={`Actions for ${entry.name}`}
                  onPress={ignore}
                />
              ) : null}
            </View>
            {swiped === entry.name ? (
              <SwipeActionLane
                actions={[
                  {
                    key: 'more',
                    label: 'More',
                    icon: 'more-horizontal',
                    tone: 'action',
                    onPress: ignore,
                  },
                  {
                    key: 'delete',
                    label: 'Delete',
                    icon: 'trash-2',
                    tone: 'destructive',
                    onPress: ignore,
                  },
                ]}
              />
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

/** The bar under the list for what applies to the whole screen's state:
 *  the selection's Move…/Delete…, the picker's New folder…. */
export function ExplorerBar({ children }: { children: ReactNode }) {
  return <View style={styles.bar}>{children}</View>;
}

export function SelectionHeader({ count }: { count: number }) {
  return (
    <FileSheetHeader
      leading={<HeaderTextButton label="Select All" onPress={ignore} />}
      title={`${count} selected`}
      trailing={<HeaderTextButton label="Done" emphasis="strong" onPress={ignore} />}
    />
  );
}

export function SelectionBar({ count }: { count: number }) {
  return (
    <ExplorerBar>
      <HeaderTextButton label="Move…" disabled={count === 0} onPress={ignore} />
      <HeaderTextButton
        label="Delete…"
        emphasis="destructive"
        disabled={count === 0}
        onPress={ignore}
      />
    </ExplorerBar>
  );
}

interface ExplorerBody {
  tabs: readonly FileTab[];
  /** Root label and icon of the active tab, for the breadcrumb below its top. */
  root: { label: string; icon: IconName };
  /** Folders below the tab's top; none means the tab itself says where you are. */
  segments?: readonly string[];
  entries: readonly SampleEntry[];
  list?: ListState;
  /** Replaces the header, as the selection does. */
  header?: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
}

function Body({ tabs, root, segments = [], entries, list, footer }: ExplorerBody) {
  return (
    <>
      <FileTabs tabs={tabs} />
      {segments.length > 0 ? (
        <FileBreadcrumb
          rootIcon={root.icon}
          rootLabel={root.label}
          segments={segments.map((name) => ({ key: name, name }))}
          onNavigate={ignore}
        />
      ) : null}
      <EntryList entries={entries} {...list} />
      {footer}
    </>
  );
}

const addButton = <HeaderIconButton icon="plus" tint accessibilityLabel="Add" onPress={ignore} />;

/**
 * A library page — Settings › Shared knowledge, a project's Knowledge — laid
 * out like the Files sheet: the screen's header carries its title and the +,
 * tabs switch between Wiki and Sources, the breadcrumb appears below a tab's
 * top, then the rows. The page's own navigation header plays the sheet
 * header's part, so nothing names the place twice.
 */
export function LibraryExplorer(props: ExplorerBody & { title: string; selected?: number }) {
  return (
    <View style={styles.page}>
      <Stack.Screen
        options={
          props.selected === undefined
            ? { title: props.title, headerRight: () => addButton }
            : {
                // Selecting takes over the page's header, as it takes over the sheet's.
                title: `${props.selected} selected`,
                headerLeft: () => <HeaderTextButton label="Select All" onPress={ignore} />,
                headerRight: () => (
                  <HeaderTextButton label="Done" emphasis="strong" onPress={ignore} />
                ),
              }
        }
      />
      <View style={styles.pageBody}>
        <Body {...props} />
      </View>
      {props.overlay}
    </View>
  );
}

export function sharedTabs(active: 'wiki' | 'sources'): FileTab[] {
  return [
    { key: 'wiki', icon: 'book-open', label: 'Wiki', active: active === 'wiki', onPress: ignore },
    {
      key: 'sources',
      icon: 'paperclip',
      label: 'Sources',
      active: active === 'sources',
      onPress: ignore,
    },
  ];
}

/** A session's Files sheet: the same layout inside the sheet's own header. */
export function SessionExplorer(props: ExplorerBody) {
  return (
    <View style={styles.page}>
      <View style={styles.scrim} />
      <ResizableSheetPanel>
        {props.header ?? (
          <FileSheetHeader
            title="Files"
            trailing={
              <>
                {addButton}
                <HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={ignore} />
              </>
            }
          />
        )}
        <Body {...props} />
      </ResizableSheetPanel>
      {props.overlay}
    </View>
  );
}

export function sessionTabs(active: 'code' | 'drive'): FileTab[] {
  return [
    { key: 'code', icon: 'folder', label: 'Code', active: active === 'code', onPress: ignore },
    {
      key: 'drive',
      icon: 'hard-drive',
      label: 'Google Drive',
      active: active === 'drive',
      onPress: ignore,
    },
  ];
}

export const SHARED_WIKI: readonly SampleEntry[] = [
  { name: 'verity-uplink', folder: true, meta: '3 items' },
  { name: 'holger-steckbrief.md', meta: '4 KB · Nov 12' },
  { name: 'holger-values-purpose.md', meta: '3 KB · Nov 12' },
  { name: 'tone-of-voice.md', meta: '6 KB · Nov 18' },
];

/** The menu every file row opens; a folder's lacks Open with and Edit text. */
export const FILE_ACTIONS = [
  { key: 'open', label: 'Open', icon: 'file' as const },
  { key: 'select', label: 'Select', icon: 'check-circle' as const },
  { key: 'open-with', label: 'Open with another app', icon: 'share' as const },
  { key: 'edit', label: 'Edit text', icon: 'edit' as const },
  { key: 'rename', label: 'Rename…', icon: 'edit-2' as const },
  { key: 'move', label: 'Move…', icon: 'folder' as const },
];

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background },
  pageBody: { flex: 1, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm },
  scrim: { flex: 1, backgroundColor: theme.colors.scrim },
  list: { flex: 1 },
  entry: { flexDirection: 'row', overflow: 'hidden' },
  entryRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  slid: { minWidth: 0, backgroundColor: theme.colors.surface },
  flex: { flex: 1, minWidth: 0 },
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
