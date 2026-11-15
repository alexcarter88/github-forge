// Entry point: start the forge server and hand its address to the trial env.
//
// The env owns the trial. This process only does the lifecycle: bind a free port,
// tell the env where to reach the server, then wait until the env says the trial
// is over and exit. The server itself lives in app.ts; this file only runs it.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      register with, so the process exits 1 right away.
//   2. Listen on port 0 and let the kernel pick a free one. Never bind 8080:
//      that port belongs to the env.
//   3. POST /register {"port": N}. The env records where the request came from
//      plus N and dials the server from then on. The first register wins; a 409
//      means another entry already registered, which is fine to accept and keep
//      waiting. 400/405 are contract errors and end the process; anything else
//      is retried, since the env may still be starting.
//   4. GET /done until it answers {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll. A failed or
//      slow poll is retried with a short exponential backoff; the process never
//      exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

type FetchFn = (attempt: number) => Promise<Response>;

/**
 * Run fetchFn until it returns a response the caller accepts, retrying network
 * errors and unaccepted statuses with backoff. A thrown error whose message
 * starts with "fatal:" ends the process instead of retrying.
 */
async function untilAccepted(fetchFn: FetchFn, accept: (res: Response) => boolean | Promise<boolean>): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetchFn(attempt);
      if (await accept(res)) return res;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('fatal:')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function register(port: number): Promise<void> {
  await untilAccepted(
    () =>
      fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    async (res) => {
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`fatal: register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    },
  );
}

async function waitForDone(): Promise<void> {
  await untilAccepted(
    () => fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    async (res) => {
      if (!res.ok) return false;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true;
    },
  );
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
