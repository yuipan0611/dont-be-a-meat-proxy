import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { createMailClient } from './mail-client.mjs';
import { runHookCLI } from './hub-hook.mjs';
import {
  bin, distURL, groupProfile, ps, readJSON, root, stageRelease, statePath, windows, withLock, writeJSON,
} from './hub-release.mjs';

const credentialsPath = join(root, 'device.json');
const launcher = join(root, 'launch.mjs');
const header = 'Bearer ${HUB_TOKEN}';
const actualPlatform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
const agentPattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const tokenPattern = /^mph_[A-Za-z0-9_-]{43}$/;
const tokenIsSafe = (value) => typeof value === 'string' && tokenPattern.test(value);

function readOptional(path, fallback) {
  try {
    return readJSON(path);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Cannot read Hub configuration. Check the JSON settings and permissions.');
  }
}

function credentials() {
  const stat = lstatSync(credentialsPath);
  if (!stat.isFile() || stat.nlink !== 1 ||
      (!windows && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600))) {
    throw new Error('Unsafe Hub credential permissions');
  }
  const device = readOptional(credentialsPath);
  if (!tokenIsSafe(device?.token) || !agentPattern.test(device?.agent ?? '') || device.platform !== actualPlatform) {
    throw new Error('Invalid Hub device configuration');
  }
  return device;
}

async function askDevice(groups) {
  if (!process.stdin.isTTY) throw new Error('Run the installer in an interactive terminal');
  let hidden = false;
  const sink = new Writable({ write(chunk, _encoding, done) {
    if (!hidden) process.stderr.write(chunk);
    done();
  } });
  const input = createInterface({ input: process.stdin, output: sink, terminal: true, historySize: 0 });
  const abort = new AbortController();
  input.on('SIGINT', () => abort.abort());
  input.once('close', () => abort.abort());
  const ask = async (prompt) => (await input.question(prompt, { signal: abort.signal })).trim();
  try {
    const agent = await ask('Agent name (from /connect): ');
    if (!agentPattern.test(agent)) throw new Error('Enter your canonical agent name from /connect or ask PM for it');
    const platform = (await ask(`Platform [${actualPlatform}] (macos/windows/linux): `)).toLowerCase() || actualPlatform;
    if (platform !== actualPlatform) throw new Error(`Select ${actualPlatform} in /connect for this device`);
    const ids = Object.keys(groups);
    const groupId = ids.length === 1 ? ids[0] : await ask(`Group from /connect (${ids.join('/') }): `);
    if (!Object.hasOwn(groups, groupId)) throw new Error('Unknown Hub group');
    hidden = true;
    process.stderr.write('Device token (hidden): ');
    const token = await ask('');
    if (!tokenIsSafe(token)) throw new Error('Paste the complete device token from /connect');
    return { agent, platform, groupId, token };
  } finally {
    if (hidden) process.stderr.write('\n');
    input.close();
  }
}

function expectedMcp(url) {
  return { type: 'http', url, headers: { Authorization: header } };
}

function appCommand(command, args, options) {
  // Windows CLI installations may be npm .cmd shims. Pass arguments via JSON
  // in the child environment and use PowerShell's argument array, never a shell command string.
  if (windows) {
    return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `
      $options = ConvertFrom-Json $env:HUB_APP_ARGUMENTS
      $cli = Get-Command $options.command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if (!$cli) { exit 127 }
      $cliArgs = @($options.args | ForEach-Object { [string]$_ })
      & $cli.Source @cliArgs
      exit $LASTEXITCODE
    `], {
      ...options, env: { ...options.env ?? process.env, HUB_APP_ARGUMENTS: JSON.stringify({ command, args }) },
    });
  }
  return spawnSync(command, args, options);
}

function hookGroups() {
  const template = readJSON(new URL('./templates/claude-settings.json', import.meta.url));
  return Object.fromEntries(Object.entries(template.hooks).map(([name, [group]]) => [name, {
    hooks: group.hooks.map(({ args, ...hook }) => ({
      ...hook, command: process.execPath, args: [launcher, 'hook', args[1]],
    })),
  }]));
}

function projectFiles(cwd) {
  return { mcp: join(cwd, '.mcp.json'), hooks: join(cwd, '.claude', 'settings.local.json') };
}

const projectsPath = join(root, 'projects.json');
function ownHookGroup(group) {
  return Array.isArray(group?.hooks) && group.hooks.length > 0 &&
    group.hooks.every((hook) => hook.type === 'command' && hook.args?.[0] === launcher && hook.args?.[1] === 'hook');
}

function fallbackSettings(url) {
  console.log('Codex (~/.codex/config.toml). Open with hub codex after adding this block.');
  console.log(`[mcp_servers.hub]\nurl = "${url}"\nbearer_token_env_var = "HUB_TOKEN"`);
  console.log('Cursor (.cursor/mcp.json). Close Cursor, then launch it from this folder with hub cursor.');
  console.log(JSON.stringify({ mcpServers: { hub: { url, headers: { Authorization: 'Bearer ${env:HUB_TOKEN}' } } } }, null, 2));
}

function setupClaude(url) {
  const cwd = realpathSync(process.cwd());
  const probe = appCommand('claude', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error?.code === 'ENOENT' || probe.status === 127) {
    fallbackSettings(url);
    return;
  }
  if (probe.status !== 0) throw new Error('Claude Code could not start');

  const files = projectFiles(cwd);
  const settings = readOptional(files.hooks, {});
  const shared = readOptional(join(cwd, '.claude', 'settings.json'), {});
  const legacyHooks = [shared, settings].some((data) => Object.values(data.hooks ?? {}).flat()
    .some((group) => group?.hooks?.some((hook) => hook.args?.some((arg) => arg.endsWith('/client/hub-hook.mjs')) ||
      hook.command?.includes('client/hub-hook.mjs'))));
  if (legacyHooks) throw new Error('This project has legacy Hub hooks. See onboarding-S1 and run hub setup after migrating them.');
  // Prepare the merge before touching .mcp.json, so malformed settings fail cleanly.
  settings.hooks ??= {};
  for (const [name, group] of Object.entries(hookGroups())) {
    const existing = settings.hooks[name] ?? [];
    settings.hooks[name] = [...existing.filter((entry) => !ownHookGroup(entry)), group];
  }
  const mcp = readOptional(files.mcp, { mcpServers: {} });
  const existingMcp = mcp.mcpServers?.hub;
  if (existingMcp && !isDeepStrictEqual(existingMcp, expectedMcp(url))) {
    throw new Error('This project already defines a different hub MCP server. See onboarding-S1 before running hub setup.');
  }
  const projects = readOptional(projectsPath, {});
  const ownedMcp = projects[cwd]?.ownedMcp || !existingMcp;
  writeJSON(projectsPath, { ...projects, [cwd]: { ownedMcp } });
  if (!existingMcp) {
    const added = appCommand('claude', ['mcp', 'add', '--scope', 'project', '--transport', 'http',
      'hub', url, '--header', `Authorization: ${header}`], { encoding: 'utf8', timeout: 15000 });
    if (added.status !== 0 || !isDeepStrictEqual(readOptional(files.mcp, {})?.mcpServers?.hub, expectedMcp(url))) {
      throw new Error('Claude could not register hub MCP. Run hub setup after checking this project’s Claude settings.');
    }
  }
  mkdirSync(dirname(files.hooks), { recursive: true });
  writeJSON(files.hooks, settings);
  console.log('✅ Claude MCP and hooks configured for this project. Start with hub claude.');
}

async function check(label, operation) {
  try {
    await operation();
    console.log(`✅ ${label}`);
    return true;
  } catch (error) {
    // Don't print server-controlled error text, endpoints, request headers or inbox data.
    console.error(`❌ ${label}${error.code === 'E-AUTH' ? ' (device token denied)' : ''}`);
    return false;
  }
}

export async function diagnose(profile, device) {
  const url = profile.hub_mail_url;
  const ready = await check('Hub readiness 200', async () => {
    const response = await fetch(new URL('/health/readiness', url), {
      redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${device.token}` },
    });
    await response.body?.cancel();
    if (response.status !== 200) {
      throw Object.assign(new Error('readiness failed'), { code: [401, 403].includes(response.status) ? 'E-AUTH' : '' });
    }
  });
  if (!ready) return false;
  return check('Hub inbox can be listed', async () => {
    const client = createMailClient({
      url, token: device.token, projectKey: profile.project_key, agentName: device.agent,
      fetch: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    });
    const result = await client.fetchEvents({ limit: 1 });
    if (!Array.isArray(result.events)) throw new Error('Invalid inbox response');
  });
}

const marker = '# hub-client PATH (managed)';
const shEntry = 'export PATH="$HOME/.hub-client/bin:$PATH" ' + marker;
const fishEntry = 'fish_add_path "$HOME/.hub-client/bin" ' + marker;

function profiles() {
  const home = homedir();
  const shell = basename(process.env.SHELL || 'sh');
  if (shell === 'fish') return [[join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'fish/conf.d/hub-client.fish'), fishEntry]];
  if (shell === 'zsh') return [[join(process.env.ZDOTDIR || home, '.zshrc'), shEntry]];
  if (shell === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile'].map((name) => join(home, name));
    return [[join(home, '.bashrc'), shEntry], [login.find(existsSync) || login.at(-1), shEntry]];
  }
  return [[join(home, '.profile'), shEntry]];
}

function setUserPath(add, entries = []) {
  if (windows) {
    ps(`
      $path = [Environment]::GetEnvironmentVariable('Path','User')
      $entries = @($path -split ';' | Where-Object { $_ -and $_ -ine $env:HUB_PATH_ENTRY })
      if ($env:HUB_PATH_ADD -eq '1') { $entries = @($env:HUB_PATH_ENTRY) + $entries }
      [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    `, { HUB_PATH_ENTRY: bin, HUB_PATH_ADD: add ? '1' : '0' });
    return [];
  }
  const changed = [];
  for (const [path, line] of add ? profiles() : entries) {
    let original = '';
    try {
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Unsafe shell profile');
        original = readFileSync(path, 'utf8');
      }
      const lines = original.split('\n');
      if (add && !lines.includes(line)) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, (original && !original.endsWith('\n') ? '\n' : '') + line + '\n', { mode: 0o600 });
      } else if (!add && lines.includes(line)) {
        writeFileSync(path, lines.filter((text) => text !== line).join('\n'));
      }
      changed.push([path, line]);
    } catch {
      console.log(`Shell PATH entry needs manual attention. Hub command: ${join(bin, 'hub')}`);
    }
  }
  return changed;
}

function installLaunchers(release) {
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  copyFileSync(join(release.destination, 'client', 'launch.mjs'), launcher);
  writeFileSync(join(bin, 'hub'), '#!/bin/sh\nexec node "$(dirname "$0")/../launch.mjs" "$@"\n', { mode: 0o700 });
  if (windows) {
    writeFileSync(join(bin, 'hub.cmd'), '@echo off\r\nnode "%~dp0..\\launch.mjs" %*\r\n');
  }
}

export async function install(release, origin, format) {
  const device = await askDevice(release.groups);
  const profile = groupProfile(release.groups, device.groupId, origin);
  if (!await release.candidate.diagnose(profile, device)) {
    throw new Error('Check /connect and your agent name, then run the installer again.');
  }
  let paths;
  try {
    installLaunchers(release);
    writeJSON(credentialsPath, device);
    paths = setUserPath(true);
    writeJSON(statePath, { current: release.id, previous: null, profile, origin, format, paths });
  } catch (error) {
    rmSync(credentialsPath, { force: true });
    if (paths) setUserPath(false, paths);
    throw error;
  }
  console.log(`✅ Hub ${release.version} installed. Open a new terminal for hub update and hub doctor.`);
  try {
    setupClaude(profile.hub_mail_url);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    console.error('The Hub client is available. Run hub setup to retry this project’s Claude setup.');
    process.exitCode = 1;
  }
}

async function update() {
  await withLock(async () => {
    const device = credentials();
    const state = readJSON(statePath);
    const base = distURL(state.origin);
    const release = await stageRelease(base, state.format);
    try {
      const profile = groupProfile(release.groups, device.groupId, base);
      if (!await release.candidate.diagnose(profile, device)) throw new Error('Candidate self-check failed');
      if (release.id === state.current) {
        writeJSON(statePath, { ...state, profile });
        console.log(`✅ Hub ${release.version} is current.`);
        return;
      }
      writeJSON(statePath, { ...state, current: release.id, previous: state.current, profile });
      console.log(`✅ Updated Hub to ${release.version}. Previous version retained.`);
    } catch (error) {
      release.discard();
      throw error;
    }
    // Keep old release directories while existing Claude hook processes may still use them.
  });
}

function removeProject(cwd, info, url) {
  const files = projectFiles(cwd);
  const settings = readOptional(files.hooks, null);
  if (settings?.hooks) {
    let changed = false;
    for (const [name, entries] of Object.entries(settings.hooks)) {
      const keep = entries.filter((entry) => !ownHookGroup(entry));
      if (keep.length === entries.length) continue;
      changed = true;
      if (keep.length) settings.hooks[name] = keep;
      else delete settings.hooks[name];
    }
    if (changed) writeJSON(files.hooks, settings);
  }
  const mcp = info.ownedMcp && readOptional(files.mcp, null);
  if (isDeepStrictEqual(mcp?.mcpServers?.hub, expectedMcp(url))) {
    delete mcp.mcpServers.hub;
    writeJSON(files.mcp, mcp);
  }
}

async function uninstall() {
  await withLock(async () => {
    const state = readJSON(statePath);
    for (const [cwd, info] of Object.entries(readOptional(projectsPath, {}))) removeProject(cwd, info, state.profile.hub_mail_url);
    setUserPath(false, state.paths);
    rmSync(credentialsPath, { force: true });
    for (const name of ['bin', 'releases', 'projects.json', 'launch.mjs', 'state.json']) {
      rmSync(join(root, name), { force: true, recursive: true });
    }
    console.log('✅ Hub client uninstalled. Revoke the device token with Discord /revoke when you no longer need it.');
  });
}

function runtimeEnv(device, state) {
  return { ...process.env, HUB_TOKEN: device.token, HUB_AGENT: device.agent,
    HUB_MAIL_URL: state.profile.hub_mail_url, PATH: bin + delimiter + process.env.PATH };
}

export async function main(state, [command, ...args]) {
  if (command === 'uninstall' && !args.length) return uninstall();
  if (!['update', 'doctor', 'setup', 'hook', 'claude', 'codex', 'cursor'].includes(command)) {
    throw new Error('Usage: hub update | doctor | uninstall | setup | claude | codex | cursor');
  }
  if (command === 'update') {
    try {
      await update();
    } catch (error) {
      // The active pointer only moves after the candidate passes verification.
      throw new Error(`Update stopped. Your installed release remains active. ${error.message}`);
    }
  } else if (command === 'doctor') {
    console.log(`Hub ${state.current.slice(0, -41)}`);
    if (!await diagnose(state.profile, credentials())) {
      console.error('Check /connect, your agent name and the Hub connection, then run hub doctor again.');
      process.exitCode = 1;
    }
  } else if (command === 'setup') {
    await withLock(() => setupClaude(state.profile.hub_mail_url));
  } else if (command === 'hook') {
    // Stay in Claude's direct child so the existing watcher can observe its parent exiting.
    process.exit(await runHookCLI(args, { ...runtimeEnv(credentials(), state), HUB_INSTALLED_ROOT: root }));
  } else {
    const result = appCommand(command, args, { env: runtimeEnv(credentials(), state), stdio: 'inherit' });
    if (result.error || result.status === 127) throw new Error(`Could not start ${command}`);
    process.exitCode = result.status ?? 1;
  }
}
