// The one destructive project action, shared by the settings index that offers
// it. Kept out of the screen so the confirmation wording and the navigation
// after a successful delete are decided once.
import {
  VerityApiError,
  projectDisplayName,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

export function useDeleteProject(
  client: VerityClient,
  onError: (message: string | undefined) => void,
): [deleting: boolean, remove: (project: ProjectRecord) => void] {
  const [deleting, setDeleting] = useState(false);
  const remove = useCallback(
    (target: ProjectRecord) => {
      if (deleting) return;
      Alert.alert(
        'Delete project?',
        `This removes ${projectDisplayName(target)} from Verity, stops its container, and deletes the local clone, including retained recovery workspaces, along with the project's sessions and their history. This can't be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              setDeleting(true);
              onError(undefined);
              void client
                .deleteProject(target.id)
                // `dismissTo`, not `replace`: the settings routes were pushed on
                // top of the project and the home the operator came from, so
                // replacing them with `/` would leave two home screens stacked —
                // and the second renders a back button to the first, the
                // nonsensical "‹ Verity" on the overview. Popping returns to the
                // home already below (which refetches on focus, so the deleted
                // project is gone from it either way); with no home below — a
                // cold deep link — it falls back to replacing this route.
                .then(() => router.dismissTo('/'))
                .catch((caught) => {
                  onError(
                    caught instanceof VerityApiError ? caught.message : 'Could not delete project',
                  );
                })
                .finally(() => setDeleting(false));
            },
          },
        ],
      );
    },
    [client, deleting, onError],
  );
  return [deleting, remove];
}
