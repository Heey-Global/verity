import { useLocalSearchParams } from 'expo-router';

import { KnowledgeScreen } from '../../components/knowledge/KnowledgeBrowser';
import { SHARED } from '../../components/knowledge/knowledgeScope';

export default function SharedKnowledgeScreen() {
  // `path` is what links before folder/file named a file; it still opens it.
  const { folder, file, path } = useLocalSearchParams<{
    folder?: string;
    file?: string;
    path?: string;
  }>();
  return <KnowledgeScreen scope={SHARED} folder={folder} file={file ?? path} />;
}
