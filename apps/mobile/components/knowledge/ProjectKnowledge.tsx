import type {
  KnowledgeDocument,
  KnowledgeFolder,
  KnowledgeOverview,
  KnowledgeSpace,
  KnowledgeWikiJob,
  VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { KnowledgeButton as Button } from './KnowledgeButton';
import { KnowledgeMarkdown } from './KnowledgeMarkdown';
import { styles } from './styles';

const jobStatusLabel: Record<KnowledgeWikiJob['status'], string> = {
  pending: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

/** Project guidance is an approved revision, so later wiki edits cannot silently change it. */
export function ProjectKnowledge({
  client,
  projectId,
  document,
  folders = [],
  blocked = false,
  onSpace,
}: {
  client: VerityClient;
  projectId: string;
  document?: KnowledgeDocument | null;
  folders?: KnowledgeFolder[];
  blocked?: boolean;
  onSpace?: (space: KnowledgeSpace) => void;
}) {
  const [space, setSpace] = useState<KnowledgeSpace | null>(null);
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [jobs, setJobs] = useState<KnowledgeWikiJob[]>([]);
  // Read-only: the model is picked in Settings. Kept here only so the tab can
  // say why nothing is happening — without it, a paused queue looks like a
  // broken one, and the reason lives on a screen nobody has a pointer to.
  const [modelSet, setModelSet] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [showOverview, setShowOverview] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setSpace(null);
    setOverview(null);
    setJobs([]);
    setError('');
    if (typeof client.getProjectKnowledgeSpace !== 'function') return;
    void Promise.all([
      client.getProjectKnowledgeSpace(projectId),
      client.getProjectKnowledgeOverview(projectId),
      client.listKnowledgeWikiJobs(projectId),
    ])
      .then(([nextSpace, nextOverview, nextJobs]) => {
        if (current !== generation.current) return;
        setSpace(nextSpace);
        setOverview(nextOverview);
        setJobs(nextJobs);
        onSpace?.(nextSpace);
      })
      .catch((failure: unknown) => {
        if (current === generation.current) setError(String(failure));
      });
    return () => {
      generation.current++;
    };
  }, [client, projectId, reload, onSpace]);
  // Read on its own, and on every focus: the fix for an unset model is one
  // screen away, and a banner that still accuses after the model was set is
  // worse than none. The model is a hint, not part of the tab — a server too
  // old for the endpoint, or one that fails the read, degrades to "cannot say"
  // instead of taking the Wiki, the briefing and the job list down with it.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void (
        typeof client.getVeritySettings === 'function'
          ? client.getVeritySettings().catch(() => undefined)
          : Promise.resolve(undefined)
      ).then((settings) => {
        if (current) setModelSet(settings === undefined ? null : Boolean(settings?.knowledgeModel));
      });
      return () => {
        current = false;
      };
    }, [client]),
  );
  useEffect(() => {
    if (!jobs.some((job) => job.status === 'pending' || job.status === 'running')) return;
    const timer = setTimeout(() => setReload((value) => value + 1), 2_000);
    return () => clearTimeout(timer);
  }, [jobs]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const current = generation.current;
    try {
      await action();
    } catch (failure) {
      if (current === generation.current) setError(String(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const start = (kind: KnowledgeWikiJob['kind'], sourceDocumentIds: string[]) => {
    const current = generation.current;
    void run(async () => {
      const job = await client.createKnowledgeWikiJob(projectId, {
        kind,
        sourceDocumentIds,
      });
      if (current === generation.current) setJobs((previous) => [job, ...previous]);
    });
  };
  const inside = (folderId: string, rootId: string): boolean => {
    const seen = new Set<string>();
    let id: string | null = folderId;
    while (id && !seen.has(id)) {
      if (id === rootId) return true;
      seen.add(id);
      id = folders.find((folder) => folder.id === id)?.parentId ?? null;
    }
    return false;
  };
  return (
    <View style={styles.group}>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {overview ? (
        <View style={styles.group}>
          <Text style={styles.muted}>Used as the project briefing for new sessions</Text>
          <Text style={styles.text}>{overview.title}</Text>
          <Button
            label={showOverview ? 'Hide project briefing' : 'Read project briefing'}
            onPress={() => setShowOverview((value) => !value)}
          />
          {showOverview ? <KnowledgeMarkdown body={overview.bodyMarkdown} /> : null}
          <Button
            label="Use the previous project notes instead"
            disabled={busy || blocked}
            onPress={() =>
              Alert.alert(
                'Project briefing',
                'Use the project notes from Settings for new sessions instead of this Wiki page?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Use previous notes',
                    onPress: () => {
                      void run(async () => {
                        await client.clearProjectKnowledgeOverview(projectId);
                        setReload((value) => value + 1);
                      });
                    },
                  },
                ],
              )
            }
          />
        </View>
      ) : null}
      {space && document && inside(document.folderId, space.wikiFolderId) ? (
        <Button
          icon="check"
          label="Use as project briefing"
          disabled={busy || blocked}
          onPress={() =>
            Alert.alert(
              'Use this page as the project briefing?',
              'New sessions will receive this exact version. If the page changes later, you can approve the new version separately.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Approve',
                  onPress: () => {
                    void run(async () => {
                      await client.approveProjectKnowledgeOverview(
                        projectId,
                        document.id,
                        document.currentRevisionId,
                      );
                      setReload((value) => value + 1);
                    });
                  },
                },
              ],
            )
          }
        />
      ) : null}
      {space ? (
        <>
          {modelSet === false ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                Choose a Knowledge model before this Wiki can update.
              </Text>
              <Button
                icon="cpu"
                label="Set the Knowledge model"
                onPress={() => router.push('/settings/knowledge')}
              />
            </>
          ) : null}
          {/* The server retains jobs as session history. This surface only needs
              the latest state and retry action; rendering every automatic retry
              turns one infrastructure failure into a wall of identical rows. */}
          {jobs
            .slice(0, 1)
            .filter((job) => job.status !== 'completed')
            .map((job) => (
              <View key={job.id} style={styles.row}>
                <Text style={job.status === 'failed' ? styles.error : styles.muted}>
                  {job.kind === 'ingest' ? 'Wiki update' : 'Wiki review'}{' '}
                  {jobStatusLabel[job.status].toLowerCase()}.
                </Text>
                <Button
                  icon="message-circle"
                  label="View details"
                  onPress={() =>
                    router.push({ pathname: '/session/[id]', params: { id: job.sessionId } })
                  }
                />
                {job.status === 'failed' ? (
                  <Button
                    label="Try again"
                    disabled={busy || blocked}
                    onPress={() =>
                      start(
                        job.kind,
                        job.sourceRevisions.map((source) => source.documentId),
                      )
                    }
                  />
                ) : null}
              </View>
            ))}
        </>
      ) : null}
    </View>
  );
}
