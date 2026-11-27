import type { EmbeddedServer } from './embedded-types.js';

type Stop = () => void | Promise<void>;

export function createEmbeddedShutdown(ctx: {
  closeGoogleSlides: () => void;
  stopAgentGatewayCredentialProjection: Stop;
  stopRunnerSupervisorReconciler: Stop;
  closeAgentGatewaySynchronizer: Stop;
  closeApp: Stop;
  closeSessionMaintenance: Stop;
  destroyDatabase: Stop;
  setPreserveProjectRelays: (preserve: boolean) => void;
}): EmbeddedServer['close'] {
  // The first caller determines relay preservation for the shared teardown.
  let closing: Promise<void> | undefined;
  return (options = {}) =>
    (closing ??= (async () => {
      ctx.setPreserveProjectRelays(options.preserveProjectRelays === true);
      ctx.closeGoogleSlides();
      await ctx.stopAgentGatewayCredentialProjection();
      await ctx.stopRunnerSupervisorReconciler();
      await ctx.closeAgentGatewaySynchronizer();
      await ctx.closeApp();
      await ctx.closeSessionMaintenance();
      await ctx.destroyDatabase();
    })());
}
