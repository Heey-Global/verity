// Shared Repair driver for `POST /projects/:id/repair`. Both the overview row and
// the project detail screen offer Repair, and both have to handle the same two
// server responses: a sealed server secret (503) needs the device unlocked before
// provisioning can read project secrets, and an unconfirmed warning (409) needs the
// operator to acknowledge it. Keeping that in one place is what stops the two entry
// points from drifting into two different repair behaviours.
import {
  VerityApiError,
  isServerSecretSealedError,
  type VerityClient,
  type ProjectRecord,
} from '@verity/mobile';
import { router } from 'expo-router';
import { Alert } from 'react-native';

export interface RepairProjectOptions {
  client: VerityClient;
  projectId: string;
  /** Route to come back to after the operator unlocks a sealed server secret. */
  returnTo: string;
  onUpdated?: (project: ProjectRecord) => void;
  onError?: (message: string) => void;
}

/** Resolves true when the operator confirms the warning, false on cancel/dismiss. */
function confirmWarning(warnings: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Review project warning',
      warnings.join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      // Android's back/outside dismiss fires no button handler; without this the
      // promise would never settle and the caller's busy guard would stick.
      { onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Kick off a repair, resolving once the request settled (the server answers 202 as
 * soon as the project is queued — provisioning itself continues in the background
 * and surfaces through the project's state). Redirects on a sealed secret, and on
 * an unconfirmed warning stays PENDING across the confirmation alert and the
 * confirmed retry: callers key their busy state off this promise, so resolving at
 * the alert would re-enable the Repair button while a confirmation is still open
 * and let repeated taps queue concurrent provisioning runs.
 */
export async function repairProject(
  options: RepairProjectOptions,
  confirmWarnings = false,
): Promise<void> {
  const { client, projectId, returnTo, onUpdated, onError } = options;
  try {
    const project = await client.repairProject(projectId, { confirmWarnings });
    onUpdated?.(project);
  } catch (caught) {
    if (isServerSecretSealedError(caught)) {
      router.replace({
        pathname: '/unlock-device',
        params: { returnTo, serverSecret: '1' },
      });
      return;
    }
    if (
      caught instanceof VerityApiError &&
      caught.requiresConfirmation &&
      caught.warnings.length > 0 &&
      !confirmWarnings
    ) {
      if (await confirmWarning(caught.warnings)) await repairProject(options, true);
      return;
    }
    onError?.(caught instanceof VerityApiError ? caught.message : 'Could not start project');
  }
}
