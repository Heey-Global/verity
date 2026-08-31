/**
 * The "repository artifacts are English" directive. Verity sessions are often
 * driven in the operator's own language, and backends left to their own
 * defaults mirror that language into whatever they write — German commit
 * messages, pull request descriptions, and code comments. This repo states the
 * rule in `AGENTS.md`, but that only reaches sessions whose repository carries
 * such a file, and a checked-in doc competes with the per-turn runtime prompt.
 * Stating it here makes it repo-agnostic: the artifacts stay English while the
 * chat reply keeps following the operator. A repository's own instructions
 * still win, so projects that deliberately write in another language can say so.
 */
export const LANGUAGE_SYSTEM_PROMPT = `# Language of repository artifacts (Verity)

Write everything that lands in the repository or on GitHub in English, whatever language this conversation uses: commit messages, branch names, pull request titles and descriptions, issue text, code comments, identifiers, and documentation. This is about the artifacts only — reply to the operator in the language they are using. If the repository's own instructions (\`AGENTS.md\`, \`CLAUDE.md\`, or equivalent) name a different language, follow the repository.`;
