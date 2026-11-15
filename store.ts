// The forge's store and its git object model: one in-memory Store per server process,
// holding every repository's objects, refs, issues, pull requests and labels. Nothing here
// touches the disk, the clock or randomness in a way a response could observe: ids come from
// sequential counters and timestamps from a logical clock, so two runs over the same requests
// answer byte-identically.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const IDENTITY = 'Conformance <conformance@make.fun>';
export const AGENT = 'forge/1.0';

const SHA40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return SHA40.test(value);
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** SHA-1 of `<type> <len>\0<data>`, the git object id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([head, data]));
}

// -------------------------------------------------------------------------------------------
// Parsed git objects
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${IDENTITY} ${fields.timestamp} +0000`, `committer ${IDENTITY} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// Packfiles: plain objects only, never deltas.
// -------------------------------------------------------------------------------------------

function encodeObjectHeader(type: ObjType, size: number): Buffer {
  const typeCode = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2) of plain objects, deduplicated by id, with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const seen = new Map<string, GitObject>();
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (!seen.has(oid)) seen.set(oid, object);
  }
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(seen.size, 8);
  parts.push(head);
  for (const object of seen.values()) {
    parts.push(encodeObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackEntry {
  type: ObjType;
  size: number;
  data: Buffer;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile. Verifies the trailer checksum and every object's declared size; resolves
 * REF_DELTA/OFS_DELTA against the pack itself (thin packs are never sent by this forge, and a
 * client thin pack's bases are looked up through `resolveBase`).
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): GitObject[] {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  if (sha1(buffer.subarray(0, trailerStart)) !== trailer) throw new Error('pack trailer checksum mismatch');
  const objects: GitObject[] = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let offset = 12;
  const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack is truncated');
    let byte = buffer[offset++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buffer[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) {
      // Delta object: resolve the base, then apply.
      let base: GitObject | undefined;
      if (typeCode === 6) {
        if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
        let b = buffer[offset++];
        let value = b & 0x7f;
        while (b & 0x80) {
          if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
          b = buffer[offset++];
          value = ((value + 1) * 128) + (b & 0x7f);
        }
        base = byOffset.get(entryOffset - value);
      } else {
        if (offset + 20 > trailerStart) throw new Error('ref-delta has no base id');
        const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        base = byOid.get(baseOid) ?? resolveBase?.(baseOid);
      }
      if (base === undefined) throw new Error('delta base is not available');
      const inflated = inflateAt(buffer, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('delta entry size mismatch');
      const data = applyDelta(base.data, inflated.data);
      const object: GitObject = { type: base.type, data };
      objects.push(object);
      byOffset.set(entryOffset, object);
      byOid.set(hashObject(object.type, data), object);
      continue;
    }
    const type = TYPE_NAMES[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateAt(buffer, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    const object: GitObject = { type, data: inflated.data };
    objects.push(object);
    byOffset.set(entryOffset, object);
    byOid.set(hashObject(type, inflated.data), object);
  }
  return objects;
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// -------------------------------------------------------------------------------------------
// Pkt-lines
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload?: Buffer;
}

export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines; throws on a malformed header or truncation. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to (and including) the first flush packet; returns the packets and the
 * byte offset just past the flush, where a packfile begins. The bytes after the flush are raw
 * pack data, never pkt-lines.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: Pkt[]; packStart: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, packStart: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, packStart: offset };
}

/** Split decoded packets into sections at flush/delim boundaries (data packets only). */
export function packetLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// The store
// -------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The base tip recorded when the pull request was opened (conflict detection reads this). */
  baseSha: string;
  headShaAtCreate: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, string>;
  nextIssueNumber: number;
  nextPullNumber: number;
  seq: number;
  /** Bumped on every mutation; fetch-pack cache keys include it. */
  gen: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextRepoSeq = 1;
  nextIssueSeq = 1;
  /** Logical clock: seconds since the fixed epoch, one tick per server-made commit. */
  clock = 1700000000;

  stamp(): string {
    const stamp = new Date(this.clock * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.clock += 1;
    return stamp;
  }

  commitTimestamp(): number {
    const ts = this.clock;
    this.clock += 1;
    return ts;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      seq: this.nextRepoSeq++,
      gen: 0,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  /** All of the viewer's repositories, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Follow tag objects to the first non-tag object. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return current;
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      const tag = parseTag(object.data);
      if (!isOid(tag.object)) return current;
      current = tag.object;
    }
  }

  /** The full closure of `oids`: commits (parents, trees), trees (entries), tags (target). */
  closure(repo: Repo, oids: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...oids];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const tag = parseTag(object.data);
        if (isOid(tag.object)) stack.push(tag.object);
      }
    }
    return out;
  }

  /** Commit distance from any of `starts` (tags peeled), by parent edges only. */
  commitDistances(repo: Repo, starts: readonly string[]): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [];
    for (const start of starts) {
      const peeled = this.peel(repo, start);
      if (!distances.has(peeled) && repo.objects.get(peeled)?.type === 'commit') {
        distances.set(peeled, 0);
        queue.push(peeled);
      }
    }
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head]!;
      const distance = distances.get(oid)!;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distances.has(parent) && repo.objects.get(parent)?.type === 'commit') {
          distances.set(parent, distance + 1);
          queue.push(parent);
        }
      }
    }
    return distances;
  }

  /** True when `ancestor` is reachable from `oid` through parent edges (or equal). */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /**
   * The objects a fetch client already holds, given its haves and its shallow boundaries.
   * A have's closure is full — parents included — except at a shallow boundary, where the
   * client holds the boundary commit and its tree but none of its ancestors. That is the
   * whole point of the `shallow` lines: without them a deepen would subtract the very
   * commits it is supposed to deliver.
   */
  haveClosure(repo: Repo, haves: readonly string[], shallowKnown: readonly string[]): Set<string> {
    const shallow = new Set(shallowKnown);
    const out = new Set<string>();
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        for (const treeOid of this.closure(repo, [parseCommit(object.data).tree])) out.add(treeOid);
        if (!shallow.has(oid)) {
          for (const parent of parseCommit(object.data).parents) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const treeOid of this.closure(repo, [oid])) out.add(treeOid);
      } else if (object.type === 'tag') {
        const tag = parseTag(object.data);
        if (isOid(tag.object)) stack.push(tag.object);
      }
    }
    return out;
  }

  /** The flat file map of a tree: path -> {oid, mode}, directories expanded. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build the nested trees for a flat file map; returns the root tree oid. */
  buildTrees(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const ensure = (dir: string): Map<string, { oid: string; mode: string }> => {
      let map = dirs.get(dir);
      if (map === undefined) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    ensure('');
    for (const [path, entry] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      ensure(dir).set(name, entry);
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of ensure(dir)) entries.push({ mode: entry.mode, name, oid: entry.oid });
      // Subdirectories of this directory.
      const prefix = dir === '' ? '' : `${dir}/`;
      const subdirs = new Set<string>();
      for (const key of dirs.keys()) {
        if (key.startsWith(prefix) && key !== dir) {
          const rest = key.slice(prefix.length);
          if (!rest.includes('/')) subdirs.add(rest);
        }
      }
      for (const name of subdirs) entries.push({ mode: '40000', name, oid: buildDir(prefix + name) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }
}

// -------------------------------------------------------------------------------------------
// Line diff (for pull-request files): a small LCS over lines.
// -------------------------------------------------------------------------------------------

export interface LineDiff {
  additions: number;
  deletions: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(oldText: string, newText: string): LineDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return { additions, deletions };
  }
  // LCS dynamic programming, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

/** Base64 helpers that tolerate the whitespace GitHub clients sometimes add. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

export function b64encode(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}
