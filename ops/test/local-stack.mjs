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
import { waitForHealth } from './readiness.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspace = join(root, '.hub-local/h02');
await mkdir(workspace, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(workspace, 'stack-'));
const state = join(dir, 'private');
const clockState = join(dir, 'hubclock');
await mkdir(clockState, { mode: 0o700 });
const snippet = join(dir, 'caddy-private/auth.caddy');
const config = join(dir, 'Caddyfile');
const caddy = process.env.CADDY_BIN || join(root, 'spikes/f01b/bin/caddy');
await access(caddy, constants.X_OK); // Fail before creating any Docker resources if no test Caddy exists.
const project = 'neighbor-h02-' + Date.now();
let caddyProcess;
let containerCreated = false;
let phase = 'initial setup';

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
  HUBCLOCK_STATE_DIR: clockState, HUB_OPS_UID: String(process.getuid()), HUB_OPS_GID: String(process.getgid()),
  XDG_DATA_HOME: join(dir, 'caddy-data'), XDG_CONFIG_HOME: join(dir, 'caddy-config') };
const composeArgs = ['compose', '-p', project, '-f', join(root, 'deploy/compose.yaml'),
  '-f', join(root, 'deploy/hubclock/compose.hubclock.yaml')];
const compose = (...args) => run('docker', [...composeArgs, ...args], env);
const ops = (command, ...args) => run('python3', [join(root, 'ops', command), '--state-dir', state, ...args], env);

async function waitMail(step, token) {
  phase = step;
  await waitForHealth(base + '/health/liveness', { step, headers: { authorization: 'Bearer ' + token } });
  console.log('READY [' + step + ']: Mail through Caddy HTTP 200');
}

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

async function waitHubClockTick(container) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const logs = spawnSync('docker', ['logs', container], {
      encoding: 'utf8', timeout: Math.max(1, Math.min(2000, Math.ceil(deadline - performance.now()))),
    });
    if (logs.status === 0) {
      for (const line of (logs.stdout + '\n' + logs.stderr).split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.ev === 'tick') return;
        if (['fatal', 'crash', 'tick_failed'].includes(event.ev)) {
          throw new Error('HubClock startup reported ' + event.ev + '; details suppressed');
        }
      }
    }
    const pause = Math.min(250, deadline - performance.now());
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  throw new Error('HubClock startup did not complete a Mail tick within 30000 ms');
}

try {
  console.log('STEP isolated credentials + compose config');
  ops('init-secrets');
  compose('config', '--quiet');
  containerCreated = true;
  phase = 'initial Mail startup';
  console.log('STEP pinned linux/amd64 mail-a startup');
  compose('up', '-d', '--wait', '--wait-timeout', '120', 'mail-a');
  const container = compose('ps', '-q', 'mail-a');
  const inspect = JSON.parse(run('docker', ['inspect', container]))[0];
  assert.equal(inspect.Config.User, '10001:10001');
  assert.equal(inspect.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.ok(inspect.Config.Env.includes('HTTP_ALLOWED_HOSTS=mail-a'));
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(inspect.HostConfig.PortBindings['8765/tcp'].map((b) => b.HostIp), ['127.0.0.1']);
  const image = JSON.parse(run('docker', ['image', 'inspect', inspect.Image]))[0];
  console.log('IMAGE version=' + image.Config.Labels['org.opencontainers.image.version'] +
    ' revision=' + image.Config.Labels['org.opencontainers.image.revision']);
  console.log('PASS runtime guardrails: UID 10001, 512 MiB cap, cap_drop ALL, read-only rootfs, host binding 127.0.0.1');
  await waitForHealth('http://' + backend + '/health/liveness', { step: 'initial host -> Mail health' });
  console.log('PASS host -> loopback backend health 200 on dedicated bridge network');

  phase = 'Caddy validation and startup';
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
  phase = 'TC-01 unauthorized requests';
  await unauthorized(base + '/mcp/');
  phase = 'MCP bootstrap';
  console.log(ops('bootstrap', '--url', 'http://' + backend + '/mcp/'));
  console.log(ops('bootstrap', '--url', 'http://' + backend + '/mcp/'));
  const credentials = await deviceCredentials(state);
  await waitMail('initial MCP readiness', credentials.mac.token);
  phase = 'MCP send/read, cursor and TC-11';
  await mcpChecks(base + '/mcp/', state);
  assert.equal((await fetch(base + '/memory/mcp/group-a/', {
    headers: { authorization: 'Bearer ' + credentials.mac.token },
  })).status, 503);
  console.log('PASS authorized memory path returns 503 in MVP');

  console.log('STEP H-03 existing integration assertions against this container');
  phase = 'H-03 integration tests';
  const integration = run('node', ['--test', 'client/test/mail-client.integration.test.mjs'], {
    ...env, MAIL_TEST_URL: 'http://' + backend + '/mcp/', MAIL_TEST_ENV_FILE: join(state, 'mail-a.env'),
  });
  console.log(integration);
  assert.ok(!/skipped [1-9]/.test(integration), 'H-03 tests must not be skipped');

  phase = 'TC-05 Mail restart';
  compose('restart', 'mail-a');
  compose('up', '-d', '--wait', '--wait-timeout', '120', 'mail-a');
  await waitMail('TC-05 after Mail restart', credentials.windows.token);
  phase = 'TC-05 persistence read';
  await persistence(base + '/mcp/', state);
  const started = run('docker', ['inspect', '--format', '{{.State.StartedAt}}', container]);
  await waitMail('TC-10 before Windows MCP session', credentials.windows.token);
  phase = 'TC-10 Windows MCP initialize';
  const session = await openSession(base + '/mcp/', credentials.windows.token);
  phase = 'TC-10 Windows revocation';
  ops('revoke', '--device', 'windows', '--owner', 'self', '--output', snippet,
    '--config', config, '--upstream', backend, '--caddy-bin', caddy,
    '--reload-mode', 'caddy', '--admin', '127.0.0.1:' + adminPort,
    '--probe-url', base + '/health/liveness');
  await waitMail('TC-10 after revoke / Mac readiness', credentials.mac.token);
  phase = 'TC-10 retained Windows session and Mac session';
  assert.equal((await session.request('tools/list', {})).status, 401);
  await openSession(base + '/mcp/', credentials.mac.token);
  assert.equal(run('docker', ['inspect', '--format', '{{.State.StartedAt}}', container]), started);
  assert.equal((await fetch(officeUrl)).status, 200);
  assert.equal(await (await fetch(officeUrl)).text(), 'office preserved');
  assert.equal(caddyProcess.exitCode, null);
  console.log('PASS TC-10 SAME Windows MCP session -> 401; Mac 200; Mail start time unchanged; office 200/content unchanged');
  phase = 'Windows replacement token issuance';
  ops('issue', '--device', 'windows', '--owner', 'self', '--output', snippet,
    '--config', config, '--upstream', backend, '--caddy-bin', caddy,
    '--reload-mode', 'caddy', '--admin', '127.0.0.1:' + adminPort,
    '--probe-url', base + '/health/liveness');
  const replacement = await deviceCredentials(state);
  assert.notEqual(replacement.windows.token, credentials.windows.token);
  await waitMail('reissue before replacement Windows session', replacement.windows.token);
  phase = 'replacement Windows session and office preservation';
  await openSession(base + '/mcp/', replacement.windows.token);
  assert.equal((await session.request('tools/list', {})).status, 401);
  assert.equal((await fetch(officeUrl)).status, 200);
  console.log('PASS explicit revoke -> issue: replacement Windows credential works; old session remains 401; office 200');

  phase = 'HubClock primary startup';
  console.log('STEP HubClock primary tick and second-instance standby');
  compose('up', '-d', '--wait', '--wait-timeout', '120', 'hubclock');
  const clockContainer = compose('ps', '-q', 'hubclock');
  const clockInspect = JSON.parse(run('docker', ['inspect', clockContainer]))[0];
  assert.equal(clockInspect.Config.User, env.HUB_OPS_UID + ':' + env.HUB_OPS_GID);
  assert.equal(clockInspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(clockInspect.HostConfig.Memory, 128 * 1024 * 1024);
  assert.deepEqual(clockInspect.HostConfig.CapDrop, ['ALL']);
  assert.equal(Object.keys(clockInspect.HostConfig.PortBindings || {}).length, 0);
  await waitHubClockTick(clockContainer);
  const firstLock = JSON.parse(await readFile(join(clockState, 'hubclock.lock'), 'utf8'));
  phase = 'HubClock second-instance standby';
  const secondary = spawnSync('docker', [...composeArgs, 'run', '--rm', '--no-deps', 'hubclock',
    'node', '/app/ops/lifecycle/main.mjs', 'once'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(secondary.status, 3, 'Second HubClock must exit 3 while the primary holds the lock');
  assert.match(secondary.stdout, /"ev":"standby"/);
  const afterLock = JSON.parse(await readFile(join(clockState, 'hubclock.lock'), 'utf8'));
  assert.equal(afterLock.owner, firstLock.owner, 'Second instance must not replace the primary writer');
  assert.equal(run('docker', ['inspect', '--format', '{{.State.Running}}', clockContainer]), 'true');
  console.log('PASS HubClock primary completed Mail tick via Host mail-a; 128 MiB/read-only/no published ports');
  console.log('PASS HubClock second instance -> standby, exit 3; primary lock owner unchanged and service running');
  console.log('PASS H-02 local acceptance (HTTP fixture; production DNS/TLS/systemd remain operator checks)');
} catch (error) {
  console.error('FAIL H-02 local acceptance [' + phase + ']: ' + error.message);
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
