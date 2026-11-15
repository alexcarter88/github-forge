// git smart HTTP: info/refs advertisements (v2 for upload-pack, v0 for both services),
// v2 ls-refs and fetch, v0 fetch, and v0 receive-pack. Plain objects only, never deltas;
// every pack is checksummed and deduplicated.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT,
  DEFAULT_BRANCH,
  FLUSH_PKT,
  ZERO_OID,
  decodePktLines,
  decodePktLinesUntilFlush,
  hashObject,
  isOid,
  packetLines,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'upload-pack' | 'receive-pack';
  sub: string;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function uploadCaps(): string {
  return `side-band-64k shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
}

function receiveCaps(): string {
  return `report-status side-band-64k delete-refs agent=${AGENT}`;
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return Buffer.concat(parts);
}

/** The v0 ref advertisement for one service. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceName = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const caps = service === 'git-upload-pack' ? uploadCaps() : receiveCaps();
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), FLUSH_PKT];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    let first = true;
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      if (first) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** A ref line for ls-refs, with symref-target / peeled tokens when asked. */
function lsRefsLine(
  store: Store,
  repo: Repo,
  name: string,
  oid: string,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean },
): string | null {
  if (name === 'HEAD') {
    if (!opts.symrefs) return null;
    const tip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (tip === undefined) {
      if (!opts.unborn) return null;
      return `unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`;
    }
    return `${tip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`;
  }
  let line = `${oid} ${name}`;
  if (opts.peel) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = store.peel(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
  }
  return `${line}\n`;
}

/** v2 ls-refs: server-side ref-prefix filtering, HEAD included only when it matches. */
function handleLsRefs(
  store: Store,
  repo: Repo,
  args: readonly string[],
): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const opts = { peel, symrefs, unborn };
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (keep('HEAD')) {
    const line = lsRefsLine(store, repo, 'HEAD', headTip ?? ZERO_OID, opts);
    if (line !== null) parts.push(pktLine(line));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const line = lsRefsLine(store, repo, ref.name, ref.oid, opts);
    if (line !== null) parts.push(pktLine(line));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

interface FetchPlan {
  /** Objects to send (already minus the haves' closure). */
  send: GitObject[];
  /** Oids the client holds, for the acknowledgment section. */
  acks: string[];
  /** New shallow boundaries, at distance depth-1 from a want. */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
}

const fetchCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();

/**
 * The send set for a fetch: wants' reachable objects (or, with a depth, the commits within
 * depth and their trees/blobs) minus the haves' full closure.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowKnown: readonly string[],
  depth: number | null,
): FetchPlan {
  const haveSet = store.haveClosure(repo, haves, shallowKnown);
  const acks = haves.filter((oid) => repo.objects.has(oid));
  let shallow: string[] = [];
  let unshallow: string[] = [];
  let sendIds: Set<string>;
  if (depth === null) {
    sendIds = store.closure(repo, wants);
  } else {
    const distances = store.commitDistances(repo, wants);
    const included = new Set<string>();
    const boundaries = new Set<string>();
    for (const [oid, distance] of distances) {
      if (distance < depth) included.add(oid);
      if (distance === depth - 1) boundaries.add(oid);
    }
    // Wanted tag objects travel too, with their tag chain.
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object === undefined || object.type !== 'tag') continue;
      included.add(want);
      let current = want;
      for (;;) {
        const tagObject = repo.objects.get(current);
        if (tagObject === undefined || tagObject.type !== 'tag') break;
        const target = parseTag(tagObject.data).object;
        if (!isOid(target)) break;
        if (repo.objects.get(target)?.type === 'tag') {
          included.add(target);
          current = target;
          continue;
        }
        break;
      }
    }
    // Depth-limited closure: a commit contributes itself and its tree, never its parents.
    sendIds = new Set<string>();
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      sendIds.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const treeOid of store.closure(repo, [commit.tree])) sendIds.add(treeOid);
      } else if (object.type === 'tree') {
        for (const treeOid of store.closure(repo, [oid])) sendIds.add(treeOid);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (isOid(target)) {
          const targetObject = repo.objects.get(target);
          if (targetObject !== undefined && targetObject.type !== 'commit') {
            sendIds.add(target);
            for (const treeOid of store.closure(repo, [target])) sendIds.add(treeOid);
          }
        }
      }
    }
    shallow = [...boundaries].sort();
    const boundarySet = boundaries;
    unshallow = shallowKnown.filter((oid) => included.has(oid) && !boundarySet.has(oid)).sort();
  }
  for (const oid of haveSet) sendIds.delete(oid);
  const send: GitObject[] = [];
  for (const oid of sendIds) {
    const object = repo.objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, by id within a type.
  const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3);
  send.sort((a, b) => {
    const ra = rank(a.type);
    const rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });
  return { send, acks, shallow, unshallow };
}

/** Wrap pack bytes in sideband (band 1) pkt-lines, chunked to the 64k frame. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function handleFetchV2(store: Store, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowKnown.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (arg === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, agent,
    // object-format: read and ignored; this forge sends plain objects only.
  }
  const knownWants = wants.filter((oid) => repo.objects.has(oid));
  const cacheKey = `${repo.name}\n${repo.gen}\n${[...knownWants].sort().join(',')}\n${[...haves].sort().join(',')}\n${[...shallowKnown].sort().join(',')}\n${depth ?? ''}`;
  let cached = fetchCache.get(cacheKey);
  let plan: FetchPlan;
  if (cached === undefined) {
    plan = planFetch(store, repo, knownWants, haves, shallowKnown, depth);
    const pack = plan.send.length > 0 ? writePack(plan.send) : Buffer.alloc(0);
    cached = { pack, shallow: plan.shallow, unshallow: plan.unshallow };
    if (fetchCache.size > 128) fetchCache.clear();
    fetchCache.set(cacheKey, cached);
  } else {
    plan = { send: [], acks: haves.filter((oid) => repo.objects.has(oid)), shallow: cached.shallow, unshallow: cached.unshallow };
  }
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  if (done) parts.push(pktLine('ready\n'));
  parts.push(FLUSH_PKT);
  if (cached.shallow.length > 0 || cached.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of cached.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of cached.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  if (cached.pack.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(cached.pack));
    parts.push(FLUSH_PKT);
  }
  return Buffer.concat(parts);
}

function handleFetchV0(store: Store, repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  let done = false;
  let section = 0;
  for (const line of lines) {
    if (line === '') {
      section += 1;
      continue;
    }
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim().split(/\s+/);
        if (rest[0] !== undefined && isOid(rest[0])) wants.push(rest[0]);
      } else if (line.startsWith('shallow ')) shallowKnown.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line === 'done') done = true;
    }
  }
  void done;
  const knownWants = wants.filter((oid) => repo.objects.has(oid));
  const plan = planFetch(store, repo, knownWants, haves, shallowKnown, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.length > 0) parts.push(...sidebandPack(writePack(plan.send)));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** The v2 upload-pack POST: one command, then arguments after a delim. */
function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines = packetLines(packets);
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command !== 'command=ls-refs' && command !== 'command=fetch') {
    throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  }
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argPackets = delimIndex < 0 ? [] : packets.slice(delimIndex + 1);
  const args = packetLines(argPackets).map((line) => line.replace(/\n$/, ''));
  if (command === 'command=ls-refs') return handleLsRefs(store, repo, args);
  return handleFetchV2(store, repo, args);
}

/** The v0 upload-pack POST: wants, flush, haves, done, flush. */
function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else if (packet.kind === 'flush') lines.push('');
  }
  return handleFetchV0(store, repo, lines);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The v0 receive-pack POST: command lines, flush, then the pack. */
function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  // Only the command lines are pkt-lines; the pack after the flush is raw binary.
  const { packets, packStart } = decodePktLinesUntilFlush(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    let line = text;
    if (nul >= 0 && commands.length === 0) {
      capabilities = text.slice(nul + 1);
      line = text.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of objects) {
        if (!repo.objects.has(hashObject(object.type, object.data))) {
          repo.objects.set(hashObject(object.type, object.data), object);
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'invalid command' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else if (!repo.objects.has(command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          repo.gen += 1;
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          repo.gen += 1;
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        repo.gen += 1;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
  }
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(FLUSH_PKT);
  const report = Buffer.concat(reportParts);
  if (capabilities.includes('side-band-64k')) {
    const parts: Buffer[] = [];
    for (let off = 0; off < report.length; off += 65515) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(off, Math.min(report.length, off + 65515))])));
    }
    parts.push(FLUSH_PKT);
    return Buffer.concat(parts);
  }
  return report;
}

// -------------------------------------------------------------------------------------------
// Entry point: one git request. `send` answers with a body and content type.
// -------------------------------------------------------------------------------------------

export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  body: Buffer,
  send: (status: number, contentType: string, payload: Buffer) => void,
  sendJson: (status: number, payload: unknown) => void,
): void {
  const repo = store.getRepo(owner, repoName);
  const service = sub === 'info/refs'
    ? new URL(req.url ?? '/', 'http://entry').searchParams.get('service')
    : sub === 'git-upload-pack'
      ? 'git-upload-pack'
      : sub === 'git-receive-pack'
        ? 'git-receive-pack'
        : null;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(404, { message: 'Not Found' });
    return;
  }
  if (repo === undefined) {
    sendJson(404, { message: 'Not Found' });
    return;
  }
  if (req.method === 'GET' && sub === 'info/refs') {
    const wantsV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    if (wantsV2) send(200, UPLOAD_AD, advertisementV2());
    else send(200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, advertisementV0(repo, service));
    return;
  }
  if (req.method === 'POST' && sub === 'git-upload-pack') {
    try {
      if (req.headers['git-protocol'] === 'version=2') {
        send(200, UPLOAD_RESULT, handleUploadPackV2(store, repo, body));
      } else {
        send(200, UPLOAD_RESULT, handleUploadPackV0(store, repo, body));
      }
    } catch {
      sendJson(400, { message: 'bad request' });
    }
    return;
  }
  if (req.method === 'POST' && sub === 'git-receive-pack') {
    try {
      send(200, RECEIVE_RESULT, handleReceivePack(store, repo, body));
    } catch {
      sendJson(400, { message: 'bad request' });
    }
    return;
  }
  sendJson(404, { message: 'Not Found' });
}
