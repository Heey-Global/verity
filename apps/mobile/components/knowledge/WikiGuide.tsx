import { WIKI_LOG, type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { View } from 'react-native';

import { Button, Group, IconButton, Row, SectionHeader, Sheet, Text } from '../ui';
import { useWikiCatalog } from './useWikiCatalog';

/** What a setup session is asked to do: a new Wiki, an overview for existing pages, or a rebuild. */
export type WikiSetupMode = 'setup' | 'overview' | 'rebuild';

const SETUP_REQUEST: Record<WikiSetupMode, string> = {
  setup: 'Set up this project’s Wiki.',
  overview: 'Create a start page for this project’s existing Wiki pages.',
  rebuild: 'Rebuild the start page of this project’s Wiki.',
};

/**
 * The first message of a Wiki setup session. The procedure lives in the
 * built-in wiki-maintain Skill; the message names it and the one promise the
 * user relies on: nothing is written before they confirm.
 */
function wikiSetupPrompt(mode: WikiSetupMode): string {
  return `${SETUP_REQUEST[mode]} Load the wiki-maintain skill and follow its setup steps: ask me your two questions first, then propose the topics, and write nothing until I confirm.`;
}

/** Opens a new session in the project with the setup request as its first turn. */
export function startWikiSetup(projectId: string, mode: WikiSetupMode): void {
  router.push({ pathname: '/new', params: { projectId, prompt: wikiSetupPrompt(mode) } });
}

/** Who does what in the Wiki, as the empty Wiki and "How the Wiki works" explain it. */
export function WikiRoles() {
  return (
    <Group>
      <Row
        leading={{ icon: 'paperclip' }}
        title="You bring sources and questions"
        subtitle="Meetings, finished sessions, merges, documents"
        wrap
      />
      <Row
        leading={{ icon: 'book-open' }}
        title="Verity writes and maintains"
        subtitle="Readable pages, every statement with its source"
        wrap
      />
      <Row
        leading={{ icon: 'check-circle' }}
        title="You confirm every change"
        subtitle="Verity asks before it changes a page"
        wrap
      />
    </Group>
  );
}

/**
 * The ⓘ beside the Wiki's title and the sheet it opens: the roles, this Wiki's
 * own rules and change log where they exist, and a rebuild of the overview.
 */
export function WikiInfoButton({
  client,
  projectId,
  onOpenFile,
}: {
  client: VerityClient;
  projectId: string;
  onOpenFile: (file: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const { catalog } = useWikiCatalog(client, projectId);
  const conventions = catalog?.conventions ?? null;
  const log = catalog?.log ?? null;
  const go = (action: () => void) => {
    setVisible(false);
    action();
  };
  return (
    <>
      <IconButton
        icon="info"
        accessibilityLabel="How the Wiki works"
        onPress={() => setVisible(true)}
      />
      <Sheet
        visible={visible}
        title="How the Wiki works"
        onClose={() => setVisible(false)}
        footer={
          catalog?.index ? (
            <Button
              label="Rebuild overview…"
              variant="secondary"
              onPress={() => go(() => startWikiSetup(projectId, 'rebuild'))}
              fullWidth
            />
          ) : undefined
        }
      >
        <WikiRoles />
        {conventions || log ? (
          <>
            <SectionHeader title="This Wiki" />
            <Group>
              {conventions ? (
                <Row
                  leading={{ icon: 'sliders' }}
                  title="How this Wiki is organized"
                  subtitle="Topics and page rules, changed with Verity"
                  navigates
                  onPress={() => go(() => onOpenFile(conventions.path))}
                />
              ) : null}
              {log ? (
                <Row
                  leading={{ icon: 'clock' }}
                  title="Change log"
                  subtitle="What changed, when and from which source"
                  navigates
                  onPress={() => go(() => onOpenFile(WIKI_LOG))}
                />
              ) : null}
            </Group>
          </>
        ) : null}
        <View style={styles.note}>
          <Text variant="footnote" tone="muted">
            Verity never follows instructions found inside a source and never researches or imports
            on its own.
          </Text>
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  note: { marginTop: theme.spacing.sm },
}));
