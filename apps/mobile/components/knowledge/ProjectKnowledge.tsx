import type {
  KnowledgeDocument,
  KnowledgeFolder,
  KnowledgeOverview,
  KnowledgeSpace,
  KnowledgeWikiJob,
  VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { KnowledgeButton as Button } from './KnowledgeButton';
import { KnowledgeMarkdown } from './KnowledgeMarkdown';
import { styles } from './styles';
import { loadVeritySettings, saveVeritySettings, useVeritySettings } from '../../lib/settingsStore';

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  const [chooseModel, setChooseModel] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const { settings } = useVeritySettings();
  useEffect(() => {
    if (typeof client.getVeritySettings === 'function') void loadVeritySettings(client);
  }, [client]);
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
      ) : (
        <Text style={styles.muted}>
          New sessions currently use the project notes from Settings.
        </Text>
      )}
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
          <View style={styles.row}>
            <Button
              label={
                settings?.knowledgeModel
                  ? `Knowledge model: ${settings.knowledgeModel}`
                  : 'Knowledge model: automatic'
              }
              disabled={busy || blocked}
              onPress={() => {
                void run(async () => {
                  const result = await client.listModels();
                  setModels(result.models);
                  setChooseModel((value) => !value);
                });
              }}
            />
          </View>
          {chooseModel ? (
            <View style={styles.group}>
              <Button
                label="Choose automatically"
                onPress={() => {
                  void saveVeritySettings(client, { knowledgeModel: null });
                  setChooseModel(false);
                }}
              />
              {models.map((id) => (
                <Button
                  key={id}
                  label={id}
                  onPress={() => {
                    void saveVeritySettings(client, { knowledgeModel: id });
                    setChooseModel(false);
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text style={styles.muted}>
            New Sources are added to the Wiki automatically. This model is used system-wide; every
            job remains limited to its project.
          </Text>
          {jobs.slice(0, 10).map((job) => (
            <View key={job.id} style={styles.row}>
              <Button
                icon="message-circle"
                label={`${job.kind === 'ingest' ? 'Wiki update' : 'Wiki review'} · ${jobStatusLabel[job.status]} · ${String(job.sourceRevisions.length)} source${job.sourceRevisions.length === 1 ? '' : 's'}${job.model ? ` · ${job.model}` : ''}`}
                onPress={() =>
                  router.push({ pathname: '/session/[id]', params: { id: job.sessionId } })
                }
              />
              {job.error ? <Text style={styles.error}>{job.error}</Text> : null}
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
