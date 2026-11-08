// Proposed Wiki changes wait here until someone who may edit the Wiki decides.
// They are files beside the project's knowledge, never under `insights/`: a
// proposal is not knowledge until it is applied, and agents must not read it
// back as such.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { resolveKnowledgeLink, WIKI_LOG } from '@verity/events';

import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import { FileWriteError } from './session-file-write.js';

type WikiProposalMode = 'inline' | 'maintenance';
type WikiLogKind = 'setup' | 'ingest' | 'chat' | 'merge' | 'lint';
export type WikiChangeStatus = 'pending' | 'applied' | 'rejected';

export interface WikiProposalChange {
  /** Relative to `insights/`. */
  path: string;
  summary: string;
  /** The page's version the change was written against; `null` for a new page. */
  baseVersion: string | null;
  /** Dropped once the change is decided; the Wiki's history keeps what was applied. */
  content: string | null;
  /** Identifies the change after its content is gone, so it is not proposed again. */
  fingerprint: string;
  status: WikiChangeStatus;
}

export interface WikiProposal {
  id: string;
  projectId: string;
  mode: WikiProposalMode;
  logKind: WikiLogKind;
  title: string;
  sources: string[];
  sessionId: string | null;
  turnId: string | null;
  createdAt: string;
  decidedAt: string | null;
  changes: WikiProposalChange[];
}

export interface ProposeWikiInput {
  projectId: string;
  sessionId: string | null;
  turnId: string | null;
  mode: WikiProposalMode;
  logKind?: WikiLogKind | undefined;
  title: string;
  sources: string[];
  changes: { path: string; content: string; summary: string }[];
}

export interface WikiFiles {
  readProjectWiki: (
    projectId: string,
    path: string,
  ) => Promise<{ content: string; version: string } | null>;
  writeProjectWiki: (
    projectId: string,
    path: string,
    content: string,
    expectedVersion: string | null,
  ) => Promise<unknown>;
  /** Told after a proposal was recorded or decided, to refresh open review screens. */
  onChange?: (projectId: string) => void;
}

/** Open proposals per project; more must wait until earlier ones are decided. */
const MAX_OPEN_WIKI_PROPOSALS = 50;
/** Decided proposals kept per project to remember what not to propose again. */
const MAX_DECIDED_WIKI_PROPOSALS = 500;

export class WikiProposalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** The Wiki's own pages that a proposal must not replace. */
const RESERVED = new Set([posix.basename(WIKI_LOG)]);

/**
 * A Wiki page path as proposals store it: relative to `insights/`, Markdown,
 * outside the decision records. Accepts `/knowledge/insights/x.md`,
 * `insights/x.md` and `x.md`.
 */
export function proposalPagePath(path: string): string {
  const trimmed = path.trim();
  const knowledge = /^\/?knowledge\//.exec(trimmed);
  // A knowledge path outside the Wiki (Sources, Shared) is no page to propose.
  if (knowledge && !trimmed.slice(knowledge[0].length).startsWith('insights/'))
    throw new WikiProposalError(400, `not a Wiki page that can be proposed: ${path}`);
  const local = knowledge ? trimmed.slice(knowledge[0].length) : trimmed;
  const relative = local.startsWith('insights/') ? local.slice('insights/'.length) : local;
  const parts = relative.split('/');
  if (
    !relative.toLowerCase().endsWith('.md') ||
    parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
    /[\\\0]/.test(relative) ||
    parts[0] === 'decisions' ||
    RESERVED.has(relative)
  )
    throw new WikiProposalError(400, `not a Wiki page that can be proposed: ${path}`);
  return relative;
}

const UNREADABLE: unique symbol = Symbol('unreadable');

const fingerprint = (path: string, content: string) =>
  createHash('sha256').update(`${path}\0${content}`).digest('hex');

const today = () => new Date().toISOString().slice(0, 10);

/** One line of a log heading; the parser splits kind and title at the first `|`. */
const logTitle = (title: string) => title.replace(/\s+/g, ' ').trim();

/** A log link from `insights/log.md` to a knowledge path or a web source. */
function logLink(target: string, text: string): string {
  // A backslash is escaped too, or `\]` in a source would close the label early.
  const label = logTitle(text).replace(/[\\[\]]/g, '\\$&');
  if (/^https?:\/\/[^\s()<>]+$/i.test(target)) return `- [${label}](${target})`;
  const knowledge = target.replace(/^\/knowledge\//, '');
  const href = knowledge.startsWith('insights/')
    ? knowledge.slice('insights/'.length)
    : `../${knowledge}`;
  // Only a link the Wiki itself resolves is written as one.
  return resolveKnowledgeLink(WIKI_LOG, href)
    ? `- [${label}](${encodeURI(href).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`
    : `- ${label}`;
}

function wikiLogEntry(proposal: WikiProposal, applied: readonly string[]): string {
  return [
    `## [${today()}] ${proposal.logKind} | ${logTitle(proposal.title)}`,
    '',
    ...applied.map((path) => logLink(`insights/${path}`, path)),
    ...proposal.sources.map((source) => logLink(source, source)),
    '',
  ].join('\n');
}

/** Proposals of every project, as files under `<dataRoot>/wiki-proposals/<project>/`. */
export class WikiProposals {
  constructor(
    private readonly dataRoot: string,
    private readonly wiki: WikiFiles,
  ) {}

  private dir(projectId: string): string {
    return join(this.dataRoot, 'wiki-proposals', encodeURIComponent(projectId));
  }

  private async lock(projectId: string): Promise<() => void> {
    return acquireKnowledgeMutationLock(this.dir(projectId));
  }

  private async all(projectId: string): Promise<WikiProposal[]> {
    const names = await readdir(this.dir(projectId)).catch(() => [] as string[]);
    const proposals: WikiProposal[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        proposals.push(
          JSON.parse(await readFile(join(this.dir(projectId), name), 'utf8')) as WikiProposal,
        );
      } catch {
        // A file being replaced or damaged is skipped, never fatal to the list.
      }
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async save(proposal: WikiProposal): Promise<void> {
    const dir = this.dir(proposal.projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.${proposal.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(proposal), { mode: 0o600 });
    await rename(temporary, join(dir, `${proposal.id}.json`));
  }

  /** Records a proposal. Changes already proposed, applied or rejected are left out. */
  async propose(
    input: ProposeWikiInput,
  ): Promise<{ proposal: WikiProposal | null; skipped: string[] }> {
    const changes = input.changes.map((change) => ({
      ...change,
      path: proposalPagePath(change.path),
    }));
    if (new Set(changes.map((change) => change.path)).size !== changes.length)
      throw new WikiProposalError(400, 'propose each page once');
    const release = await this.lock(input.projectId);
    try {
      const existing = await this.all(input.projectId);
      const open = existing.filter((proposal) => proposal.decidedAt === null);
      if (open.length >= MAX_OPEN_WIKI_PROPOSALS)
        throw new WikiProposalError(429, 'too many open Wiki proposals; wait for the review');
      if (
        input.mode === 'inline' &&
        input.turnId !== null &&
        existing.some((proposal) => proposal.mode === 'inline' && proposal.turnId === input.turnId)
      )
        throw new WikiProposalError(409, 'one Wiki proposal per answer');
      // A pending change whose page moved on can no longer be applied; offering
      // the same text against the page as it is now must stay possible.
      const offered = new Set(changes.map((change) => fingerprint(change.path, change.content)));
      const known = new Set<string>();
      for (const proposal of existing)
        for (const decided of proposal.changes) {
          if (!offered.has(decided.fingerprint)) continue;
          if (decided.status !== 'pending') known.add(decided.fingerprint);
          else {
            const page = await this.page(input.projectId, decided.path);
            if (page !== UNREADABLE && (page?.version ?? null) === decided.baseVersion)
              known.add(decided.fingerprint);
          }
        }
      const skipped: string[] = [];
      const kept: WikiProposalChange[] = [];
      for (const change of changes) {
        const current = await this.page(input.projectId, change.path);
        const print = fingerprint(change.path, change.content);
        // A page that cannot be read has no version to propose against.
        if (current === UNREADABLE || known.has(print) || current?.content === change.content) {
          skipped.push(change.path);
          continue;
        }
        kept.push({
          path: change.path,
          summary: change.summary,
          baseVersion: current?.version ?? null,
          content: change.content,
          fingerprint: print,
          status: 'pending',
        });
      }
      if (!kept.length) return { proposal: null, skipped };
      const proposal: WikiProposal = {
        id: randomUUID(),
        projectId: input.projectId,
        mode: input.mode,
        logKind: input.logKind ?? (input.mode === 'inline' ? 'chat' : 'ingest'),
        title: logTitle(input.title),
        sources: input.sources,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        changes: kept,
      };
      await this.save(proposal);
      this.wiki.onChange?.(input.projectId);
      return { proposal, skipped };
    } finally {
      release();
    }
  }

  /**
   * A page as it is now. A path that became unreadable (a file where a folder
   * was, a symlink) affects only the changes on it, never the whole review.
   */
  private async page(
    projectId: string,
    path: string,
  ): Promise<{ content: string; version: string } | null | typeof UNREADABLE> {
    return this.wiki.readProjectWiki(projectId, path).catch(() => UNREADABLE);
  }

  /** Open proposals, oldest first, each change marked stale when its page moved on. */
  async listOpen(projectId: string) {
    const open = (await this.all(projectId)).filter((proposal) => proposal.decidedAt === null);
    // The list stays small: page texts are read with the single proposal.
    return Promise.all(
      open.map(async (proposal) => {
        const view = await this.view(proposal);
        return {
          ...view,
          changes: view.changes.map(({ path, summary, status, stale }) => ({
            path,
            summary,
            status,
            stale,
          })),
        };
      }),
    );
  }

  async get(projectId: string, id: string) {
    return this.view(await this.one(projectId, id));
  }

  /** One proposal, read from its own file. */
  private async one(projectId: string, id: string): Promise<WikiProposal> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new WikiProposalError(404, 'Wiki proposal not found');
    try {
      return JSON.parse(
        await readFile(join(this.dir(projectId), `${id}.json`), 'utf8'),
      ) as WikiProposal;
    } catch {
      throw new WikiProposalError(404, 'Wiki proposal not found');
    }
  }

  /** A proposal with each pending change's current page, to compare and to tell stale. */
  private async view(proposal: WikiProposal) {
    const changes = await Promise.all(
      proposal.changes.map(async (change) => {
        if (change.status !== 'pending') return { ...change, stale: false, current: null };
        const current = await this.page(proposal.projectId, change.path);
        if (current === UNREADABLE) return { ...change, stale: true, current: null };
        return {
          ...change,
          stale: (current?.version ?? null) !== change.baseVersion,
          current: current?.content ?? null,
        };
      }),
    );
    // Which session proposed it is not shown: project readers need not see its ids.
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      mode: proposal.mode,
      logKind: proposal.logKind,
      title: proposal.title,
      sources: proposal.sources,
      createdAt: proposal.createdAt,
      decidedAt: proposal.decidedAt,
      changes,
    };
  }

  /**
   * Applies the pending changes named (all when none are), each against its base
   * version. A page that changed since is left pending and reported as stale.
   */
  async apply(projectId: string, id: string, paths?: readonly string[]) {
    return this.decide(projectId, id, paths, async (proposal, change) => {
      try {
        await this.wiki.writeProjectWiki(
          projectId,
          change.path,
          change.content ?? '',
          change.baseVersion,
        );
        return 'applied';
      } catch (error) {
        if (error instanceof FileWriteError && error.status === 409) return 'stale';
        throw error;
      }
    });
  }

  async reject(projectId: string, id: string, paths?: readonly string[]) {
    return this.decide(projectId, id, paths, async (proposal, change) => {
      // Rejecting a change only because its page moved on says nothing about its
      // text; it must not keep the same text from being proposed again.
      const page = await this.page(proposal.projectId, change.path);
      if (page === UNREADABLE || (page?.version ?? null) !== change.baseVersion)
        change.fingerprint = '';
      return 'rejected';
    });
  }

  private async decide(
    projectId: string,
    id: string,
    paths: readonly string[] | undefined,
    act: (
      proposal: WikiProposal,
      change: WikiProposalChange,
    ) => Promise<WikiChangeStatus | 'stale'>,
  ) {
    const release = await this.lock(projectId);
    try {
      const proposal = await this.one(projectId, id);
      const selected = paths?.map(proposalPagePath);
      const targets = proposal.changes.filter(
        (change) => change.status === 'pending' && (!selected || selected.includes(change.path)),
      );
      if (!targets.length) throw new WikiProposalError(409, 'nothing left to decide');
      const applied: string[] = [];
      const stale: string[] = [];
      const failed: string[] = [];
      for (const change of targets) {
        let outcome: WikiChangeStatus | 'stale';
        try {
          outcome = await act(proposal, change);
        } catch {
          // The page stays pending; the others are still decided.
          failed.push(change.path);
          continue;
        }
        if (outcome === 'stale') {
          stale.push(change.path);
          continue;
        }
        change.status = outcome;
        change.content = null;
        if (outcome === 'applied') applied.push(change.path);
      }
      if (proposal.changes.every((change) => change.status !== 'pending')) {
        proposal.decidedAt = new Date().toISOString();
        for (const change of proposal.changes) change.baseVersion = null;
      }
      await this.save(proposal);
      // The pages are applied either way; a missing log entry must not read as a failed apply.
      const logged = applied.length
        ? await this.appendLog(proposal, applied).then(
            () => true,
            () => false,
          )
        : true;
      if (proposal.decidedAt) await this.prune(projectId);
      this.wiki.onChange?.(projectId);
      return {
        applied,
        stale,
        failed,
        ...(logged ? {} : { warning: 'The pages were applied, but log.md could not be updated.' }),
        proposal: await this.view(proposal),
      };
    } finally {
      release();
    }
  }

  /** Appends the change to `log.md`, retrying once when the log moved meanwhile. */
  private async appendLog(proposal: WikiProposal, applied: readonly string[]): Promise<void> {
    const log = posix.basename(WIKI_LOG);
    const entry = wikiLogEntry(proposal, applied);
    for (let attempt = 0; ; attempt++) {
      const current = await this.wiki.readProjectWiki(proposal.projectId, log);
      const base = current?.content ?? '# Change log\n';
      const content = `${base.replace(/\n*$/, '\n\n')}${entry}`;
      try {
        await this.wiki.writeProjectWiki(
          proposal.projectId,
          log,
          content,
          current?.version ?? null,
        );
        return;
      } catch (error) {
        if (attempt === 0 && error instanceof FileWriteError && error.status === 409) continue;
        throw error;
      }
    }
  }

  /** Keeps the newest decided proposals; older ones no longer block a repeat. */
  private async prune(projectId: string): Promise<void> {
    const decided = (await this.all(projectId)).filter((proposal) => proposal.decidedAt !== null);
    for (const old of decided.slice(0, Math.max(0, decided.length - MAX_DECIDED_WIKI_PROPOSALS)))
      await unlink(join(this.dir(projectId), `${old.id}.json`)).catch(() => undefined);
  }
}
