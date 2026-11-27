import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { KnowledgeScreen } from '../../../components/knowledge/KnowledgeBrowser';
import type { KnowledgeScope } from '../../../components/knowledge/knowledgeScope';
import { projectIdParam } from '../../../lib/useProjectDetail';

export default function ProjectKnowledgeScreen() {
  const { id, folder, file, path, proposal, edit } = useLocalSearchParams<{
    id: string | string[];
    folder?: string;
    file?: string;
    path?: string;
    proposal?: string;
    edit?: string;
  }>();
  const projectId = projectIdParam(id);
  const scope = useMemo<KnowledgeScope>(() => ({ kind: 'project', projectId }), [projectId]);
  // `path` is what links before folder/file named a file; it still opens it.
  return (
    <KnowledgeScreen
      scope={scope}
      folder={folder}
      file={file ?? path}
      edit={edit === '1'}
      proposal={proposal}
    />
  );
}
