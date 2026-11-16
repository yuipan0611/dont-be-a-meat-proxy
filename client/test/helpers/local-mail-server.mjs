// Starts a throwaway local mcp_agent_mail_rust server (F-01b launch method) for integration tests.
// Binary: $MAIL_BIN, else <repo>/.hub-local/bin/mcp-agent-mail (gitignored). Data lives in a temp dir
// that is deleted on stop(). Env mirrors SDS API-01 mail-a settings.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAIL_BIN = process.env.MAIL_BIN || join(repoRoot, '.hub-local', 'bin', 'mcp-agent-mail');

export async function mailBinAvailable() {
  try {
    await access(MAIL_BIN);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function startLocalMail({ dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'hub-mail-it-')));
  const port = await freePort();
  const upstreamToken = randomBytes(24).toString('base64url');
  const env = {
    ...process.env,
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    HTTP_PATH: '/mcp/',
    HTTP_BEARER_TOKEN: upstreamToken,
    HTTP_JWT_ENABLED: 'false',
    HTTP_ALLOW_LOCALHOST_UNAUTHENTICATED: 'false',
    HTTP_RBAC_DEFAULT_ROLE: 'writer',
    STORAGE_ROOT: join(dir, 'archive'),
    DATABASE_URL: `sqlite:///${join(dir, 'mail.sqlite3')}`,
    XDG_DATA_HOME: join(dir, 'xdg-data'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
    XDG_CACHE_HOME: join(dir, 'xdg-cache'),
    MESSAGING_SESSION_IDENTITY: 'true',
    MESSAGING_FAIL_CLOSED_SEND_PROFILE: 'true',
    MESSAGING_AUTO_REGISTER_RECIPIENTS: 'false',
    AM_SEARCH_SEMANTIC_ENABLED: 'false',
    LLM_ENABLED: 'false',
    TOOLS_LOG_ENABLED: 'false',
    LOG_RICH_ENABLED: 'false',
    HTTP_REQUEST_LOG_ENABLED: 'false',
  };
  const proc = spawn(MAIL_BIN, ['serve', '--no-tui', '--host', '127.0.0.1', '--port', String(port), '--no-reuse-running'], {
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`mail server exited early: ${stderr.slice(-2000)}`);
    try {
      const r = await fetch(`${base}/health/liveness`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      proc.kill('SIGTERM');
      throw new Error('mail server did not become live in 15s');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url: `${base}/mcp/`,
    token: upstreamToken,
    dataDir: dir,
    pid: proc.pid,
    async stop({ keepData = false } = {}) {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
      if (!keepData) await rm(dir, { recursive: true, force: true });
    },
  };
}
