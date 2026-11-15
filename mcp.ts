// MCP: JSON-RPC over POST /mcp. One fixed tool table (byte-identical tools/list), result
// envelopes with both content text and structuredContent, and the discover handshake the
// client opens with. Everything reads and writes the same store as REST and GraphQL.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { mergePullRequestCore } from './rest.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a repository owned by the viewer.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Issue state: open, closed, or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
    body: { type: 'string', description: 'Pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash merge.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    pull_number: { type: 'integer', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get an issue by owner, repository and number.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    issue_number: { type: 'integer', description: 'Issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_pull_requests', 'List pull requests in a repository.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Pull request state: open, closed, or all.' },
  }, ['owner', 'repo']),
];

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

type JsonRpcId = string | number | null;

interface RpcResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}

function okResult(payload: unknown): RpcResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function errorResult(message: string): RpcResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = args['owner'];
  const repoName = args['repo'];
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  return store.getRepo(owner, repoName) ?? null;
}

function missingArg(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of def.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcResult {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) throw new Error(`unknown tool ${name}`);
  const missing = missingArg(def, args);
  if (missing !== null) return errorResult(`missing required argument: ${missing}`);

  if (name === 'create_repo') {
    const repoName = args['name'] as string;
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
      return errorResult('name already exists on this account');
    }
    const repo = store.createRepo(
      repoName,
      typeof args['private'] === 'boolean' ? args['private'] : false,
      typeof args['description'] === 'string' ? args['description'] : '',
    );
    return okResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    return okResult(repoJson(repo));
  }

  if (name === 'create_issue') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const issue: Issue = {
      id: store.nextIssueId++,
      number: repo.nextIssueNumber++,
      title: args['title'] as string,
      body: typeof args['body'] === 'string' ? args['body'] : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: store.nextIssueSeq++,
    };
    repo.issues.push(issue);
    return okResult(issueJson(issue));
  }

  if (name === 'list_issues') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const state = typeof args['state'] === 'string' ? args['state'] : 'open';
    const issues = repo.issues
      .filter((i) => state === 'all' || i.state === state)
      .sort((a, b) => b.seq - a.seq)
      .map(issueJson);
    return okResult({ issues });
  }

  if (name === 'create_pull_request') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const head = args['head'] as string;
    const base = args['base'] as string;
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) return errorResult('head or base branch does not exist');
    const duplicate = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
    if (duplicate !== undefined) return errorResult('a pull request for this head and base already exists');
    const pull: Pull = {
      id: store.nextPullId++,
      number: repo.nextPullNumber++,
      title: args['title'] as string,
      body: typeof args['body'] === 'string' ? args['body'] : '',
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
    return okResult(pullJson(store, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const number = Number(args['pull_number']);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return errorResult('pull request not found');
    const result = mergePullRequestCore(store, repo, pull);
    if (!result.merged) return errorResult(result.message);
    return okResult({ merged: true, sha: result.sha, message: result.message });
  }

  if (name === 'get_issue') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const number = Number(args['issue_number']);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) return errorResult('issue not found');
    return okResult(issueJson(issue));
  }

  if (name === 'list_pull_requests') {
    const repo = findRepo(store, args);
    if (repo === null) return errorResult('repository not found');
    const state = typeof args['state'] === 'string' ? args['state'] : 'open';
    const pulls = repo.pulls
      .filter((p) => state === 'all' || p.state === state)
      .sort((a, b) => b.number - a.number)
      .map((p) => pullJson(store, repo, p));
    return okResult({ pull_requests: pulls });
  }

  return errorResult(`tool ${name} is not implemented`);
}

/** Extract a JSON-RPC id from raw text, for the -32700 parse-error reply. */
export function extractRpcId(raw: string): JsonRpcId {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (match === null) return null;
  const text = match[1]!;
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return null;
    }
  }
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

export interface McpOutcome {
  status: number;
  /** JSON body, or null for an empty (202/204) response. */
  payload: Record<string, unknown> | null;
}

/**
 * Handle one POST /mcp body. `body` is the parsed JSON value (or null when the body was not
 * JSON); `raw` is the raw request text, used only to recover the id for a parse error.
 */
export function handleMcp(store: Store, body: unknown, raw: string): McpOutcome {
  if (body === null || body === undefined) {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: extractRpcId(raw), error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const request = body as Record<string, unknown>;
  const id = (typeof request['id'] === 'string' || typeof request['id'] === 'number') ? request['id'] : null;
  const method = request['method'];
  // A notification (no id) is acknowledged with an empty 202.
  if (id === null && request['id'] === undefined) {
    return { status: 202, payload: null };
  }
  if (typeof method !== 'string') {
    return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [PROTOCOL_VERSION, '2026-03-26'],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        },
      },
    };
  }

  if (method === 'initialize') {
    const params = (typeof request['params'] === 'object' && request['params'] !== null) ? request['params'] as Record<string, unknown> : {};
    const protocolVersion = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION;
    return {
      status: 200,
      payload: {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo },
      },
    };
  }

  if (method === 'tools/list') {
    return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }

  if (method === 'tools/call') {
    const params = (typeof request['params'] === 'object' && request['params'] !== null) ? request['params'] as Record<string, unknown> : {};
    const toolName = params['name'];
    const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null && !Array.isArray(params['arguments']))
      ? params['arguments'] as Record<string, unknown>
      : {};
    if (typeof toolName !== 'string') {
      return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'tool name is required' } } };
    }
    if (TOOLS.find((t) => t.name === toolName) === undefined) {
      return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${toolName}` } } };
    }
    try {
      const result = callTool(store, toolName, args);
      return { status: 200, payload: { jsonrpc: '2.0', id, result } };
    } catch (err) {
      return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: err instanceof Error ? err.message : String(err) } } };
    }
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }

  return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } } };
}
