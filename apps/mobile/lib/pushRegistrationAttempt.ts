export function createPushRegistrationAttempt(
  register: () => Promise<'registered' | string>,
): () => Promise<void> {
  let registered = false;
  let inFlight: Promise<void> | undefined;
  return async () => {
    if (registered) return;
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        if ((await register()) === 'registered') registered = true;
      } catch {
        // Best effort — a push failure must never disrupt the app.
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}
