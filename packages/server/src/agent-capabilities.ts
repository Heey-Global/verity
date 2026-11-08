import { actionTitle } from '@verity/events';
import type { GatewayToolName } from '@verity/secret-contracts';

type Schema = Record<string, unknown>;
export interface AgentCapability {
  name: string;
  title: string;
  legacyName: GatewayToolName;
  discriminator?: 'action' | 'operation';
  value?: string;
  inputSchema: Schema;
}
const domains: Record<string, string> = {
  verity_google_calendar: 'calendar',
  verity_google_contacts: 'contacts',
  verity_google_drive: 'drive',
  verity_google_docs: 'docs',
  verity_google_sheets: 'sheets',
  verity_google_slides: 'slides',
};
const renamed: Record<string, string> = {
  verity_list_sessions: 'verity_session_list',
  verity_send_session_message: 'verity_session_send_message',
  verity_list_linked_sessions: 'verity_session_list_links',
  verity_session_progress: 'verity_session_read_progress',
  verity_recent_session_messages: 'verity_session_read_recent_messages',
  verity_publish_session_progress: 'verity_session_publish_progress',
  verity_start_planning: 'verity_planning_start',
  verity_present_plan: 'verity_planning_present',
  verity_present_mockups: 'verity_mockups_present',
  verity_complete_mockups: 'verity_mockups_complete',
  verity_secret_output: 'verity_secret_read_output',
  verity_diagnostics: 'verity_diagnostics_read',
  verity_app_help: 'verity_app_help_lookup',
};

/** Derive focused schemas from the validation contract, never a second field inventory. */
export function capabilityVariants(legacyName: GatewayToolName, schema: Schema): AgentCapability[] {
  const branches = (schema.oneOf ?? schema.anyOf ?? [schema]) as Schema[];
  const result: AgentCapability[] = [];
  for (const branch of branches) {
    const properties = (branch.properties ?? {}) as Record<string, Schema>;
    const discriminator = (['action', 'operation'] as const).find((key) => {
      const shape = properties[key];
      return shape && (typeof shape.const === 'string' || Array.isArray(shape.enum));
    });
    const shape = discriminator ? properties[discriminator]! : undefined;
    const values = shape ? ((shape.enum ?? [shape.const]) as string[]) : [undefined];
    for (const value of values) {
      const domain = domains[legacyName] ?? legacyName.slice('verity_'.length);
      const verb =
        legacyName === 'verity_end_planning'
          ? (value ?? 'implement')
          : value === 'create_source_folder'
            ? 'create_raw_source_folder'
            : value === 'move_source'
              ? 'move_raw_source'
              : value;
      const name =
        legacyName === 'verity_end_planning'
          ? `verity_planning_${verb}`
          : // A Wiki proposal belongs to the Wiki, though the knowledge broker carries it.
            value === 'propose_wiki'
            ? 'verity_wiki_propose'
            : value
              ? `verity_${domain}_${verb}`
              : (renamed[legacyName] ?? legacyName);
      const inputSchema: Schema & { properties: Record<string, Schema> } = {
        ...branch,
        properties: { ...properties },
      };
      delete inputSchema.$schema;
      if (discriminator) {
        delete inputSchema.properties[discriminator];
        inputSchema.required = ((branch.required ?? []) as string[]).filter(
          (key) => key !== discriminator,
        );
      }
      result.push({
        name,
        title: actionTitle(name),
        legacyName,
        inputSchema,
        ...(discriminator ? { discriminator } : {}),
        ...(value ? { value } : {}),
      });
    }
  }
  if (new Set(result.map((entry) => entry.name)).size !== result.length) {
    throw new Error(`Ambiguous capability variants: ${legacyName}`);
  }
  return result;
}

/** Fixed discriminators cannot be overridden through a canonical tool's arguments. */
export function capabilityArguments(
  capability: AgentCapability,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!capability.discriminator) return input;
  if (Object.hasOwn(input, capability.discriminator))
    throw new Error('Unexpected operation discriminator');
  return { ...input, [capability.discriminator]: capability.value };
}
