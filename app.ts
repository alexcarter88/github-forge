// The HTTP server: one in-memory store, routing for /healthz, git smart HTTP, REST v3,
// GraphQL and MCP, with bearer-token auth on everything except /healthz and the two
// unauthenticated REST reads (GET /api/v3/ and GET /api/v3/meta). Every response carries a
// sequential X-GitHub-Request-Id; nothing in a response comes from the wall clock, randomness
// or the environment, so replays are byte-identical.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  function nextRequestId(): string {
    requestSeq += 1;
    return `req-${requestSeq}`;
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(body);
  }

  function sendEmpty(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'x-github-request-id': nextRequestId() });
    res.end();
  }

  function sendBuffer(res: ServerResponse, status: number, contentType: string, payload: Buffer): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': payload.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(payload);
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          tooLarge = true;
          req.destroy();
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          res.destroy();
        }
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);
    let jsonBody: unknown;
    let jsonError = false;
    if (rawBody.length > 0) {
      try {
        jsonBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        jsonError = true;
      }
    }

    // Auth: everything except /healthz and the two unauthenticated REST reads.
    const unauthenticated =
      (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta') && method === 'GET';
    if (!unauthenticated) {
      const auth = req.headers.authorization ?? '';
      if (token === '' || auth !== `Bearer ${token}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    }

    // MCP.
    if (path === '/mcp') {
      if (method === 'DELETE') {
        sendEmpty(res, 204);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const outcome = handleMcp(store, jsonError ? null : jsonBody, rawBody.toString('utf8'));
      if (outcome.payload === null) {
        sendEmpty(res, outcome.status);
      } else {
        sendJson(res, outcome.status, outcome.payload);
      }
      return;
    }

    // GraphQL.
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (jsonError) {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return;
      }
      sendJson(res, 200, handleGraphQL(store, jsonBody));
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (jsonError) {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return;
      }
      const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
      const segments = restPath === '' ? [] : restPath.split('/').map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
      if (segments.length === 0 && method === 'GET') {
        res.setHeader('x-oauth-scopes', 'repo, read:org');
      }
      handleRest(store, req, res, segments, url.searchParams, jsonBody, {
        sendJson: (status, payload) => sendJson(res, status, payload),
        sendEmpty: (status) => sendEmpty(res, status),
      });
      return;
    }

    // git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const sub = gitMatch[3]!;
      handleGit(store, req, res, owner, repoName, sub, rawBody,
        (status, contentType, payload) => sendBuffer(res, status, contentType, payload),
        (status, payload) => sendJson(res, status, payload));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}
