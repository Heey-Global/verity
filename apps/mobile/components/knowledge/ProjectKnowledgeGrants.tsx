import type { KnowledgeFolder, KnowledgeGrant, VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { KnowledgeButton as Button } from './KnowledgeButton';
import { styles } from './styles';

export function ProjectKnowledgeGrants({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [grants, setGrants] = useState<KnowledgeGrant[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    let loaded = false;
    setFolders([]);
    setGrants([]);
    setError('');
    lock.current = true;
    setBusy(true);
    if (typeof client.listKnowledgeGrants !== 'function') return;
    void Promise.all([client.listKnowledgeFolders(), client.listKnowledgeGrants(projectId)])
      .then(([fs, gs]) => {
        if (active && current === generation.current) {
          loaded = true;
          setNeedsReload(false);
          setFolders(fs);
          setGrants(gs);
        }
      })
      .catch(() => {
        if (active) setError('Could not load knowledge access.');
      })
      .finally(() => {
        if (active && current === generation.current) {
          lock.current = !loaded;
          setNeedsReload(!loaded);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [client, projectId, reload]);
  const save = (next: KnowledgeGrant[]) => {
    if (lock.current) return;
    const current = generation.current;
    let authoritative = false;
    lock.current = true;
    setBusy(true);
    setError('');
    void client
      .saveKnowledgeGrants(projectId, next)
      .then((saved) => {
        if (current === generation.current) {
          authoritative = true;
          setGrants(saved);
        }
      })
      .catch(async (failure: unknown) => {
        if (current !== generation.current) return;
        setError(failure instanceof Error ? failure.message : 'Could not save knowledge access.');
        // A failed cleanup acknowledgement can follow a committed permission change.
        // Reload before another edit so stale UI cannot accidentally restore removed access.
        try {
          const saved = await client.listKnowledgeGrants(projectId);
          if (current === generation.current) {
            authoritative = true;
            setGrants(saved);
          }
        } catch {
          if (current === generation.current)
            setError('Could not reload saved access. Reload before editing.');
        }
      })
      .finally(() => {
        if (current === generation.current) {
          lock.current = !authoritative;
          setNeedsReload(!authoritative);
          setBusy(false);
        }
      });
  };
  const rows: {
    folder: KnowledgeFolder;
    depth: number;
    inherited: KnowledgeGrant['mode'] | null;
  }[] = [];
  const walk = (
    parentId: string | null,
    depth: number,
    inherited: KnowledgeGrant['mode'] | null,
    seen: Set<string>,
  ) => {
    for (const folder of folders.filter((f) => f.parentId === parentId)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      rows.push({ folder, depth, inherited });
      const direct = grants.find((g) => g.folderId === folder.id)?.mode;
      walk(
        folder.id,
        depth + 1,
        inherited === 'read_write' || direct === 'read_write'
          ? 'read_write'
          : (direct ?? inherited),
        seen,
      );
    }
  };
  walk(null, 0, null, new Set());
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>Knowledge access</Text>
      <Text style={styles.muted}>
        Select folders for agents. Access includes every subfolder. Read & Write permits document
        creation and edits shared immediately with other authorized projects. Your own library
        editing is independent.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {needsReload ? (
        <Button
          label="Reload knowledge access"
          disabled={busy}
          onPress={() => setReload((value) => value + 1)}
        />
      ) : null}
      {rows.map(({ folder, depth, inherited }) => {
        const direct = grants.find((g) => g.folderId === folder.id);
        const effective =
          inherited === 'read_write' || direct?.mode === 'read_write'
            ? 'Read & Write'
            : direct || inherited
              ? 'Read'
              : 'None';
        return (
          <View key={folder.id} style={[styles.group, { paddingLeft: Math.min(depth, 6) * 12 }]}>
            <Text style={styles.text}>
              {folder.name} — effective: {effective}
              {inherited
                ? ` (inherited ${inherited === 'read_write' ? 'Read & Write' : 'Read'})`
                : ''}
            </Text>
            <View style={styles.row}>
              <Button
                label={`${direct ? 'Remove' : 'Allow'} ${folder.name}`}
                disabled={busy || needsReload}
                onPress={() => {
                  const next = direct
                    ? grants.filter((g) => g.folderId !== folder.id)
                    : [...grants, { folderId: folder.id, mode: 'read' as const }];
                  if (direct)
                    Alert.alert(
                      'Change knowledge access',
                      'Removing access may retire affected session contexts.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Continue', onPress: () => save(next) },
                      ],
                    );
                  else save(next);
                }}
              />
              {direct ? (
                <Button
                  label={`${folder.name}: ${direct.mode === 'read' ? 'Read' : 'Read & Write'}`}
                  disabled={busy || needsReload}
                  onPress={() =>
                    save(
                      grants.map((g) =>
                        g.folderId === folder.id
                          ? { ...g, mode: g.mode === 'read' ? 'read_write' : 'read' }
                          : g,
                      ),
                    )
                  }
                />
              ) : null}
              <Button
                label={`Open ${folder.name} in Knowledge`}
                onPress={() =>
                  router.push({ pathname: '/knowledge', params: { folderId: folder.id } })
                }
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
