import { z } from 'zod';

/**
 * The curated help catalog about using the Verity app itself: what a feature
 * does, what it needs, where it is configured. It feeds the agent's
 * `verity_app_help` tool, and is meant to feed the onboarding welcome session
 * and the app's own hint sheets later, so an answer in the chat and a hint in
 * the app cannot drift apart.
 *
 * `appLink` is an in-app `verity://` link the mobile transcript opens directly
 * (resolved by `parseAppLink` in `@verity/mobile`); a guard there fails when a
 * link here stops resolving. `docsPath` is a repository-relative Markdown file
 * rendered on GitHub, because the documentation is not published elsewhere; a
 * guard in `@verity/mobile` fails when the file moves.
 */

/** Verity gateway tool that answers questions about the app from this catalog. */
export const APP_HELP_TOOL = 'verity_app_help';

/** Where repository documentation is readable by users. The repository is
 *  public and has no versioned docs site, so links follow `main`; a guide can
 *  occasionally describe behaviour newer than the server a user runs. */
export const DOCS_BASE_URL = 'https://github.com/Heey-Global/verity/blob/main/';

export interface AppHelpTopic {
  /** Stable kebab-case id the agent passes back as `topic`. */
  id: string;
  title: string;
  /** One sentence for the topic index. */
  summary: string;
  /** Two to four sentences: what it does, what it needs, how to start. */
  details: string;
  /** In-app link to the screen where this is configured or used. */
  appLink?: string;
  /** Repository-relative path of the user documentation, if any. */
  docsPath?: string;
  /** Extra words a user might ask with that the title does not contain. */
  keywords: readonly string[];
  /** Short contextual copy shared by the app and chat help. */
  hint?: { text: string; question: string };
  emptyState?: string;
}

export const APP_HELP_TOPICS: readonly AppHelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'What Verity is and the first steps after setup.',
    details:
      'Verity runs coding agents for you on your own server; you direct them from the app by chatting. After setup you need one AI provider; everything else is optional. Create a project, open a session in it and describe a task. GitHub, Doppler and Google can be connected later when a task needs them.',
    appLink: 'verity://project/new',
    docsPath: 'docs/getting-started.md',
    keywords: ['start', 'begin', 'first', 'setup', 'onboarding', 'overview', 'what can i do'],
  },
  {
    id: 'projects-and-sessions',
    title: 'Projects and sessions',
    summary: 'How projects, sandboxes and sessions relate.',
    details:
      'A project is either an empty local project or a GitHub repository, and gets its own sandbox container on the server. A session is one conversation with one agent and works on its own branch with its own copy of the files, so several sessions can run in parallel without interfering. Start a new session from the project or with the plus button on the home screen.',
    appLink: 'verity://project/new',
    docsPath: 'docs/getting-started.md',
    // Bare "project" and "session" appear in almost every settings question, so
    // only phrases that are about projects and sessions themselves count here.
    keywords: [
      'new project',
      'create project',
      'add project',
      'new session',
      'start session',
      'what is a project',
      'what is a session',
      'sandbox',
      'container',
      'branch',
      'parallel',
    ],
  },
  {
    id: 'session-settings',
    title: 'Session settings',
    summary: 'Rename, link or manage the current session.',
    details:
      'Open Session settings from the session menu to rename the conversation, manage linked sessions or delete it. Moving between projects is available for idle sessions in local projects.',
    appLink: 'verity://session/settings',
    docsPath: 'docs/getting-started.md',
    keywords: [
      'session settings',
      'rename session',
      'delete session',
      'move session',
      'linked sessions',
    ],
  },
  {
    id: 'connections',
    title: 'Connections overview',
    summary: 'Where external services are connected and how projects use them.',
    details:
      'Account credentials are connected once in Settings, Connections, and stored encrypted on the server. Each project then chooses which connections it may use in its project settings, for example a GitHub repository, a Doppler config or a Google Drive folder. Nothing is shared with a project until you select it there.',
    appLink: 'verity://settings/services',
    docsPath: 'docs/connections.md',
    keywords: ['connect', 'integration', 'service', 'account', 'scope'],
  },
  {
    id: 'project-connections',
    title: 'Project connections',
    summary: 'Choose which connected services a project may use.',
    details:
      'Project settings, Connections lists the services this project uses and offers Add connection for the rest. There you pick the GitHub repository, the Doppler project and config, a Google Drive folder, Google mail, calendar and contacts access, Matrix rooms and MCP servers. Grants apply to every session in the project.',
    appLink: 'verity://project/settings/services',
    docsPath: 'docs/connections.md',
    keywords: ['project settings', 'scope', 'enable', 'grant'],
  },
  {
    id: 'github',
    title: 'GitHub',
    summary: 'Work on your repositories, open pull requests, sign commits.',
    details:
      'Connect GitHub to let agents work on existing repositories and open pull requests; you choose which repositories Verity may access. The same screen sets the commit author and the signing key for verified commits. Afterwards New project offers GitHub repository, and sessions show pull request and CI status.',
    appLink: 'verity://settings/github',
    docsPath: 'docs/getting-started.md',
    keywords: ['repository', 'repo', 'pull request', 'pr', 'commit', 'signing', 'git'],
  },
  {
    id: 'claude',
    title: 'Claude',
    summary: 'Use your Claude subscription as an agent backend.',
    details:
      'Sign in with your Claude account so sessions can run Claude models. At least one AI provider is required; you can connect several and choose the model per session or as a project default.',
    appLink: 'verity://settings/services/claude',
    docsPath: 'docs/getting-started.md',
    keywords: ['ai', 'provider', 'anthropic', 'model', 'login', 'subscription'],
  },
  {
    id: 'codex',
    title: 'Codex',
    summary: 'Use your Codex subscription as an agent backend.',
    details:
      'Sign in with your Codex account so sessions can run Codex models. It can be used alongside other providers; the model is chosen per session or as a project default.',
    appLink: 'verity://settings/services/codex',
    docsPath: 'docs/getting-started.md',
    keywords: ['ai', 'provider', 'openai', 'model', 'login', 'subscription'],
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    summary: 'Use custom providers and models through OpenCode.',
    details:
      'OpenCode lets sessions use additional model providers you configure yourself. Set up the providers and models on its settings screen, then choose them like any other model.',
    appLink: 'verity://settings/services/opencode',
    docsPath: 'docs/getting-started.md',
    keywords: ['ai', 'provider', 'custom model', 'model'],
  },
  {
    id: 'google',
    title: 'Google',
    summary: 'Drive, Docs, Sheets, Slides, mail and calendar for agents.',
    details:
      'Connect your Google account to let agents work with Google Workspace. Each service asks only for its own permissions: mail, calendar, contacts and Drive are connected separately. A project then enables the services it needs, and sending mail or changing events always asks you first.',
    appLink: 'verity://settings/google',
    docsPath: 'docs/google-calendar.md',
    keywords: [
      'gmail',
      'mail',
      'email',
      'calendar',
      'contacts',
      'workspace',
      'google docs',
      'google sheets',
      'google slides',
    ],
  },
  {
    id: 'google-drive',
    title: 'Google Drive folders',
    summary: 'Give a project a Drive folder as a workspace.',
    details:
      'In project settings, Connections, Google Drive, select a folder. New folder connections are read-only; enable changes explicitly if agents should write. Agents only see that folder and its contents, and deletions go to the Drive trash.',
    appLink: 'verity://project/settings/services',
    docsPath: 'docs/file-connections.md',
    keywords: ['drive', 'folder', 'files', 'upload', 'read-only'],
  },
  {
    id: 'doppler',
    title: 'Doppler',
    summary: 'Managed secrets that agents can use without seeing them.',
    details:
      'Connect Doppler to give projects access to secrets such as API keys. A project selects its Doppler project and config. Agents then use a secret by name for an HTTP request or a CLI command after your approval; the value is never shown to them.',
    appLink: 'verity://settings/services/doppler',
    docsPath: 'docs/connections.md',
    // Not "password": that word mostly means the master password, see secrets-storage.
    keywords: ['secret', 'api key', 'token', 'credentials', 'env'],
  },
  {
    id: 'matrix',
    title: 'Matrix',
    summary: 'Import chat room messages into project knowledge.',
    details:
      "A dedicated Matrix account joins rooms you invite it to, for example rooms bridged from WhatsApp or Signal. After you assign a room to a project, new messages and attachments are imported into that project's knowledge. Agents can read them, but chat content is never treated as instructions.",
    appLink: 'verity://settings/services/matrix',
    docsPath: 'docs/matrix-knowledge-connector.md',
    keywords: ['chat', 'whatsapp', 'signal', 'messages', 'room', 'import'],
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    summary: 'Connect additional agent tools via MCP.',
    details:
      'Add Model Context Protocol servers to give agents extra tools. Configure the server once in Settings, then enable it for the projects that need it in project settings, Connections.',
    appLink: 'verity://settings/services/mcp',
    docsPath: 'docs/connections.md',
    keywords: ['tool', 'model context protocol', 'plugin', 'extension'],
  },
  {
    id: 'attendee',
    title: 'Attendee (online meetings)',
    summary: 'Record and transcribe online meetings with a meeting bot.',
    details:
      'Attendee sends a bot into online meetings and delivers the transcript to Verity. Configure its API key and webhook secret in Settings. Online meetings also require Uplink online sharing so the bot can reach your server.',
    appLink: 'verity://settings/services/attendee',
    docsPath: 'docs/attendee-live-meetings.md',
    keywords: ['meeting', 'zoom', 'teams', 'meet', 'bot', 'transcript', 'online'],
  },
  {
    id: 'live-meeting',
    hint: {
      text: 'A live meeting captures audio for transcription and adds the resulting notes to this session. Check the selected transcription service and get participants’ consent before you start recording.',
      question: 'How does live meeting recording and transcription work?',
    },
    title: 'Live meetings',
    summary: 'Transcribe meetings and analyse them with an agent.',
    details:
      'A live meeting transcribes in-person meetings on the iPhone or iPad, or online meetings through Attendee. Notes, speakers and the transcript are kept with the session, and audio and transcript are saved to the project knowledge. Transcription options are in Settings.',
    appLink: 'verity://settings/transcription',
    docsPath: 'docs/attendee-live-meetings.md',
    keywords: ['meeting', 'recording', 'transcription', 'transcript', 'speech', 'notes', 'speaker'],
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    summary: 'Durable project files agents read in every session.',
    details:
      "Each project has a Knowledge folder on the server that survives sandbox replacements. Sources holds documents and meeting transcripts, insights holds what agents distil from them, and overview.md is the short context every fresh session receives. Open it from a session's file browser; Shared knowledge is readable by every project.",
    appLink: 'verity://project/knowledge',
    docsPath: 'docs/knowledge.md',
    keywords: ['files', 'documents', 'memory', 'notes', 'sources', 'insights', 'shared'],
  },
  {
    id: 'preview-and-sharing',
    emptyState:
      'Ask the agent to start your app as a Verity server. It will appear here, where you can switch it on and off. Local gives access on your trusted network without a PIN; Shared online creates a public link protected by a PIN and an expiry.',
    hint: {
      text: 'Shared online creates a public preview link through Uplink. Anyone with the link and PIN can access it until it expires or you stop sharing; Local access is a separate switch.',
      question: 'How does Shared online preview sharing work?',
    },
    title: 'Preview and sharing',
    summary: 'Open a web app an agent is running, locally or online.',
    details:
      "When an agent starts a development server, it appears in the session's Preview sheet. Local opens it from your own network without a login. Shared online publishes it through Uplink at a public address protected by a PIN, so treat it as visible to anyone you give the address and PIN to.",
    appLink: 'verity://session/preview',
    docsPath: 'docs/getting-started.md',
    keywords: ['preview', 'share', 'dev server', 'web app', 'localhost', 'public', 'link', 'url'],
  },
  {
    id: 'files',
    title: 'Session files',
    summary: 'Browse and edit the files a session works on.',
    details:
      'The file browser of a session shows its working copy of the project, plus the project Knowledge and Shared knowledge. You can read, edit, upload and download files there, and file links in agent replies open in it.',
    appLink: 'verity://session/files',
    keywords: ['files', 'browse', 'edit', 'download', 'upload', 'worktree'],
  },
  {
    id: 'review-and-pull-requests',
    hint: {
      text: 'This bar shows the result of your session’s work and its checks. Opening a pull request lets you inspect it; merging or saving to the project applies the changes to the base branch.',
      question: 'How do I review and merge my session’s changes?',
    },
    title: 'Review and pull requests',
    summary: 'How agent changes reach your repository.',
    details:
      'Each session works on its own branch. In GitHub projects the agent commits, runs a code review and opens a review-ready pull request when you ask; the session then shows the pull request with its CI status and a merge action. In local projects changes stay in the project and can be merged locally.',
    appLink: 'verity://settings/github',
    docsPath: 'docs/getting-started.md',
    keywords: ['review', 'pull request', 'pr', 'merge', 'ci', 'branch', 'commit'],
  },
  {
    id: 'tasks-and-voice',
    title: 'Tasks and voice capture',
    summary: 'A durable task list fed by voice notes and agents.',
    details:
      'Tap the floating microphone to speak a thought; it is saved as a task for the current project. Agents also record agreed follow-up steps as tasks. From the list you can check items off or hand a task to an agent.',
    appLink: 'verity://settings/tasks',
    keywords: ['task', 'todo', 'voice', 'microphone', 'dictate', 'capture', 'reminder'],
  },
  {
    id: 'devices',
    title: 'Devices',
    summary: 'Pair more phones, tablets and browsers.',
    details:
      'Each device gets its own access that you can revoke separately. Pair another iPhone or iPad with a QR code from Devices, or invite a browser with a code. Remove a device there if it is lost.',
    appLink: 'verity://devices',
    docsPath: 'docs/getting-started.md',
    keywords: ['phone', 'ipad', 'browser', 'pair', 'qr', 'login', 'revoke'],
  },
  {
    id: 'remote-access',
    title: 'Remote access',
    summary: 'Reach your server from outside your home network.',
    details:
      'Remote access connects the app to your server through Uplink when you are not on the same network. Set it up in Settings, Remote access. Online sharing of previews and online meetings build on it.',
    appLink: 'verity://settings/remote-access',
    keywords: ['uplink', 'outside', 'internet', 'remote', 'vpn', 'away'],
  },
  {
    id: 'secrets-storage',
    emptyState:
      'After a server restart, enter your master password once to unlock the encrypted logins, keys and tokens stored on your server.',
    title: 'How secrets are stored',
    summary: 'Encryption, the master password and unlocking after a restart.',
    details:
      'Logins, keys and tokens are stored encrypted in the server database with a key derived from your master password; the password itself is not stored. After every server restart Verity asks for it once before agents can use those secrets again, which is expected. Verity cannot reset a lost master password: the only way forward is a reinstall, which removes projects, sessions and stored secrets.',
    appLink: 'verity://settings/secret-store',
    docsPath: 'docs/getting-started.md',
    keywords: [
      // Phrases only: bare "stored", "restart" or "lose" occur in questions about
      // transcripts, dev servers or files, and pulled this entry in beside them.
      'secret store',
      'master password',
      'encryption',
      'encrypted',
      'unlock',
      'restart the server',
      'server restart',
      'secret stored',
      'key stored',
      'password stored',
      'forgot password',
      'forgot my password',
      'lost password',
      'lost my password',
      'lose password',
      'lose my password',
      'reset password',
    ],
  },
];

export const appHelpRequestSchema = z
  .object({
    /** A topic id from the index. Takes precedence over `query`. */
    topic: z.string().trim().min(1).max(100).optional(),
    /** Free-text question words to search titles, summaries and keywords. */
    query: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type AppHelpRequest = z.infer<typeof appHelpRequestSchema>;

/** A catalog entry as returned to the agent: links resolved to final form. */
export interface AppHelpEntry {
  id: string;
  title: string;
  summary: string;
  details: string;
  appLink?: string;
  docsUrl?: string;
}

export type AppHelpAnswer =
  | { topics: { id: string; title: string; summary: string }[]; note: string }
  | { entries: AppHelpEntry[] };

const SEARCH_RESULT_MAX = 3;

function entryOf(topic: AppHelpTopic): AppHelpEntry {
  return {
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
    details: topic.details,
    ...(topic.appLink === undefined ? {} : { appLink: topic.appLink }),
    ...(topic.docsPath === undefined ? {} : { docsUrl: `${DOCS_BASE_URL}${topic.docsPath}` }),
  };
}

function index(note: string): AppHelpAnswer {
  return {
    topics: APP_HELP_TOPICS.map(({ id, title, summary }) => ({ id, title, summary })),
    note,
  };
}

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function foldPlural(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

/** Lower-cased tokens with a plain English plural folded away, so "api keys"
 *  matches the keyword "api key" and "passwords" matches "password". */
function tokens(text: string): string[] {
  return rawTokens(text).map(foldPlural);
}

/** Words too common in questions and catalog text to say anything about a topic. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'can',
  'how',
  'what',
  'where',
  'why',
  'who',
  'when',
  'which',
  'does',
  'use',
  'you',
  'your',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'are',
  'agent',
  'agents',
  'verity',
  'too',
  'also',
  'get',
  'let',
  'want',
  'need',
  'there',
  'them',
]);

/** Stop words are checked before plural folding, so "does" and "this" are
 *  recognised as written rather than as "doe" and "thi". */
function words(text: string): string[] {
  return rawTokens(text)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map(foldPlural);
}

/** Text normalised to space-separated tokens with a leading and trailing space,
 *  so a phrase only matches whole words: `ai` must not match inside `email`. */
function tokenized(text: string): string {
  return ` ${tokens(text).join(' ')} `;
}

function score(topic: AppHelpTopic, query: string): number {
  const question = tokenized(query);
  const has = (phrase: string) => question.includes(tokenized(phrase));
  let total = 0;
  // A whole keyword phrase or the id inside the question is the strongest signal.
  if (has(topic.id) || has(topic.title)) total += 5;
  for (const keyword of topic.keywords) if (has(keyword)) total += 3;
  const haystack = new Set(words(`${topic.title} ${topic.summary} ${topic.keywords.join(' ')}`));
  for (const word of words(query)) if (haystack.has(word)) total += 1;
  return total;
}

/**
 * Answer one `verity_app_help` call. Without arguments: the topic index. With a
 * known `topic`: that entry. With a `query`: the best matching entries. An
 * unknown topic or a query nothing matches falls back to the index with a note,
 * so the agent can pick a topic instead of guessing an answer.
 */
export function answerAppHelp(request: AppHelpRequest): AppHelpAnswer {
  if (request.topic !== undefined) {
    const wanted = request.topic.toLowerCase();
    const topic = APP_HELP_TOPICS.find((candidate) => candidate.id === wanted);
    return topic === undefined
      ? index(`Unknown topic "${request.topic}". Choose one of these ids.`)
      : { entries: [entryOf(topic)] };
  }
  if (request.query !== undefined) {
    const query = request.query;
    const ranked = APP_HELP_TOPICS.map((topic) => ({ topic, score: score(topic, query) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    // Words shared by many entries, such as "connect" or "project", still give several topics a point; keep only
    // entries close to the best match so the agent is not handed unrelated links.
    const best = ranked[0]?.score ?? 0;
    const relevant = ranked
      .filter((candidate) => candidate.score * 2 >= best)
      .slice(0, SEARCH_RESULT_MAX);
    return relevant.length === 0
      ? index(
          'No topic matched the query. Choose one of these ids, or answer that this is not covered.',
        )
      : { entries: relevant.map(({ topic }) => entryOf(topic)) };
  }
  return index('Call again with a topic id for details and links.');
}

export const APP_HELP_TOOL_DESCRIPTION = `Look up how to use the Verity app itself: features, settings, connections (GitHub, AI providers, Google, Doppler, Matrix, MCP, Attendee), preview and sharing, knowledge, tasks, devices, and how secrets are stored. Without arguments it lists topics; pass topic with an id for details, or query with the user's question words to search. Entries include appLink, an in-app verity:// link, and docsUrl. Read-only.`;

/** Fresh-context section: when to consult the catalog and how to pass its links on. */
export const APP_HELP_SYSTEM_PROMPT = `# App help (Verity)

When the user asks how Verity itself works, where a setting is, or how to connect a service, call \`${APP_HELP_TOOL}\` instead of answering from memory. Pass on its \`appLink\` as a Markdown link, for example [Open GitHub settings](verity://settings/github); the app opens it directly. Use only \`verity://\` links the tool returned and never invent one. Add \`docsUrl\` only when the user wants more detail. If the catalog does not cover the question, say so.`;

/** Connections the welcome message reports on; everything else stays reachable by asking. */
export interface WelcomeSetupStatus {
  aiProvider: boolean;
  github: boolean;
  doppler: boolean;
  google: boolean;
}

/** Name of the per-session marker that identifies the onboarding welcome session. */
export const WELCOME_SESSION_MARKER = 'welcome-session';

function topicLink(id: string): string {
  const link = APP_HELP_TOPICS.find((topic) => topic.id === id)?.appLink;
  if (link === undefined) throw new Error(`app help topic ${id} has no in-app link`);
  return link;
}

const WELCOME_CHECKLIST: readonly {
  key: keyof WelcomeSetupStatus;
  topic: string;
  done: string;
  todo: string;
}[] = [
  {
    key: 'aiProvider',
    topic: 'connections',
    done: 'AI provider connected',
    todo: 'Connect an AI provider',
  },
  {
    key: 'github',
    topic: 'github',
    done: 'GitHub connected',
    todo: 'Connect GitHub to work on your repositories',
  },
  {
    key: 'doppler',
    topic: 'doppler',
    done: 'Doppler connected',
    todo: 'Connect Doppler for API keys and other secrets',
  },
  {
    key: 'google',
    topic: 'google',
    done: 'Google connected',
    todo: 'Connect Google for Drive, mail and calendar',
  },
];

/**
 * The server-written first message of the welcome session. It is shown before
 * any agent runs, so it costs no tokens and does not depend on a model's
 * wording. Open items link straight to their settings screen.
 */
export function renderWelcomeOpener(status: WelcomeSetupStatus): string {
  const checklist = WELCOME_CHECKLIST.map((item) =>
    status[item.key] ? `- ✓ ${item.done}` : `- [${item.todo}](${topicLink(item.topic)})`,
  ).join('\n');
  return `**Welcome to Verity.** This is your starter project, a safe place to try things out. Ask me anything about Verity here, or give me a first task.

**Your setup**
${checklist}

Matrix, MCP servers and online meetings are under [Connections](${topicLink('connections')}).`;
}

/** The Quick Actions under the welcome message. Each label is sent as the user's reply. */
export function welcomeChoices(status: WelcomeSetupStatus): {
  question: string;
  options: { label: string; recommended?: true }[];
} {
  return {
    question: 'Where would you like to start?',
    options: [
      { label: 'What can I do here?', recommended: true },
      ...(status.github ? [] : [{ label: 'Connect GitHub' }]),
      { label: 'Try a first task' },
      { label: 'Later' },
    ],
  };
}

/**
 * The system prompt section of the welcome session, appended on fresh contexts
 * only. It adds the guide role and the link table; tool contracts stay in the
 * regular turn prompt.
 */
export function renderWelcomeGuidePrompt(): string {
  const table = APP_HELP_TOPICS.filter((topic) => topic.appLink !== undefined)
    .map((topic) => `- ${topic.title}: ${topic.appLink}`)
    .join('\n');
  return `# Verity Guide (welcome session)

This session is the user's introduction to Verity, in a local starter project Verity created for them. Before your first turn, Verity showed them a short welcome message with a setup checklist and the Quick Actions "What can I do here?", "Try a first task" and "Later", plus "Connect GitHub" when GitHub was not connected yet. Do not repeat that message.

- Answer questions about using Verity briefly: two to five sentences or a few bullets, then stop.
- Link instead of describing paths. Use the in-app links below as Markdown links; for anything not listed, call \`${APP_HELP_TOOL}\`.
- End an answer with at most one \`verity:choices\` block offering the most useful next topics, and only when a choice helps.
- Up front, suggest only GitHub, Doppler and Google besides the AI provider. Mention other connections only when asked.
- "Try a first task": suggest one small, concrete task, for example a web page that shows the current time, and do it here when the user agrees. This project is disposable.
- "Later": acknowledge in one sentence and say this session stays available.

In-app links:
${table}`;
}
