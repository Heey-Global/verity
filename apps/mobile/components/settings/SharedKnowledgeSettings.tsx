import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { loadSharingModule } from '../../lib/sessionFileUi';
import { fileNameFromPath } from '../../lib/fileSelection';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionDirectory, SessionFileContent } from '@verity/mobile';
import { createVerityClient } from '../../lib/client';
import { Button, TextField } from '../ui';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from './SettingsChrome';

export function SharedKnowledgeSettings({
  initialPath,
  projectId,
}: {
  initialPath?: string;
  projectId?: string;
}) {
  const client = useMemo(() => createVerityClient(), []);
  const [path, setPath] = useState('');
  const title = projectId ? 'Project knowledge' : 'Shared knowledge';
  const [filePath, setFilePath] = useState<string | undefined>(initialPath);
  const [directory, setDirectory] = useState<SessionDirectory>();
  const [file, setFile] = useState<SessionFileContent>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const retryDraft = useRef<{ path: string; content: string } | undefined>(undefined);
  useEffect(() => {
    if (!client) return;
    let active = true;
    setFile(undefined);
    setDirectory(undefined);
    setError(undefined);
    setLoading(true);
    const load = async () => {
      try {
        if (filePath !== undefined) {
          const next = await (projectId
            ? client.getProjectKnowledgeFile(projectId, filePath)
            : client.getSharedKnowledgeFile(filePath));
          if (active) {
            setFile(next);
            setDraft(
              retryDraft.current?.path === filePath ? retryDraft.current.content : next.content,
            );
            retryDraft.current = undefined;
          }
        } else {
          const next = await (projectId
            ? client.listProjectKnowledgeFiles(projectId, path)
            : client.listSharedKnowledgeFiles(path));
          if (active) setDirectory(next);
        }
      } catch (failure) {
        if (active)
          setError(failure instanceof Error ? failure.message : `Could not load ${title}`);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [client, path, filePath, reload, projectId, title]);
  if (!client)
    return (
      <SettingsMessage
        screenTitle={title}
        title="Server unavailable"
        subtitle={`Connect to your Verity server to browse ${title}.`}
      />
    );
  const back = () => {
    if (filePath !== undefined) {
      setPath(filePath.split('/').slice(0, -1).join('/'));
      setFilePath(undefined);
    } else setPath(path.split('/').slice(0, -1).join('/'));
  };
  const save = async () => {
    if (!file || !file.version || filePath === undefined || saving || loading) return;
    setSaving(true);
    try {
      const next = await (projectId
        ? client.writeProjectKnowledgeFile(projectId, filePath, draft, file.version)
        : client.writeSharedKnowledgeFile(filePath, draft, file.version));
      setFile(next);
      setDraft(next.content);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not save ${title}`);
    } finally {
      setSaving(false);
    }
  };
  const download = async () => {
    if (filePath === undefined || saving) return;
    setSaving(true);
    try {
      const blob = await (projectId
        ? client.downloadProjectKnowledgeFile(projectId, filePath)
        : client.downloadSharedKnowledgeFile(filePath));
      const name = fileNameFromPath(filePath);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const directory = new Directory(Paths.cache, 'shared-knowledge');
        directory.create({ intermediates: true, idempotent: true });
        const target = new File(directory, name);
        target.write(new Uint8Array(await blob.arrayBuffer()));
        const sharing = await loadSharingModule();
        if (!sharing || !(await sharing.isAvailableAsync()))
          throw new Error('No app is available to open this file');
        await sharing.shareAsync(target.uri);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not download file');
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsScaffold
      title={title}
      detail
      state={{ error, saving }}
      onRetry={() => {
        if (saving || loading) return;
        if (filePath !== undefined && file) retryDraft.current = { path: filePath, content: draft };
        setReload((value) => value + 1);
      }}
    >
      <SettingsGroup
        title={filePath ?? (path || (projectId ? 'Project library' : 'Shared library'))}
        description={
          projectId
            ? 'Decisions, Wiki and original sources for this project. Wiki edits require project management access.'
            : 'Reference material shared across projects. Agents can read it from every project. Administrators can edit supported text files; original sources remain protected.'
        }
      >
        {path || filePath !== undefined ? (
          <Button label="Back to folder" variant="secondary" disabled={saving} onPress={back} />
        ) : null}
        {projectId && filePath === undefined ? (
          <SettingsListPanel>
            {(
              [
                ['Decisions', 'insights/decisions'],
                ['Wiki', 'insights'],
                ['Raw Sources', 'sources'],
              ] as const
            ).map(([label, folder]) => (
              <SettingsNavRow
                key={folder}
                icon="folder"
                title={label}
                onPress={() => setPath(folder)}
              />
            ))}
          </SettingsListPanel>
        ) : null}
        {directory && (!projectId || path) ? (
          <SettingsListPanel>
            {directory.entries.map((entry) => (
              <SettingsNavRow
                key={entry.path}
                icon={entry.kind === 'directory' ? 'folder' : 'file-text'}
                title={entry.name}
                onPress={() => {
                  if (entry.kind === 'directory') setPath(entry.path);
                  else setFilePath(entry.path);
                }}
              />
            ))}
          </SettingsListPanel>
        ) : null}
        {directory?.entries.length === 0 && (!projectId || path) ? (
          <SettingsPanel>
            <TextField
              label="Library"
              value="No documents in this folder"
              disabled
              onChangeText={() => undefined}
            />
          </SettingsPanel>
        ) : null}
        {directory?.truncated ? (
          <SettingsPanel>
            <TextField
              label="Listing limit"
              value="This folder has more files than can be shown. Organize it into smaller folders."
              disabled
              onChangeText={() => undefined}
            />
          </SettingsPanel>
        ) : null}
        {filePath !== undefined ? (
          <Button
            label="Download original"
            variant="secondary"
            disabled={saving}
            onPress={() => void download()}
          />
        ) : null}
        {file ? (
          <SettingsPanel>
            <TextField
              label="Content"
              value={draft}
              onChangeText={setDraft}
              multiline
              disabled={file.editable !== true || saving || loading}
            />
            {file.editable && file.version ? (
              <Button
                label="Save"
                disabled={saving || loading || draft === file.content}
                onPress={() => void save()}
              />
            ) : null}
          </SettingsPanel>
        ) : null}
      </SettingsGroup>
    </SettingsScaffold>
  );
}
