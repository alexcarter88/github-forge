// REST v3: repositories, git refs, contents, labels, issues, pull requests.
// One in-memory store shared with the git, GraphQL and MCP surfaces; the shapes below are
// what the conformance checks read, so every response keeps the fields they assert on.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER_ID,
  VIEWER_LOGIN,
  b64decode,
  buildCommit,
  isOid,
  lineDiff,
  parseCommit,
  parseTree,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestHelpers {
  sendJson: (status: number, payload: unknown) => void;
  sendEmpty: (status: number) => void;
}

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  helpers: RestHelpers;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headTip ?? pull.headShaAtCreate },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Resolve a repo by owner/name; any owner other than the viewer is a 404, never a 403. */
function findRepo(ctx: Ctx, owner: string, name: string): Repo | undefined {
  return ctx.store.getRepo(owner, name);
}

function notFound(ctx: Ctx): void {
  ctx.helpers.sendJson(404, { message: 'Not Found' });
}

function unprocessable(ctx: Ctx, message: string): void {
  ctx.helpers.sendJson(422, { message });
}

/** Paginate an array; page numbers start at 1, per_page defaults to 30. */
function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; pageNum: number; perPage: number; hasNext: boolean } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, pageNum, perPage, hasNext: start + perPage < items.length };
}

/** The Link header for the next page, built from the request's own Host. */
function nextLink(ctx: Ctx, basePath: string, perPage: number, pageNum: number): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const url = new URL(`http://${host}${basePath}`);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(pageNum + 1));
  return `<${url.toString()}>; rel="next"`;
}

// -------------------------------------------------------------------------------------------
// Commits and contents helpers
// -------------------------------------------------------------------------------------------

/** Commits reachable from `tip`, newest first (depth-first pre-order: parents after children). */
function reachableCommits(store: Store, repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
  }
  return out;
}

/** Resolve a ref parameter: a branch name, or a commit oid. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return undefined;
}

/** The flat file map of a commit's tree (empty map when the commit is undefined). */
function filesOf(store: Store, repo: Repo, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (commitOid === undefined) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return store.flattenTree(repo, parseCommit(object.data).tree);
}

interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees by path, with a line-level count for text files. */
function diffTrees(store: Store, repo: Repo, oldTree: string | undefined, newTree: string | undefined): FileDiff[] {
  const oldFiles = oldTree === undefined ? new Map() : store.flattenTree(repo, oldTree);
  const newFiles = newTree === undefined ? new Map() : store.flattenTree(repo, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry === undefined ? '' : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '');
    const newText = newEntry === undefined ? '' : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    diffs.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return diffs;
}

/** Create a commit on `branch` from a new file map; returns the commit oid. */
function writeCommit(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = store.buildTrees(repo, files);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = store.putObject(repo, 'commit', buildCommit({
    tree: treeOid,
    parents,
    message,
    timestamp: store.commitTimestamp(),
  }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.gen += 1;
  return commitOid;
}

// -------------------------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------------------------

function listUserRepos(ctx: Ctx): void {
  const repos = ctx.store.listRepos();
  const { page, pageNum, perPage, hasNext } = paginate(repos, ctx.query);
  if (hasNext) {
    ctx.res.setHeader('Link', nextLink(ctx, '/api/v3/user/repos', perPage, pageNum));
  }
  ctx.helpers.sendJson(200, page.map(repoJson));
}

function createUserRepo(ctx: Ctx): void {
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'name is required');
    return;
  }
  const name = asString(ctx.body.name);
  if (name === undefined || name === '') {
    unprocessable(ctx, 'name is required');
    return;
  }
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    unprocessable(ctx, 'name already exists on this account');
    return;
  }
  const repo = ctx.store.createRepo(name, asBoolean(ctx.body.private) ?? false, asString(ctx.body.description) ?? '');
  ctx.helpers.sendJson(201, repoJson(repo));
}

function getRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, repoJson(repo));
}

function patchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (isRecord(ctx.body)) {
    const description = asString(ctx.body.description);
    if (description !== undefined) repo.description = description;
    const isPrivate = asBoolean(ctx.body.private);
    if (isPrivate !== undefined) repo.private = isPrivate;
  }
  ctx.helpers.sendJson(200, repoJson(repo));
}

function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  ctx.store.deleteRepo(repo);
  ctx.helpers.sendEmpty(204);
}

function listBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ctx.helpers.sendJson(200, branches);
}

function getBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, { name: branch, commit: { sha: tip } });
}

function listCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const tip = resolveRef(ctx.store, repo, ctx.query.get('sha'));
  if (tip === undefined) {
    ctx.helpers.sendJson(200, []);
    return;
  }
  const commits = reachableCommits(ctx.store, repo, tip);
  ctx.helpers.sendJson(200, commits.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
}

function createRef(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'ref and sha are required');
    return;
  }
  const ref = asString(ctx.body.ref);
  const sha = asString(ctx.body.sha);
  if (ref === undefined || sha === undefined) {
    unprocessable(ctx, 'ref and sha are required');
    return;
  }
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    unprocessable(ctx, 'ref must start with refs/heads/ or refs/tags/');
    return;
  }
  if (!isOid(sha) || repo.objects.get(sha) === undefined) {
    unprocessable(ctx, 'sha does not exist');
    return;
  }
  if (repo.refs.has(ref)) {
    unprocessable(ctx, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  repo.gen += 1;
  ctx.helpers.sendJson(201, { ref, object: { sha } });
}

function getRef(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
}

function putContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'message and content are required');
    return;
  }
  const message = asString(ctx.body.message) ?? '';
  const content = asString(ctx.body.content);
  if (content === undefined) {
    unprocessable(ctx, 'content is required');
    return;
  }
  const branch = asString(ctx.body.branch) ?? repo.defaultBranch;
  const givenSha = asString(ctx.body.sha);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = filesOf(ctx.store, repo, tip);
  const current = files.get(path);
  if (givenSha !== undefined) {
    if (current === undefined || current.oid !== givenSha) {
      ctx.helpers.sendJson(409, { message: 'sha does not match the current file' });
      return;
    }
  } else if (current !== undefined) {
    unprocessable(ctx, 'file already exists; provide its sha to update it');
    return;
  }
  const blobOid = ctx.store.putObject(repo, 'blob', b64decode(content));
  files.set(path, { oid: blobOid, mode: '100644' });
  const commitOid = writeCommit(ctx.store, repo, branch, files, message);
  ctx.helpers.sendJson(current === undefined ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: b64decode(content).length, encoding: 'base64' },
    commit: { sha: commitOid },
  });
}

function getContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const tip = resolveRef(ctx.store, repo, ctx.query.get('ref'));
  if (tip === undefined) {
    notFound(ctx);
    return;
  }
  const files = filesOf(ctx.store, repo, tip);
  if (path === '') {
    // Root listing: direct children only.
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      const slash = filePath.indexOf('/');
      if (slash < 0) {
        children.set(filePath, { type: 'file', name: filePath, path: filePath, sha: entry.oid });
      } else {
        const dir = filePath.slice(0, slash);
        if (!children.has(dir)) {
          const dirOid = dirTreeOid(ctx.store, repo, tip, dir);
          children.set(dir, { type: 'dir', name: dir, path: dir, sha: dirOid ?? '' });
        }
      }
    }
    ctx.helpers.sendJson(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    return;
  }
  const file = files.get(path);
  if (file !== undefined) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    ctx.helpers.sendJson(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: data.toString('base64'),
      sha: file.oid,
    });
    return;
  }
  // A directory: its direct children.
  const prefix = `${path}/`;
  const children: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
  const seenDirs = new Set<string>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.push({ type: 'file', name: rest, path: filePath, sha: entry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        const dirOid = dirTreeOid(ctx.store, repo, tip, `${path}/${dir}`);
        children.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirOid ?? '' });
      }
    }
  }
  if (children.length === 0) {
    notFound(ctx);
    return;
  }
  children.sort((a, b) => (a.name < b.name ? -1 : 1));
  ctx.helpers.sendJson(200, children);
}

/** The tree oid of a directory path within a commit, or undefined. */
function dirTreeOid(store: Store, repo: Repo, commitOid: string, dirPath: string): string | undefined {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  let treeOid = parseCommit(object.data).tree;
  for (const segment of dirPath.split('/')) {
    const treeObject = repo.objects.get(treeOid);
    if (treeObject === undefined || treeObject.type !== 'tree') return undefined;
    const entries = parseTree(treeObject.data);
    const match = entries.find((e) => e.name === segment && e.mode === '40000');
    if (match === undefined) return undefined;
    treeOid = match.oid;
  }
  return treeOid;
}

function deleteContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'message and sha are required');
    return;
  }
  const message = asString(ctx.body.message) ?? '';
  const givenSha = asString(ctx.body.sha);
  const branch = repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = filesOf(ctx.store, repo, tip);
  const current = files.get(path);
  if (current === undefined) {
    notFound(ctx);
    return;
  }
  if (givenSha !== undefined && current.oid !== givenSha) {
    ctx.helpers.sendJson(409, { message: 'sha does not match the current file' });
    return;
  }
  files.delete(path);
  const commitOid = writeCommit(ctx.store, repo, branch, files, message);
  ctx.helpers.sendJson(200, { commit: { sha: commitOid } });
}

function createLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'name is required');
    return;
  }
  const labelName = asString(ctx.body.name);
  if (labelName === undefined || labelName === '') {
    unprocessable(ctx, 'name is required');
    return;
  }
  const color = asString(ctx.body.color) ?? '';
  if (!repo.labels.has(labelName)) repo.labels.set(labelName, color);
  ctx.helpers.sendJson(201, { name: labelName, color: repo.labels.get(labelName) ?? color });
}

function createIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'title is required');
    return;
  }
  const title = asString(ctx.body.title);
  if (title === undefined || title === '') {
    unprocessable(ctx, 'title is required');
    return;
  }
  const labels = Array.isArray(ctx.body.labels) ? ctx.body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      unprocessable(ctx, `label ${label} does not exist`);
      return;
    }
  }
  const issue: Issue = {
    id: ctx.store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body: asString(ctx.body.body) ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: ctx.store.nextIssueSeq++,
  };
  repo.issues.push(issue);
  ctx.helpers.sendJson(201, issueJson(issue));
}

function listIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page } = paginate(issues, ctx.query);
  ctx.helpers.sendJson(200, page.map(issueJson));
}

function getIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, issueJson(issue));
}

function patchIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  if (isRecord(ctx.body)) {
    const state = asString(ctx.body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = asString(ctx.body.title);
    if (title !== undefined) issue.title = title;
    const body = asString(ctx.body.body);
    if (body !== undefined) issue.body = body;
  }
  ctx.helpers.sendJson(200, issueJson(issue));
}

function createComment(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'body is required');
    return;
  }
  const body = asString(ctx.body.body);
  if (body === undefined) {
    unprocessable(ctx, 'body is required');
    return;
  }
  const comment = { id: ctx.store.nextCommentId++, body };
  issue.comments.push(comment);
  ctx.helpers.sendJson(201, { id: comment.id, body: comment.body });
}

function listComments(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
}

function createPull(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  if (!isRecord(ctx.body)) {
    unprocessable(ctx, 'head, base and title are required');
    return;
  }
  const head = asString(ctx.body.head);
  const base = asString(ctx.body.base);
  const title = asString(ctx.body.title);
  if (head === undefined || base === undefined || title === undefined) {
    unprocessable(ctx, 'head, base and title are required');
    return;
  }
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) {
    unprocessable(ctx, 'head or base branch does not exist');
    return;
  }
  const duplicate = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
  if (duplicate !== undefined) {
    unprocessable(ctx, 'a pull request for this head and base already exists');
    return;
  }
  const pull: Pull = {
    id: ctx.store.nextPullId++,
    number: repo.nextPullNumber++,
    title,
    body: asString(ctx.body.body) ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    baseSha: baseTip,
    headShaAtCreate: headTip,
    seq: repo.pulls.length + 1,
  };
  repo.pulls.push(pull);
  ctx.helpers.sendJson(201, pullJson(ctx.store, repo, pull));
}

function listPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  const pulls = repo.pulls
    .filter((p) => state === 'all' || p.state === state)
    .sort((a, b) => b.number - a.number);
  ctx.helpers.sendJson(200, pulls.map((p) => pullJson(ctx.store, repo, p)));
}

function getPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  ctx.helpers.sendJson(200, pullJson(ctx.store, repo, pull));
}

function listPullFiles(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  const baseObject = repo.objects.get(pull.baseSha);
  const baseTree = baseObject !== undefined && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : undefined;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const headObject = repo.objects.get(headTip);
  const headTree = headObject !== undefined && headObject.type === 'commit' ? parseCommit(headObject.data).tree : undefined;
  ctx.helpers.sendJson(200, diffTrees(ctx.store, repo, baseTree, headTree));
}

/**
 * The squash merge itself, shared with the GraphQL mutation: conflict detection, the merge
 * commit on the base branch (tree == head tip's tree, parent == current base tip), and the
 * pull request's state transition. Returns merged:false with a message when it cannot merge.
 */
export function mergePullRequestCore(store: Store, repo: Repo, pull: Pull): { merged: boolean; sha?: string; message: string } {
  if (pull.state !== 'open') return { merged: false, message: 'pull request is not open' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { merged: false, message: 'base branch does not exist' };
  const baseObject = repo.objects.get(pull.baseSha);
  const headObject = repo.objects.get(headTip);
  const currentBaseObject = repo.objects.get(baseTip);
  if (baseObject === undefined || headObject === undefined || currentBaseObject === undefined) {
    return { merged: false, message: 'missing commit' };
  }
  const baseTree = parseCommit(baseObject.data).tree;
  const headTree = parseCommit(headObject.data).tree;
  const currentBaseTree = parseCommit(currentBaseObject.data).tree;
  const headFiles = store.flattenTree(repo, headTree);
  const baseFiles = store.flattenTree(repo, baseTree);
  const currentBaseFiles = store.flattenTree(repo, currentBaseTree);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys(), ...currentBaseFiles.keys()]);
  for (const path of paths) {
    const fromBase = baseFiles.get(path);
    const fromHead = headFiles.get(path);
    const fromCurrent = currentBaseFiles.get(path);
    const headChanged = (fromHead?.oid ?? null) !== (fromBase?.oid ?? null);
    const baseChanged = (fromCurrent?.oid ?? null) !== (fromBase?.oid ?? null);
    if (headChanged && baseChanged && (fromHead?.oid ?? null) !== (fromCurrent?.oid ?? null)) {
      return { merged: false, message: 'merge conflict' };
    }
  }
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeCommitOid = store.putObject(repo, 'commit', buildCommit({
    tree: headTree,
    parents: [baseTip],
    message,
    timestamp: store.commitTimestamp(),
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommitOid);
  repo.gen += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.stamp();
  pull.mergeCommitSha = mergeCommitOid;
  return { merged: true, sha: mergeCommitOid, message };
}

function mergePull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  const result = mergePullRequestCore(ctx.store, repo, pull);
  if (!result.merged) {
    ctx.helpers.sendJson(405, { message: result.message });
    return;
  }
  ctx.helpers.sendJson(200, { merged: true, sha: result.sha, message: result.message });
}

// -------------------------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------------------------

export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  helpers: RestHelpers,
): void {
  const ctx: Ctx = { store, req, res, segments, query, body, helpers };
  const method = req.method ?? 'GET';
  const [first, second, third, fourth, fifth, ...rest] = segments;

  if (segments.length === 0 && method === 'GET') {
    helpers.sendJson(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return;
  }
  if (first === 'meta' && segments.length === 1 && method === 'GET') {
    helpers.sendJson(200, { installed_version: '1.0.0' });
    return;
  }
  if (first === 'user' && segments.length === 1 && method === 'GET') {
    helpers.sendJson(200, { login: VIEWER_LOGIN, id: VIEWER_ID });
    return;
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      listUserRepos(ctx);
      return;
    }
    if (method === 'POST') {
      createUserRepo(ctx);
      return;
    }
  }
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const repoName = third;
    if (fourth === undefined) {
      if (method === 'GET') {
        getRepo(ctx, owner, repoName);
        return;
      }
      if (method === 'PATCH') {
        patchRepo(ctx, owner, repoName);
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(ctx, owner, repoName);
        return;
      }
    }
    if (fourth === 'branches' && fifth === undefined && method === 'GET') {
      listBranches(ctx, owner, repoName);
      return;
    }
    if (fourth === 'branches' && fifth !== undefined && rest.length === 0 && method === 'GET') {
      getBranch(ctx, owner, repoName, fifth);
      return;
    }
    if (fourth === 'commits' && fifth === undefined && method === 'GET') {
      listCommits(ctx, owner, repoName);
      return;
    }
    if (fourth === 'git' && fifth === 'refs' && rest.length === 0 && method === 'POST') {
      createRef(ctx, owner, repoName);
      return;
    }
    if (fourth === 'git' && fifth === 'refs' && rest[0] === 'heads' && rest.length === 2 && method === 'GET') {
      getRef(ctx, owner, repoName, rest[1]!);
      return;
    }
    if (fourth === 'contents') {
      const path = [fifth, ...rest].filter((s) => s !== undefined).join('/');
      if (method === 'PUT') {
        putContents(ctx, owner, repoName, path);
        return;
      }
      if (method === 'GET') {
        getContents(ctx, owner, repoName, path);
        return;
      }
      if (method === 'DELETE') {
        deleteContents(ctx, owner, repoName, path);
        return;
      }
    }
    if (fourth === 'labels' && fifth === undefined && method === 'POST') {
      createLabel(ctx, owner, repoName);
      return;
    }
    if (fourth === 'issues' && fifth === undefined) {
      if (method === 'POST') {
        createIssue(ctx, owner, repoName);
        return;
      }
      if (method === 'GET') {
        listIssues(ctx, owner, repoName);
        return;
      }
    }
    if (fourth === 'issues' && fifth !== undefined) {
      const number = Number.parseInt(fifth, 10);
      if (Number.isInteger(number)) {
        if (rest.length === 0 && method === 'GET') {
          getIssue(ctx, owner, repoName, number);
          return;
        }
        if (rest.length === 0 && method === 'PATCH') {
          patchIssue(ctx, owner, repoName, number);
          return;
        }
        if (rest[0] === 'comments' && rest.length === 1) {
          if (method === 'POST') {
            createComment(ctx, owner, repoName, number);
            return;
          }
          if (method === 'GET') {
            listComments(ctx, owner, repoName, number);
            return;
          }
        }
      }
    }
    if (fourth === 'pulls' && fifth === undefined) {
      if (method === 'POST') {
        createPull(ctx, owner, repoName);
        return;
      }
      if (method === 'GET') {
        listPulls(ctx, owner, repoName);
        return;
      }
    }
    if (fourth === 'pulls' && fifth !== undefined) {
      const number = Number.parseInt(fifth, 10);
      if (Number.isInteger(number)) {
        if (rest.length === 0 && method === 'GET') {
          getPull(ctx, owner, repoName, number);
          return;
        }
        if (rest[0] === 'files' && rest.length === 1 && method === 'GET') {
          listPullFiles(ctx, owner, repoName, number);
          return;
        }
        if (rest[0] === 'merge' && rest.length === 1 && method === 'PUT') {
          mergePull(ctx, owner, repoName, number);
          return;
        }
      }
    }
  }
  helpers.sendJson(404, { message: 'Not Found' });
}
