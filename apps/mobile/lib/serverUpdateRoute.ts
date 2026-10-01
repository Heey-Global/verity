import type { Href } from 'expo-router';

/**
 * The screen a server update is started from. The overview banner, the update
 * push and the Settings row all lead here; one constant keeps a moved route
 * from leaving any of them pointing at nothing.
 */
export const SERVER_UPDATE_ROUTE = '/settings/server-update' as Href;
