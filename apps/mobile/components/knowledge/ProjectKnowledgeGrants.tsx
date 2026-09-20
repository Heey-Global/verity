import type { KnowledgeFolder, KnowledgeGrant, VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { KnowledgeButton as Button } from './KnowledgeButton';
import { styles } from './styles';
import { Icon } from '../Icon';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export function ProjectKnowledgeGrants({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const { theme } = useUnistyles();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
      .saveKnowledgeGrants(
        projectId,
        next.filter((grant) => !grant.fixed),
      )
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
      if (collapsed.has(folder.id)) continue;
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
        Your Sources, Wiki, and General are always connected. Check additional folders below.
        Subfolders inherit access.
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
        const fixed = !!direct?.fixed;
        let ancestor: KnowledgeFolder | undefined = folder;
        let readOnly = false;
        const seen = new Set<string>();
        while (ancestor && !seen.has(ancestor.id)) {
          seen.add(ancestor.id);
          if (ancestor.role === 'sources' || ancestor.role === 'general') readOnly = true;
          ancestor = folders.find((entry) => entry.id === ancestor?.parentId);
        }
        const effective = readOnly
          ? direct || inherited
            ? 'Read'
            : 'None'
          : inherited === 'read_write' || direct?.mode === 'read_write'
            ? 'Read & Write'
            : direct || inherited
              ? 'Read'
              : 'None';
        return (
          <View key={folder.id} style={[tree.row, { paddingLeft: Math.min(depth, 6) * 16 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${collapsed.has(folder.id) ? 'Expand' : 'Collapse'} ${folder.name}`}
              accessibilityState={{ expanded: !collapsed.has(folder.id) }}
              disabled={!folders.some((f) => f.parentId === folder.id)}
              style={tree.icon}
              onPress={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(folder.id)) next.delete(folder.id);
                  else next.add(folder.id);
                  return next;
                })
              }
            >
              <Icon
                name={collapsed.has(folder.id) ? 'chevron-right' : 'chevron-down'}
                size={16}
                color={
                  folders.some((f) => f.parentId === folder.id)
                    ? theme.colors.textMuted
                    : 'transparent'
                }
              />
            </Pressable>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`${fixed ? 'Always connected:' : direct ? 'Remove' : 'Allow'} ${folder.name}`}
              accessibilityState={{
                checked: !!(direct || inherited),
                disabled: busy || needsReload || fixed || (!!inherited && !direct),
              }}
              disabled={busy || needsReload || fixed || (!!inherited && !direct)}
              style={tree.icon}
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
            >
              <Icon
                name={direct || inherited ? 'check-square' : 'square'}
                size={18}
                color={inherited && !direct ? theme.colors.textMuted : theme.colors.text}
              />
            </Pressable>
            <Pressable
              style={tree.name}
              accessibilityRole="button"
              accessibilityLabel={`Open ${folder.name} in Knowledge`}
              onPress={() =>
                router.push({ pathname: '/knowledge', params: { folderId: folder.id, projectId } })
              }
            >
              <Icon name="folder" size={18} color={theme.colors.textMuted} />
              <Text numberOfLines={1} style={tree.label}>
                {folder.name}
              </Text>
            </Pressable>
            {fixed ? (
              <Text style={tree.inherited}>{effective} · always connected</Text>
            ) : readOnly && (direct || inherited) ? (
              <Text style={tree.inherited} accessibilityLabel={`${folder.name}: Read only`}>
                Read only
              </Text>
            ) : (direct || inherited) && inherited !== 'read_write' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${folder.name}: ${effective}`}
                accessibilityHint="Change between read and read and write access"
                disabled={busy || needsReload}
                style={tree.mode}
                onPress={() =>
                  Alert.alert('Folder access', folder.name, [
                    { text: 'Cancel', style: 'cancel' },
                    ...(['read', 'read_write'] as const).map((mode) => ({
                      text: mode === 'read' ? 'Read' : 'Read & Write',
                      onPress: () =>
                        save([
                          ...grants.filter((g) => g.folderId !== folder.id),
                          { folderId: folder.id, mode },
                        ]),
                    })),
                  ])
                }
              >
                <Text style={styles.muted}>
                  {effective}
                  {inherited ? ' · inherited' : ''}
                </Text>
                <Icon name="chevron-down" size={12} color={theme.colors.textMuted} />
              </Pressable>
            ) : inherited ? (
              <Text
                style={tree.inherited}
                accessibilityLabel={`${folder.name}: inherited ${effective}`}
              >
                {effective} · inherited
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const tree = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  icon: { width: 32, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  label: { flex: 1, color: theme.colors.text, fontSize: 14 },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 44 },
  inherited: { color: theme.colors.textMuted, fontSize: 11, maxWidth: 105 },
}));
