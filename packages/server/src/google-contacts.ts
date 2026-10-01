import { z } from 'zod';
import type { GoogleFetch } from './google-drive.js';

export const googleContactsRequestSchema = z
  .object({
    action: z.literal('search_contacts'),
    query: z.string().trim().min(1).max(1024),
    maxResults: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export type GoogleContactsRequest = z.infer<typeof googleContactsRequestSchema>;

/** People search requires an empty-query cache warmup; request only names and email addresses. */
export async function invokeGoogleContactsApi(
  token: string,
  request: GoogleContactsRequest,
  doFetch: GoogleFetch = fetch,
  beforeSearch?: () => Promise<void>,
): Promise<unknown> {
  const search = async (query: string) => {
    const params = new URLSearchParams({
      query,
      pageSize: String(request.maxResults),
      readMask: 'names,emailAddresses',
    });
    const response = await doFetch(
      `https://people.googleapis.com/v1/people:searchContacts?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok)
      throw new Error(`Google Contacts request failed (HTTP ${String(response.status)})`);
    return (await response.json()) as {
      results?: {
        person?: {
          resourceName?: string;
          names?: { displayName?: string }[];
          emailAddresses?: { value?: string; type?: string }[];
        };
      }[];
    };
  };
  await search('');
  await beforeSearch?.();
  const result = await search(request.query);
  return {
    contacts: (result.results ?? []).slice(0, request.maxResults).map(({ person }) => ({
      resourceName: person?.resourceName ?? null,
      names: (person?.names ?? [])
        .map(({ displayName }) => displayName)
        .filter((value) => typeof value === 'string'),
      emailAddresses: (person?.emailAddresses ?? [])
        .map(({ value }) => value)
        .filter((value) => typeof value === 'string'),
    })),
  };
}
