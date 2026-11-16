// Reproducible H-02 acceptance against the pinned Linux image and a private native Caddy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { deviceCredentials, unauthorized, mcpChecks, persistence, openSession } from '../verify-h02.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspace = join(root, '.hub-local/h02');
await mkdir(workspace, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(workspace, 'stack-'));
const state = join(dir, 'private');
const snippet = join(dir, 'caddy-private/auth.caddy');
const config = join(dir, 'Caddyfile');
const caddy = process.env.CADDY_BIN || join(root, 'spikes/f01b/bin/caddy');
await access(caddy, constants.X_OK); // Fail before creating any Docker resources if no test Caddy exists.
const project = 'neighbor-h02-' + Date.now();
let caddyProcess;
let containerCreated = false;

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0) {
    console.error('FAILED command: ' + executable + ' ' + args[0] + '; credentials/logs suppressed');
    throw new Error('Command failed with status ' + result.status);
  }
  return result.stdout.trim();
}

function port() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const chosen = server.address().port;
      server.close(() => resolvePort(chosen));
    });
  });
}

const mailPort = await port();
const hubPort = await port();
const officePort = await port();
const adminPort = await port();
const backend = '127.0.0.1:' + mailPort;
const base = 'http://127.0.0.1:' + hubPort;
const officeUrl = 'http://127.0.0.1:' + officePort;
const env = { ...process.env, HUB_PRIVATE_DIR: state, HUB_MAIL_PORT: String(mailPort), TMPDIR: dir,
  XDG_DATA_HOME: join(dir, 'caddy-data'), XDG_CONFIG_HOME: join(dir, 'caddy-config') };
const composeArgs = ['compose', '-p', project, '-f', join(root, 'deploy/compose.yaml')];
const compose = (...args) => run('docker', [...composeArgs, ...args], env);
const ops = (command, ...args) => run('python3', [join(root, 'ops', command), '--state-dir', state, ...args], env);

async function waitOffice() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (caddyProcess.exitCode !== null) throw new Error('Private Caddy exited early');
    try {
      const res = await fetch(officeUrl);
      if (res.status === 200 && await res.text() === 'office preserved') return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Private office fixture did not start');
}

try {
  console.log('STEP isolated credentials + compose config');
  ops('init-secrets');
  compose('config', '--quiet');
  containerCreated = true;
  console.log('STEP pinned linux/amd64 mail-a startup');
  compose('up', '-d', '--wait', '--wait-timeout', '120');
  const container = compose('ps', '-q', 'mail-a');
  const inspect = JSON.parse(run('docker', ['inspect', container]))[0];
  assert.equal(inspect.Config.User, '10001:10001');
  assert.equal(inspect.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(inspect.HostConfig.PortBindings['8765/tcp'].map((b) => b.HostIp), ['127.0.0.1']);
  const image = JSON.parse(run('docker', ['image', 'inspect', inspect.Image]))[0];
  console.log('IMAGE version=' + image.Config.Labels['org.opencontainers.image.version'] +
    ' revision=' + image.Config.Labels['org.opencontainers.image.revision']);
  console.log('PASS runtime guardrails: UID 10001, 512 MiB cap, cap_drop ALL, read-only rootfs, host binding 127.0.0.1');
  assert.equal((await fetch('http://' + backend + '/health/liveness')).status, 200);
  console.log('PASS host -> loopback backend health 200 on dedicated bridge network');

  ops('render-caddy', '--prepare-only', '--owner', 'self', '--output', snippet, '--upstream', backend);
  const productionSite = (await readFile(join(root, 'deploy/caddy/hub.caddy'), 'utf8'))
    .replace('/etc/caddy/hub-private/auth.caddy', JSON.stringify(snippet));
  const production = join(dir, 'Production-Caddyfile');
  await writeFile(production, productionSite, { mode: 0o600 });
  run(caddy, ['validate', '--config', production, '--adapter', 'caddyfile'], env);
  console.log('PASS production hub.caddy TLS/HTTP-01 syntax validated');
  await writeFile(config,
    '{\n admin 127.0.0.1:' + adminPort + '\n auto_https off\n persist_config off\n}\n' +
    officeUrl + ' {\n respond "office preserved" 200\n}\n' +
    base + ' {\n import ' + JSON.stringify(snippet) + '\n}\n', { mode: 0o600 });
  caddyProcess = spawn(caddy, ['run', '--config', config, '--adapter', 'caddyfile'], { env, stdio: 'ignore' });
  await waitOffice();
  await unauthorized(base + '/mcp/');
  console.log(ops('bootstrap', '--url', 'http://' + backend + '/mcp/'));
  console.log(ops('bootstrap', '--url', 'http://' + backend + '/mcp/'));
  await mcpChecks(base + '/mcp/', state);
  const credentials = await deviceCredentials(state);
  assert.equal((await fetch(base + '/memory/mcp/group-a/', {
    headers: { authorization: 'Bearer ' + credentials.mac.token },
  })).status, 503);
  console.log('PASS authorized memory path returns 503 in MVP');

  console.log('STEP H-03 existing integration assertions against this container');
  const integration = run('node', ['--test', 'client/test/mail-client.integration.test.mjs'], {
    ...env, MAIL_TEST_URL: 'http://' + backend + '/mcp/', MAIL_TEST_ENV_FILE: join(state, 'mail-a.env'),
  });
  console.log(integration);
  assert.ok(!/skipped [1-9]/.test(integration), 'H-03 tests must not be skipped');

  compose('restart', 'mail-a');
  compose('up', '-d', '--wait', '--wait-timeout', '120');
  await persistence(base + '/mcp/', state);
  const started = run('docker', ['inspect', '--format', '{{.State.StartedAt}}', container]);
  const session = await openSession(base + '/mcp/', credentials.windows.token);
  ops('revoke', '--device', 'windows', '--owner', 'self', '--output', snippet,
    '--config', config, '--upstream', backend, '--caddy-bin', caddy,
    '--reload-mode', 'caddy', '--admin', '127.0.0.1:' + adminPort,
    '--probe-url', base + '/health/liveness');
  assert.equal((await session.request('tools/list', {})).status, 401);
  await openSession(base + '/mcp/', credentials.mac.token);
  assert.equal(run('docker', ['inspect', '--format', '{{.State.StartedAt}}', container]), started);
  assert.equal((await fetch(officeUrl)).status, 200);
  assert.equal(await (await fetch(officeUrl)).text(), 'office preserved');
  assert.equal(caddyProcess.exitCode, null);
  console.log('PASS TC-10 SAME Windows MCP session -> 401; Mac 200; Mail start time unchanged; office 200/content unchanged');
  ops('issue', '--device', 'windows', '--owner', 'self', '--output', snippet,
    '--config', config, '--upstream', backend, '--caddy-bin', caddy,
    '--reload-mode', 'caddy', '--admin', '127.0.0.1:' + adminPort,
    '--probe-url', base + '/health/liveness');
  const replacement = await deviceCredentials(state);
  assert.notEqual(replacement.windows.token, credentials.windows.token);
  await openSession(base + '/mcp/', replacement.windows.token);
  assert.equal((await session.request('tools/list', {})).status, 401);
  assert.equal((await fetch(officeUrl)).status, 200);
  console.log('PASS explicit revoke -> issue: replacement Windows credential works; old session remains 401; office 200');
  console.log('PASS H-02 local acceptance (HTTP fixture; production DNS/TLS/systemd remain operator checks)');
} catch (error) {
  console.error('FAIL H-02 local acceptance: ' + error.message);
  process.exitCode = 1;
} finally {
  if (caddyProcess && caddyProcess.exitCode === null) {
    const exited = once(caddyProcess, 'exit');
    caddyProcess.kill('SIGTERM');
    await exited;
  }
  if (containerCreated) {
    const cleaned = spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
      env, encoding: 'utf8', timeout: 60_000,
    });
    if (cleaned.status !== 0) {
      console.error('FAILED cleanup for isolated project ' + project);
      process.exitCode = 1;
    } else console.log('CLEANED isolated container/network/volume: ' + project);
  }
}
