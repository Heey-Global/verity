/**
 * The one project id the control plane runs under.
 *
 * Two names refer to it — {@link CONTROL_PLANE_RUNNER_PROJECT_ID} in `embedded.ts` for the
 * runner directory ACP turns are routed to, {@link VERITY_CONTROL_PROJECT_ID} in `server.ts`
 * for the project a control-plane session belongs to — because they answer different
 * questions. They are nevertheless the same id, and things break quietly when they are not:
 * the gateway advertises a control-plane tool by the first and authorises the caller by the
 * second, so a divergence would offer a tool that can only ever be refused after burning an
 * approval card. Both are defined from this constant so the divergence cannot happen.
 */
export const CONTROL_PLANE_PROJECT_ID = 'verity-control';
