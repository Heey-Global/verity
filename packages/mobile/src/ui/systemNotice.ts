/**
 * Split a server-written notice ("Preparing project environment. Checking …")
 * into the headline a system notice shows and the explanation under it. The
 * first sentence is the headline, without its full stop; text with no sentence
 * end stays one headline.
 */
export function splitNoticeText(text: string): { title: string; detail?: string } {
  const trimmed = text.trim();
  // A sentence ends at one terminator followed by a capitalised sentence or the
  // end of the text, so an ellipsis ("Cloning repository...") or an abbreviation
  // ("e.g. the Sandbox") stays inside the headline.
  const match = /^(.*?[^.!?\s])[.!?](?:\s+(\p{Lu}[\s\S]*))?$/u.exec(trimmed);
  if (match === null) return { title: trimmed };
  const title = match[1]!.trim();
  const detail = match[2]?.trim();
  return detail ? { title, detail } : { title };
}
