/**
 * Sessions the server runs for itself (Wiki maintenance). No list shows them:
 * the app keeps one copy of the sessions its lists read, and a session one
 * list showed while another left it out would come and go between them.
 *
 * Read from the store, so a session another server generation created is
 * hidden too; `created` covers one started moments ago and not yet recorded.
 */
export function hiddenSessionIds(
  store: { readonly wikiMaintenance: { sessionIds(): Promise<Set<string>> } },
  created: Set<string>,
): () => Promise<ReadonlySet<string>> {
  return async () => {
    const recorded = await store.wikiMaintenance.sessionIds();
    for (const id of recorded) created.add(id);
    for (const id of created) recorded.add(id);
    return recorded;
  };
}
