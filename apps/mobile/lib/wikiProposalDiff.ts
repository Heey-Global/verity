/**
 * What a proposed Wiki page changes, as passages a person can read: each run of
 * paragraphs that differs, with the text it replaces. A whole page is never
 * shown when only a section of it changes.
 */
export interface ProposalPassage {
  /** The paragraphs replaced or removed; absent for new text. */
  before?: string;
  /** The paragraphs added or replacing; absent for text that is removed. */
  after?: string;
}

/** Beyond this many paragraph pairs a page is compared as a whole. */
const MAX_CELLS = 1_000_000;

const paragraphs = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

export function proposalPassages(current: string | null, proposed: string): ProposalPassage[] {
  const after = paragraphs(proposed);
  if (current === null) return after.length ? [{ after: after.join('\n\n') }] : [];
  const before = paragraphs(current);
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_CELLS) return [whole(before, after)];
  // Longest common subsequence of paragraphs, filled from the end.
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
  const passages: ProposalPassage[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length || added.length) passages.push(whole(removed, added));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || common[i * width + j + 1]! >= common[(i + 1) * width + j]!)) {
      added.push(after[j++]!);
    } else {
      removed.push(before[i++]!);
    }
  }
  flush();
  return passages;
}

function whole(removed: readonly string[], added: readonly string[]): ProposalPassage {
  return {
    ...(removed.length ? { before: removed.join('\n\n') } : {}),
    ...(added.length ? { after: added.join('\n\n') } : {}),
  };
}
