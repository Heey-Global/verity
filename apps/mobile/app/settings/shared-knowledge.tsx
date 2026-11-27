import { useLocalSearchParams } from 'expo-router';

import { KnowledgeScreen } from '../../components/knowledge/KnowledgeBrowser';
import { SHARED } from '../../components/knowledge/knowledgeScope';

export default function SharedKnowledgeScreen() {
  // `path` is what links before folder/file named a file; it still opens it.
  const { folder, file, path, edit } = useLocalSearchParams<{
    folder?: string;
    file?: string;
    path?: string;
    edit?: string;
  }>();
  return <KnowledgeScreen scope={SHARED} folder={folder} file={file ?? path} edit={edit === '1'} />;
}
