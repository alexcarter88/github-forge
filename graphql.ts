// GraphQL: a small recursive-descent parser plus resolvers that read straight from the same
// store the REST and MCP surfaces use, so a mutation on one face is visible on the others.
// Global ids are opaque base64url strings; cursors are base64 of the last item's number.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  b64decode,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { mergePullRequestCore } from './rest.ts';

// -------------------------------------------------------------------------------------------
// Global ids and cursors
// -------------------------------------------------------------------------------------------

function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function ungid(id: string): { type: string; key: string } | null {
  try {
    const decoded = b64decode(id.replace(/-/g, '+').replace(/_/g, '/')).toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!@[]=|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and ordinary strings.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'u' && source.slice(j + 2, j + 6).length === 4
            ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16))
            : esc;
          j += esc === 'u' ? 6 : 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at offset ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text)
        ? { kind: 'float', value: Number.parseFloat(text) }
        : { kind: 'int', value: Number.parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_A-Za-z0-9]*/.exec(source.slice(i));
      const name = match![0];
      tokens.push({ kind: 'name', value: name });
      i += name.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser: documents, operations, fragments, fields, values.
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const defs: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'fragment') {
        defs.push(this.parseFragment());
      } else {
        defs.push(this.parseOperation());
      }
    }
    return defs;
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.expectName();
    }
    const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selectionSet };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    this.expectPunct('(');
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  /** A type reference; only its shape matters here, the string is discarded. */
  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> {
    const directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> = [];
    while (this.isPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.isPunct('(') ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// -------------------------------------------------------------------------------------------
// Schema: the fields each type answers, for validation and introspection.
// -------------------------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileNode: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT'],
};

function typeKind(name: string): string {
  if (ENUM_VALUES[name] !== undefined) return 'ENUM';
  if (name === 'Query' || name === 'Mutation') return 'OBJECT';
  return 'OBJECT';
}

// -------------------------------------------------------------------------------------------
// Runtime values
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; items: Issue[]; repo: Repo; hasNext: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; items: Pull[]; repo: Repo; hasNext: boolean; endCursor: string | null }
  | { __type: 'FileConnection'; paths: string[] }
  | { __type: 'FileNode'; path: string }
  | { __type: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { __type: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __type: 'PullRequestEdge'; repo: Repo; pull: Pull; cursor: string }
  | { __type: 'FileEdge'; path: string; cursor: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: 'Query' }
  | { __type: 'Mutation' };

function typeNameOf(value: GqlValue): string {
  switch (value.__type) {
    case 'Query': return 'Query';
    case 'Mutation': return 'Mutation';
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueComment': return 'IssueComment';
    case 'Ref': return 'Ref';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'FileConnection': return 'FileConnection';
    case 'FileNode': return 'FileNode';
    case 'PageInfo': return 'PageInfo';
    case 'IssueEdge': return 'IssueEdge';
    case 'PullRequestEdge': return 'PullRequestEdge';
    case 'FileEdge': return 'FileEdge';
    case 'CreateIssuePayload': return 'CreateIssuePayload';
    case 'CloseIssuePayload': return 'CloseIssuePayload';
    case 'CreatePullRequestPayload': return 'CreatePullRequestPayload';
    case 'MergePullRequestPayload': return 'MergePullRequestPayload';
    case 'AddCommentPayload': return 'AddCommentPayload';
    case '__Type': return '__Type';
    case '__Field': return '__Field';
    case '__EnumValue': return '__EnumValue';
  }
}

class GraphQLError extends Error {}

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

/** @skip/@include, evaluated from the field's directives. */
function isIncluded(field: FieldNode | FragmentSpreadNode | InlineFragmentNode, ctx: ExecCtx): boolean {
  for (const directive of field.directives) {
    const ifArg = directive.args.find((a) => a.name === 'if');
    const value = ifArg === undefined ? true : resolveValue(ifArg.value, ctx.variables);
    if (directive.name === 'skip' && value === true) return false;
    if (directive.name === 'include' && value !== true) return false;
  }
  return true;
}

function collectSelections(
  selections: readonly SelectionNode[],
  ctx: ExecCtx,
  out: FieldNode[],
  visited: Set<string> = new Set(),
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (isIncluded(selection, ctx)) out.push(selection);
    } else if (selection.kind === 'spread') {
      if (!isIncluded(selection, ctx)) continue;
      if (visited.has(selection.name)) continue;
      visited.add(selection.name);
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) collectSelections(fragment.selectionSet, ctx, out, visited);
    } else if (selection.kind === 'inline') {
      if (!isIncluded(selection, ctx)) continue;
      collectSelections(selection.selectionSet, ctx, out, visited);
    }
  }
}

/** Validate every field against the schema; unknown fields error with the field's name. */
function validateSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  ctx: ExecCtx,
  errors: string[],
  visited: Set<string> = new Set(),
): void {
  const fields = parentType === 'Node'
    ? [...new Set([...(SCHEMA['Repository'] ?? []), ...(SCHEMA['Issue'] ?? []), ...(SCHEMA['PullRequest'] ?? []), ...(SCHEMA['IssueComment'] ?? [])])]
    : SCHEMA[parentType] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (!isIncluded(selection, ctx)) continue;
      if (selection.name === '__typename') continue;
      if (selection.name === '__type' || selection.name === '__schema') continue;
      if (!fields.includes(selection.name)) {
        errors.push(`Cannot query field "${selection.name}" on type "${parentType}".`);
        continue;
      }
      if (selection.selectionSet !== null) {
        const childType = childTypeOf(parentType, selection.name);
        if (childType !== null) validateSelections(selection.selectionSet, childType, ctx, errors, new Set(visited));
      }
    } else if (selection.kind === 'spread') {
      if (!isIncluded(selection, ctx)) continue;
      if (visited.has(selection.name)) continue;
      visited.add(selection.name);
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment.selectionSet, fragment.typeCondition, ctx, errors, visited);
    } else if (selection.kind === 'inline') {
      if (!isIncluded(selection, ctx)) continue;
      const type = selection.typeCondition ?? parentType;
      validateSelections(selection.selectionSet, type, ctx, errors, new Set(visited));
    }
  }
}

/** The object type a field's sub-selection belongs to. */
function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node' },
    Node: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequest: { files: 'FileConnection' },
    FileConnection: { nodes: 'FileNode', edges: 'FileEdge', pageInfo: 'PageInfo' },
    FileEdge: { node: 'FileNode' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[field] ?? null;
}

function executeSelections(
  selections: readonly SelectionNode[],
  parent: GqlValue,
  ctx: ExecCtx,
): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectSelections(selections, ctx, fields);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    try {
      out[key] = resolveField(field, parent, ctx);
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      throw new GraphQLError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/** Resolve one field on a value; scalar fields return scalars, object fields recurse. */
function resolveField(field: FieldNode, parent: GqlValue, ctx: ExecCtx): unknown {
  const name = field.name;
  if (name === '__typename') return typeNameOf(parent);
  if (name === '__type') {
    const args = argsMap(field, ctx);
    const typeName = args['name'];
    if (typeof typeName !== 'string') return null;
    if (SCHEMA[typeName] === undefined && ENUM_VALUES[typeName] === undefined) return null;
    const value: GqlValue = { __type: '__Type', name: typeName };
    return field.selectionSet === null ? value : executeSelections(field.selectionSet, value, ctx);
  }
  if (name === '__schema') {
    return null;
  }
  const value = resolveObjectField(field, parent, ctx);
  if (value === null || field.selectionSet === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__type' in item) {
        return executeSelections(field.selectionSet!, item as GqlValue, ctx);
      }
      return item;
    });
  }
  if (typeof value !== 'object') return value;
  return executeSelections(field.selectionSet, value as GqlValue, ctx);
}

function resolveObjectField(field: FieldNode, parent: GqlValue, ctx: ExecCtx): unknown {
  const name = field.name;
  const args = argsMap(field, ctx);
  const store = ctx.store;

  if (parent.__type === 'Query') {
    if (name === 'viewer') return { __type: 'User' } as GqlValue;
    if (name === 'repository') {
      const owner = args['owner'];
      const repoName = args['name'];
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = store.getRepo(owner, repoName);
      return repo === undefined ? null : ({ __type: 'Repository', repo } as GqlValue);
    }
    if (name === 'node') {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      return resolveNode(store, id);
    }
  }

  if (parent.__type === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(store, args);
    if (name === 'closeIssue') return mutateCloseIssue(store, args);
    if (name === 'createPullRequest') return mutateCreatePullRequest(store, args);
    if (name === 'mergePullRequest') return mutateMergePullRequest(store, args);
    if (name === 'addComment') return mutateAddComment(store, args);
  }

  if (parent.__type === 'User') {
    if (name === 'login') return VIEWER_LOGIN;
    if (name === 'id') return String(VIEWER_ID);
  }

  if (parent.__type === 'Repository') {
    const repo = parent.repo;
    if (name === 'id') return gid('Repository', `${repo.owner}/${repo.name}`);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return { __type: 'User' } as GqlValue;
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch } as GqlValue);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((i) => i.number === number);
      return issue === undefined ? null : ({ __type: 'Issue', repo, issue } as GqlValue);
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequests') return pullsConnection(repo, args);
    if (name === 'pullRequest') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((p) => p.number === number);
      return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } as GqlValue);
    }
  }

  if (parent.__type === 'Issue') {
    const issue = parent.issue;
    if (name === 'id') return gid('Issue', `${parent.repo.owner}/${parent.repo.name}#${issue.number}`);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'body') return issue.body;
  }

  if (parent.__type === 'IssueConnection') {
    if (name === 'nodes') return parent.items.map((issue) => ({ __type: 'Issue', repo: parent.repo, issue } as GqlValue));
    if (name === 'edges') {
      return parent.items.map((issue) => ({ __type: 'IssueEdge', repo: parent.repo, issue, cursor: encodeCursor(issue.number) } as GqlValue));
    }
    if (name === 'pageInfo') return { __type: 'PageInfo', hasNext: parent.hasNext, endCursor: parent.endCursor } as GqlValue;
    if (name === 'totalCount') return parent.items.length;
  }

  if (parent.__type === 'IssueEdge') {
    if (name === 'node') return { __type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
    if (name === 'cursor') return parent.cursor;
  }

  if (parent.__type === 'PullRequest') {
    const pull = parent.pull;
    if (name === 'id') return gid('PullRequest', `${parent.repo.owner}/${parent.repo.name}!${pull.number}`);
    if (name === 'number') return pull.number;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullIsMergeable(store, parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (name === 'files') {
      const first = typeof args['first'] === 'number' ? args['first'] : undefined;
      return filesConnection(store, parent.repo, pull, first);
    }
  }

  if (parent.__type === 'PullRequestConnection') {
    if (name === 'nodes') return parent.items.map((pull) => ({ __type: 'PullRequest', repo: parent.repo, pull } as GqlValue));
    if (name === 'edges') {
      return parent.items.map((pull) => ({ __type: 'PullRequestEdge', repo: parent.repo, pull, cursor: encodeCursor(pull.number) } as GqlValue));
    }
    if (name === 'pageInfo') return { __type: 'PageInfo', hasNext: parent.hasNext, endCursor: parent.endCursor } as GqlValue;
    if (name === 'totalCount') return parent.items.length;
  }

  if (parent.__type === 'PullRequestEdge') {
    if (name === 'node') return { __type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue;
    if (name === 'cursor') return parent.cursor;
  }

  if (parent.__type === 'FileConnection') {
    if (name === 'nodes') return parent.paths.map((path) => ({ __type: 'FileNode', path } as GqlValue));
    if (name === 'edges') {
      return parent.paths.map((path, i) => ({ __type: 'FileEdge', path, cursor: encodeCursor(i + 1) } as GqlValue));
    }
    if (name === 'pageInfo') return { __type: 'PageInfo', hasNext: false, endCursor: null } as GqlValue;
    if (name === 'totalCount') return parent.paths.length;
  }

  if (parent.__type === 'FileEdge') {
    if (name === 'node') return { __type: 'FileNode', path: parent.path } as GqlValue;
    if (name === 'cursor') return parent.cursor;
  }

  if (parent.__type === 'FileNode') {
    if (name === 'path') return parent.path;
  }

  if (parent.__type === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNext;
    if (name === 'endCursor') return parent.endCursor;
  }

  if (parent.__type === 'Ref') {
    if (name === 'name') return parent.name;
  }

  if (parent.__type === 'IssueComment') {
    if (name === 'id') return gid('IssueComment', `${parent.repo.owner}/${parent.repo.name}#${parent.issue.number}:${parent.comment.id}`);
    if (name === 'body') return parent.comment.body;
  }

  if (parent.__type === 'IssueCommentEdge') {
    if (name === 'node') return { __type: 'IssueComment', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlValue;
  }

  if (parent.__type === 'CreateIssuePayload' || parent.__type === 'CloseIssuePayload') {
    if (name === 'issue') return { __type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
  }

  if (parent.__type === 'CreatePullRequestPayload' || parent.__type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return { __type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue;
  }

  if (parent.__type === 'AddCommentPayload') {
    if (name === 'commentEdge') return { __type: 'IssueCommentEdge', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlValue;
  }

  if (parent.__type === '__Type') {
    if (name === 'name') return parent.name;
    if (name === 'kind') return typeKind(parent.name);
    if (name === 'fields') {
      const fields = SCHEMA[parent.name] ?? [];
      return fields.map((f) => ({ __type: '__Field', name: f } as GqlValue));
    }
    if (name === 'enumValues') {
      const values = ENUM_VALUES[parent.name] ?? [];
      return values.map((v) => ({ __type: '__EnumValue', name: v } as GqlValue));
    }
  }

  if (parent.__type === '__Field' || parent.__type === '__EnumValue') {
    if (name === 'name') return parent.name;
  }

  return null;
}

// -------------------------------------------------------------------------------------------
// Connections
// -------------------------------------------------------------------------------------------

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args['states']) ? (args['states'] as string[]) : null;
  const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? {};
  const direction = orderBy['direction'] === 'ASC' ? 'ASC' : 'DESC';
  const first = typeof args['first'] === 'number' ? args['first'] : 30;
  const after = typeof args['after'] === 'string' ? decodeCursor(args['after']) : null;
  let issues = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  } else {
    issues = issues.filter((i) => i.state === 'open');
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    const index = issues.findIndex((i) => i.number === after);
    issues = index < 0 ? issues : issues.slice(index + 1);
  }
  const page = issues.slice(0, first);
  return {
    __type: 'IssueConnection',
    items: page,
    repo,
    hasNext: issues.length > page.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
  } as GqlValue;
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args['states']) ? (args['states'] as string[]) : null;
  const first = typeof args['first'] === 'number' ? args['first'] : 30;
  const after = typeof args['after'] === 'string' ? decodeCursor(args['after']) : null;
  let pulls = [...repo.pulls];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    pulls = pulls.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
  } else {
    pulls = pulls.filter((p) => p.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  if (after !== null) {
    const index = pulls.findIndex((p) => p.number === after);
    pulls = index < 0 ? pulls : pulls.slice(index + 1);
  }
  const page = pulls.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    items: page,
    repo,
    hasNext: pulls.length > page.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
  } as GqlValue;
}

function filesConnection(store: Store, repo: Repo, pull: Pull, first: number | undefined): GqlValue {
  const baseObject = repo.objects.get(pull.baseSha);
  const baseTree = baseObject !== undefined && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : undefined;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const headObject = repo.objects.get(headTip);
  const headTree = headObject !== undefined && headObject.type === 'commit' ? parseCommit(headObject.data).tree : undefined;
  const baseFiles = baseTree === undefined ? new Map() : store.flattenTree(repo, baseTree);
  const headFiles = headTree === undefined ? new Map() : store.flattenTree(repo, headTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const changed: string[] = [];
  for (const path of [...paths].sort()) {
    if ((baseFiles.get(path)?.oid ?? null) !== (headFiles.get(path)?.oid ?? null)) changed.push(path);
  }
  const limited = first === undefined ? changed : changed.slice(0, first);
  return { __type: 'FileConnection', paths: limited } as GqlValue;
}

/** The same conflict rule as the REST merge, without applying it. */
function pullIsMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  const baseObject = repo.objects.get(pull.baseSha);
  const headObject = repo.objects.get(headTip);
  const currentBaseObject = repo.objects.get(baseTip);
  if (baseObject === undefined || headObject === undefined || currentBaseObject === undefined) return false;
  const baseFiles = store.flattenTree(repo, parseCommit(baseObject.data).tree);
  const headFiles = store.flattenTree(repo, parseCommit(headObject.data).tree);
  const currentBaseFiles = store.flattenTree(repo, parseCommit(currentBaseObject.data).tree);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys(), ...currentBaseFiles.keys()]);
  for (const path of paths) {
    const fromBase = baseFiles.get(path);
    const fromHead = headFiles.get(path);
    const fromCurrent = currentBaseFiles.get(path);
    if ((fromHead?.oid ?? null) !== (fromBase?.oid ?? null)
      && (fromCurrent?.oid ?? null) !== (fromBase?.oid ?? null)
      && (fromHead?.oid ?? null) !== (fromCurrent?.oid ?? null)) {
      return false;
    }
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// node(id:)
// -------------------------------------------------------------------------------------------

function resolveNode(store: Store, id: string): GqlValue | null {
  const parsed = ungid(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const slash = parsed.key.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1));
    return repo === undefined ? null : ({ __type: 'Repository', repo } as GqlValue);
  }
  if (parsed.type === 'Issue' || parsed.type === 'IssueComment') {
    const hash = parsed.key.indexOf('#');
    if (hash < 0) return null;
    const ownerName = parsed.key.slice(0, hash);
    const slash = ownerName.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
    if (repo === undefined) return null;
    const rest = parsed.key.slice(hash + 1);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.find((i) => i.number === Number.parseInt(rest, 10));
      return issue === undefined ? null : ({ __type: 'Issue', repo, issue } as GqlValue);
    }
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const issue = repo.issues.find((i) => i.number === Number.parseInt(rest.slice(0, colon), 10));
    if (issue === undefined) return null;
    const comment = issue.comments.find((c) => c.id === Number.parseInt(rest.slice(colon + 1), 10));
    return comment === undefined ? null : ({ __type: 'IssueComment', repo, issue, comment } as GqlValue);
  }
  if (parsed.type === 'PullRequest') {
    const bang = parsed.key.indexOf('!');
    if (bang < 0) return null;
    const ownerName = parsed.key.slice(0, bang);
    const slash = ownerName.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
    if (repo === undefined) return null;
    const pull = repo.pulls.find((p) => p.number === Number.parseInt(parsed.key.slice(bang + 1), 10));
    return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } as GqlValue);
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Mutations
// -------------------------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args['input'];
  return (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input as Record<string, unknown> : {};
}

function repoFromGid(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = ungid(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const slash = parsed.key.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1)) ?? null;
}

function mutateCreateIssue(store: Store, args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const repo = repoFromGid(store, input['repositoryId']);
  if (repo === null) throw new GraphQLError('repository not found');
  const title = input['title'];
  if (typeof title !== 'string' || title === '') throw new GraphQLError('title is required');
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body: typeof input['body'] === 'string' ? input['body'] : '',
    state: 'open',
    labels: [],
    comments: [],
    seq: store.nextIssueSeq++,
  };
  repo.issues.push(issue);
  return { __type: 'CreateIssuePayload', repo, issue } as GqlValue;
}

function mutateCloseIssue(store: Store, args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const id = input['issueId'];
  if (typeof id !== 'string') throw new GraphQLError('issueId is required');
  const node = resolveNode(store, id);
  if (node === null || node.__type !== 'Issue') throw new GraphQLError('issue not found');
  node.issue.state = 'closed';
  return { __type: 'CloseIssuePayload', repo: node.repo, issue: node.issue } as GqlValue;
}

function mutateCreatePullRequest(store: Store, args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const repo = repoFromGid(store, input['repositoryId']);
  if (repo === null) throw new GraphQLError('repository not found');
  const head = input['headRefName'];
  const base = input['baseRefName'];
  const title = input['title'];
  if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
    throw new GraphQLError('headRefName, baseRefName and title are required');
  }
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) throw new GraphQLError('head or base branch does not exist');
  const duplicate = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
  if (duplicate !== undefined) throw new GraphQLError('a pull request for this head and base already exists');
  const pull: Pull = {
    id: store.nextPullId++,
    number: repo.nextPullNumber++,
    title,
    body: '',
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
  return { __type: 'CreatePullRequestPayload', repo, pull } as GqlValue;
}

function mutateMergePullRequest(store: Store, args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const id = input['pullRequestId'];
  if (typeof id !== 'string') throw new GraphQLError('pullRequestId is required');
  const node = resolveNode(store, id);
  if (node === null || node.__type !== 'PullRequest') throw new GraphQLError('pull request not found');
  const result = mergePullRequestCore(store, node.repo, node.pull);
  if (!result.merged) throw new GraphQLError(result.message);
  return { __type: 'MergePullRequestPayload', repo: node.repo, pull: node.pull } as GqlValue;
}

function mutateAddComment(store: Store, args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const id = input['subjectId'];
  const body = input['body'];
  if (typeof id !== 'string') throw new GraphQLError('subjectId is required');
  if (typeof body !== 'string') throw new GraphQLError('body is required');
  const node = resolveNode(store, id);
  if (node === null || node.__type !== 'Issue') throw new GraphQLError('subject not found');
  const comment = { id: store.nextCommentId++, body };
  node.issue.comments.push(comment);
  return { __type: 'AddCommentPayload', repo: node.repo, issue: node.issue, comment } as GqlValue;
}

// -------------------------------------------------------------------------------------------
// Entry point: one parsed body (object or array) -> the GraphQL response.
// -------------------------------------------------------------------------------------------

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
  }
  const query = (body as Record<string, unknown>)['query'];
  if (typeof query !== 'string' || query === '') {
    return { errors: [{ message: 'GraphQL query is required' }] };
  }
  const variables = (body as Record<string, unknown>)['variables'];
  const variablesMap: Record<string, unknown> = (typeof variables === 'object' && variables !== null && !Array.isArray(variables))
    ? variables as Record<string, unknown>
    : {};
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  if (operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  const operationName = (body as Record<string, unknown>)['operationName'];
  let operation = operations[0]!;
  if (typeof operationName === 'string') {
    const named = operations.find((o) => o.name === operationName);
    if (named === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
    operation = named;
  } else if (operations.length > 1) {
    return { errors: [{ message: 'Multiple operations require an operationName' }] };
  }
  const ctx: ExecCtx = { store, variables: { ...variablesMap }, fragments };
  for (const def of operation.variables) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== null) {
      ctx.variables[def.name] = resolveValue(def.defaultValue, ctx.variables);
    }
  }
  const root: GqlValue = operation.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const errors: string[] = [];
  validateSelections(operation.selectionSet, operation.operation === 'mutation' ? 'Mutation' : 'Query', ctx, errors);
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
  try {
    const data = executeSelections(operation.selectionSet, root, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((item) => executeOne(store, item));
  return executeOne(store, body);
}
