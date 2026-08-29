/**
 * The shared half of starting a session, used by both screens that can start one:
 * `/new` (phone, and the tablet redirect) and the sidebar "+" of the split home.
 *
 * Both mint the id up front and open the chat before the server answers (see
 * `pendingSessions`), so both need the same thing from the create call: a promise
 * that settles only once the session really exists — including across the project
 * warnings the operator has to confirm, which used to be a callback in the middle
 * of each screen's own copy of this flow.
 */
import { VerityApiError, type VerityClient, type SpawnRequest } from '@verity/mobile';
import { Alert } from 'react-native';

/**
 * Create the session, pausing for the operator when the server answers with
 * project warnings that need confirming (409, then the same request with
 * `confirmProvisionWarnings`).
 *
 * Resolves once the session exists. Rejects when it never will — the operator
 * cancelled at the warnings, the project is still provisioning (202: there is no
 * session to hand back), or the request failed. The caller's chat is waiting on
 * this promise, so a rejection is what turns its "Opening session…" into the
 * actual reason.
 *
 * `existing` is true when the server answered from a session that was already
 * there — the idempotent reply to a repeated client-minted id, which is what a
 * restore re-issues. It tells the caller the session's prepared first turn was
 * sent by the run that created it, so it must not be sent again.
 */
export async function createSessionConfirmingWarnings(
  client: VerityClient,
  body: SpawnRequest,
): Promise<{ existing: boolean }> {
  const attempt = async (confirmProvisionWarnings: boolean): Promise<{ existing: boolean }> => {
    try {
      const result = await client.createSession({
        ...body,
        ...(confirmProvisionWarnings ? { confirmProvisionWarnings: true } : {}),
      });
      if ('awaitingProvisioning' in result) {
        throw new Error(
          `Provisioning ${result.project.owner}/${result.project.repo}. Try again shortly.`,
        );
      }
      return { existing: result.existing === true };
    } catch (caught) {
      if (
        !confirmProvisionWarnings &&
        caught instanceof VerityApiError &&
        caught.requiresConfirmation &&
        caught.warnings.length > 0
      ) {
        await confirmProjectWarnings(caught.warnings);
        return await attempt(true);
      }
      throw caught;
    }
  };
  return await attempt(false);
}

/** Resolves if the operator accepts the project's provisioning warnings, rejects
 * if they cancel — so the caller's chain simply fails and the chat reports it. */
function confirmProjectWarnings(warnings: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    Alert.alert('Review project warning', warnings.join('\n\n'), [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => reject(new Error('Cancelled at the project warning')),
      },
      { text: 'Continue', onPress: () => resolve() },
    ]);
  });
}
