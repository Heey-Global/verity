import type { VerityClient, WikiProposal, WikiProposalDecision } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { proposalPassages, type ProposalPassage } from '../../lib/wikiProposalDiff';
import { SettingsScaffold } from '../settings/SettingsChrome';
import { Button, Group, Row, SectionHeader, Text, ToggleRow, useConfirm } from '../ui';
import { pushKnowledge, type KnowledgeScope } from './knowledgeScope';
import { invalidateWikiCatalog, useWikiCatalog } from './useWikiCatalog';
import { invalidateWikiProposals } from './useWikiProposals';
import { catalogTitle, wikiDayInline } from './WikiViews';

/** Passages shown per page before the rest is only counted. */
const PASSAGES_SHOWN = 4;

/** One passage of a page: what it replaces, then what it becomes. */
function Passage({ passage }: { passage: ProposalPassage }) {
  return (
    <View style={styles.passage}>
      {passage.before !== undefined ? (
        <>
          <Text variant="footnote" tone="muted">
            {passage.after !== undefined ? 'Before' : 'Removed'}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {passage.before}
          </Text>
        </>
      ) : null}
      {passage.after !== undefined ? (
        <>
          <Text variant="footnote" tone="muted">
            {passage.before !== undefined ? 'After' : 'New'}
          </Text>
          <Text variant="bodySmall">{passage.after}</Text>
        </>
      ) : null}
    </View>
  );
}

function sourceRow(source: string, scope: KnowledgeScope) {
  const web = /^https?:\/\//i.test(source);
  const knowledge = source.replace(/^\/knowledge\//, '');
  const file = /^(sources|insights)\//.test(knowledge) ? knowledge : null;
  const name = web ? source : (knowledge.split('/').at(-1) ?? knowledge);
  const open = web
    ? () => void Linking.openURL(source)
    : file
      ? () => pushKnowledge(scope, { file })
      : undefined;
  return (
    <Row
      key={source}
      leading={{
        icon: web ? 'globe' : knowledge.startsWith('sources/meetings/') ? 'mic' : 'file-text',
      }}
      title={name.replace(/\.md$/i, '')}
      subtitle={web ? 'Web page' : file ? knowledge : undefined}
      {...(open ? { navigates: true, onPress: open } : {})}
    />
  );
}

/** What a decision left undone, in the user's words; empty when it all went through. */
function decisionNotice(result: WikiProposalDecision): string {
  const parts: string[] = [];
  if (result.stale.length)
    parts.push(
      `${String(result.stale.length)} ${result.stale.length === 1 ? 'page was' : 'pages were'} edited since the proposal and left as ${result.stale.length === 1 ? 'it is' : 'they are'}.`,
    );
  if (result.failed.length)
    parts.push(
      `${String(result.failed.length)} ${result.failed.length === 1 ? 'page' : 'pages'} could not be saved.`,
    );
  if (result.warning) parts.push(result.warning);
  return parts.join(' ');
}

/**
 * One proposal before it reaches the Wiki: where it comes from, then each page
 * with the passages it changes. Every page can be left out; applying writes the
 * chosen ones and rejects the rest, so the proposal is done in one step.
 */
export function WikiProposalScreen({
  client,
  projectId,
  proposalId,
}: {
  client: VerityClient;
  projectId: string;
  proposalId: string;
}) {
  const scope = useMemo<KnowledgeScope>(() => ({ kind: 'project', projectId }), [projectId]);
  const { catalog } = useWikiCatalog(client, projectId);
  const [confirm, confirmSheet] = useConfirm();
  const [proposal, setProposal] = useState<WikiProposal>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    client.getWikiProposal(projectId, proposalId).then(
      (loaded) => {
        if (!active) return;
        setProposal(loaded);
        // A page edited since cannot be applied; it starts left out.
        setLeft(
          new Set(
            loaded.changes
              .filter((change) => change.status === 'pending' && change.stale)
              .map((change) => change.path),
          ),
        );
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Could not load the proposal');
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, proposalId, attempt]);

  const pending = (proposal?.changes ?? []).filter((change) => change.status === 'pending');
  const chosen = pending.filter((change) => !left.has(change.path)).map((change) => change.path);
  const omitted = pending.filter((change) => left.has(change.path)).map((change) => change.path);
  // A page the catalog does not know yet (a new one) goes by its file name.
  const title = (path: string) =>
    (catalog
      ? catalogTitle(catalog, `insights/${path}`)
      : (path.split('/').at(-1) ?? path)
    ).replace(/\.md$/i, '');

  const decide = useCallback(
    async (apply: readonly string[], reject: readonly string[]) => {
      setSaving(true);
      setError(undefined);
      try {
        let notes = '';
        if (apply.length)
          notes = decisionNotice(
            await client.decideWikiProposal(projectId, proposalId, 'apply', apply),
          );
        if (reject.length) await client.decideWikiProposal(projectId, proposalId, 'reject', reject);
        invalidateWikiCatalog(projectId);
        invalidateWikiProposals(projectId);
        if (notes) {
          setNotice(notes);
          setAttempt((value) => value + 1);
        } else if (router.canGoBack()) router.back();
        else setAttempt((value) => value + 1);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not save the decision');
        setAttempt((value) => value + 1);
      } finally {
        setSaving(false);
      }
    },
    [client, projectId, proposalId],
  );

  const footer =
    proposal && pending.length ? (
      <View style={styles.footer}>
        <View style={styles.flex}>
          <Button
            label="Reject"
            variant="secondary"
            disabled={saving}
            onPress={() =>
              confirm({
                title: 'Reject this proposal?',
                message: 'Its changes are not applied and Verity will not propose them again.',
                confirmLabel: 'Reject',
                destructive: true,
                onConfirm: () =>
                  decide(
                    [],
                    pending.map((change) => change.path),
                  ),
              })
            }
            fullWidth
          />
        </View>
        <View style={styles.flex}>
          <Button
            label={`Apply ${String(chosen.length)} ${chosen.length === 1 ? 'change' : 'changes'}`}
            disabled={saving || !chosen.length}
            onPress={() => void decide(chosen, omitted)}
            fullWidth
          />
        </View>
      </View>
    ) : undefined;

  return (
    <SettingsScaffold
      title="Proposed change"
      detail
      state={{ error, saving }}
      onRetry={() => setAttempt((value) => value + 1)}
      {...(footer ? { footer } : {})}
    >
      {proposal === undefined ? (
        error ? null : (
          <ActivityIndicator />
        )
      ) : (
        <View style={styles.root} testID="wiki-proposal">
          <View style={styles.head}>
            <Text variant="title">{proposal.title}</Text>
            <Text variant="footnote" tone="muted">
              {pending.length
                ? `Prepared ${wikiDayInline(proposal.createdAt)} · ${String(pending.length)} ${pending.length === 1 ? 'page' : 'pages'} to review`
                : 'Decided'}
            </Text>
            {notice ? <Text variant="bodySmall">{notice}</Text> : null}
          </View>

          {proposal.sources.length ? (
            <>
              <SectionHeader title="Sources" />
              <Group>{proposal.sources.map((source) => sourceRow(source, scope))}</Group>
            </>
          ) : null}

          {pending.length ? (
            <SectionHeader
              title={`Changes · ${String(chosen.length)} of ${String(pending.length)} selected`}
            />
          ) : null}
          {pending.map((change) => {
            const passages = proposalPassages(change.current, change.content ?? '');
            return (
              <Group key={change.path}>
                <ToggleRow
                  title={`${title(change.path)} · ${change.summary}`}
                  subtitle={
                    change.stale
                      ? 'Edited since the proposal · cannot be applied'
                      : change.current === null
                        ? 'New page'
                        : undefined
                  }
                  value={!left.has(change.path)}
                  disabled={saving || change.stale}
                  onValueChange={(value) =>
                    setLeft((previous) => {
                      const next = new Set(previous);
                      if (value) next.delete(change.path);
                      else next.add(change.path);
                      return next;
                    })
                  }
                />
                {passages.slice(0, PASSAGES_SHOWN).map((passage, position) => (
                  <Passage key={position} passage={passage} />
                ))}
                {passages.length > PASSAGES_SHOWN ? (
                  <View style={styles.passage}>
                    <Text variant="footnote" tone="muted">
                      {`${String(passages.length - PASSAGES_SHOWN)} more changed ${passages.length - PASSAGES_SHOWN === 1 ? 'passage' : 'passages'}`}
                    </Text>
                  </View>
                ) : null}
              </Group>
            );
          })}
        </View>
      )}
      {confirmSheet}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  head: { gap: theme.spacing.xs },
  passage: { padding: theme.spacing.md, gap: theme.spacing.xs },
  footer: { flexDirection: 'row', gap: theme.spacing.sm },
  flex: { flex: 1 },
}));
