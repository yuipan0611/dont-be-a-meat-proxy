import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayError } from './queue.mjs';

const POLICY = fileURLToPath(new URL('./deny-tools.toml', import.meta.url));
const SETTINGS = fileURLToPath(new URL('./settings.json', import.meta.url));
const MAX_OUTPUT = 8 * 1024 * 1024;

function classifyError(text) {
  if (/invalid_grant|reauth|authenticat|authorization|login|log in|credentials|sign in|expired.token|revoked|\b401\b|\b403\b/i.test(text)) return new GatewayError('AUTH_REQUIRED', 503);
  if (/429|quota|resource.exhausted|rate.limit/i.test(text)) return new GatewayError('UPSTREAM_QUOTA', 429);
  return new GatewayError('CLI_FAILED', 502);
}

/** Only invokes the official binary; never reads or forwards OAuth tokens itself. */
export function createGemini({ command = 'gemini', profileDir, timeoutMs = 90_000, maxOutput = MAX_OUTPUT, path = process.env.PATH,
  kind = 'gemini', inheritedHome = process.env.HOME } = {}) {
  if (!profileDir || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('profileDir and positive timeoutMs required');
  return {
    async generate({ prompt, model, signal }) {
      if (signal?.aborted) throw new GatewayError('CANCELLED', 499);
      if (kind === 'antigravity') {
        // The CLI has no documented per-request profile override: use its dedicated OS user's home.
        if (profileDir !== inheritedHome) throw new GatewayError('UNSAFE_CLI_PROFILE', 503);
        let settings;
        try { settings = JSON.parse(await readFile(join(profileDir, '.gemini/antigravity-cli/settings.json'), 'utf8')); }
        catch { throw new GatewayError('UNSAFE_CLI_PROFILE', 503); }
        const denied = settings.permissions?.deny ?? [];
        if (settings.useG1Credits !== false || settings.toolPermission !== 'strict' || settings.modelProvider ||
            !['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'command(*)', 'mcp(*)'].every((r) => denied.includes(r))) {
          throw new GatewayError('UNSAFE_CLI_PROFILE', 503);
        }
        // Reject profiles with executable customizations; never edit the user's/global agent settings.
        for (const name of ['hooks.json', 'mcp_config.json', 'plugins']) {
          let found = true;
          try { await access(join(profileDir, '.gemini/config', name)); } catch (e) { if (e.code === 'ENOENT') found = false; else throw e; }
          if (found) throw new GatewayError('UNSAFE_CLI_PROFILE', 503);
        }
      }
      const cwd = await mkdtemp(join(tmpdir(), 'hub-gemini-'));
      try {
        return await new Promise((resolve, reject) => {
          // Allowlist environment: no API keys, ADC/project, proxy tokens, NODE_OPTIONS or bot secrets.
          const env = kind === 'gemini' ? { PATH: path, GEMINI_CLI_HOME: profileDir, NO_BROWSER: 'true',
            GEMINI_FORCE_FILE_STORAGE: 'true', GEMINI_CLI_SYSTEM_SETTINGS_PATH: SETTINGS,
            GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: SETTINGS, LANG: 'C.UTF-8' }
            : { PATH: path, HOME: inheritedHome, LANG: 'C.UTF-8' };
          const args = kind === 'gemini'
            ? ['--model', model, '--output-format', 'json', '--admin-policy', POLICY, '-p', 'Read the request on standard input and follow its response contract.']
            : ['--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', `${timeoutMs}ms`];
          const child = spawn(command, args,
          { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
          const output = [], errors = [];
          let bytes = 0, errBytes = 0, failure, finished = false;
          const kill = (error) => {
            if (failure || finished) return;
            failure = error;
            try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
          };
          const timer = setTimeout(() => kill(new GatewayError('CLI_TIMEOUT', 504)), timeoutMs);
          const abort = () => kill(new GatewayError('CANCELLED', 499));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          child.stdout.on('data', (b) => { bytes += b.length; if (bytes > maxOutput) kill(new GatewayError('OUTPUT_TOO_LARGE', 502)); else output.push(b); });
          child.stderr.on('data', (b) => { errBytes += b.length; if (errBytes <= 64 * 1024) errors.push(b); });
          child.stdin.on('error', () => {}); // early CLI rejection can close stdin
          child.on('error', () => { failure = new GatewayError('CLI_UNAVAILABLE', 503); });
          child.on('close', (code) => {
            finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            // Never propagate raw stderr/errors (may contain auth URLs, prompt text or tokens).
            const text = Buffer.concat(output).toString('utf8');
            if (code !== 0) return reject(classifyError(Buffer.concat(errors).toString('utf8') + text));
            let result;
            try {
              if (kind === 'gemini') result = JSON.parse(text);
              else {
                const events = text.trim().split('\n').map((line) => JSON.parse(line));
                const results = events.filter((e) => e.event === 'result');
                if (results.length !== 1 || events.some((e) => e.step_update?.step_type === 'tool' || e.step_update?.subagent_info)) throw new Error('unexpected agent activity');
                result = results[0].result;
                if (result.status !== 'SUCCESS') return reject(classifyError(JSON.stringify(result.error ?? result.status)));
              }
            } catch { return reject(new GatewayError('INVALID_CLI_JSON', 502)); }
            if (result.error) return reject(classifyError(JSON.stringify(result.error)));
            if (typeof result.response !== 'string' || !result.response.trim()) return reject(new GatewayError('EMPTY_RESPONSE', 502));
            const stats = result.stats ?? (result.usage ? { models: { [model]: { tokens: { prompt: result.usage.input_tokens, candidates: result.usage.output_tokens } } } } : {});
            resolve({ text: result.response, stats });
          });
          child.stdin.end(kind === 'gemini' ? prompt : JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
        });
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}

export const createAntigravity = (options) => createGemini({ ...options, kind: 'antigravity', command: options.command ?? 'agy' });
