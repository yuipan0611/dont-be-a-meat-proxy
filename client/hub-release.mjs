// Shared by the HTTPS bootstrap and the installed updater. No external Node dependencies.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = 'https://hub.example.invalid/dist/';
export const windows = process.platform === 'win32';
export const root = windows ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hub-client') : join(homedir(), '.hub-client');
export const bin = join(root, 'bin');
export const statePath = join(root, 'state.json');
const releases = join(root, 'releases');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const version = /^(\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?)$/;
const idPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?-[a-f0-9]{40}$/;
export const runtimeFiles = Object.freeze([
  'client/hub-hook.mjs', 'client/hub-release.mjs', 'client/hub.mjs', 'client/launch.mjs',
  'client/mail-client.mjs', 'client/package.json', 'client/private-files.mjs',
  'client/templates/claude-settings.json', 'client/templates/hub-client.json',
  'ops/lifecycle/lifecycle.mjs', 'ops/lifecycle/main.mjs', 'ops/lifecycle/protocol.mjs', 'ops/lifecycle/store-file.mjs',
]);
export const installerFiles = Object.freeze(['install/install.sh', 'install/install.ps1']);
const filePattern = /^(?:client\/|ops\/lifecycle\/)(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:mjs|json)$/;
const canonicalName = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function writeJSON(path, value, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function distURL(value = process.env.HUB_DIST_URL || dist) {
  if (value === dist || /^http:\/\/127\.0\.0\.1:\d+\/dist\/$/.test(value)) return value;
  throw new Error('Invalid Hub distribution URL');
}

export async function download(base, name, max = 2 * 1024 * 1024) {
  const response = await fetch(distURL(base) + name, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${name} download failed (HTTP ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) throw new Error(`${name} is too large`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > max) throw new Error(`${name} is too large`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function publicConfig(value) {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.groups) || !Object.keys(value.groups).length) {
    throw new Error('Invalid public Hub group config');
  }
  for (const [id, group] of Object.entries(value.groups)) {
    if (!/^group-[a-z]$/.test(id) || !record(group) || Object.keys(group).sort().join() !== 'clock_agent,memory_agent,peers' ||
        !canonicalName(group.clock_agent) || !canonicalName(group.memory_agent) ||
        !Array.isArray(group.peers) || !group.peers.every(canonicalName)) {
      throw new Error('Invalid canonical names in public Hub group config');
    }
  }
  return value.groups;
}

export function releaseManifest(value) {
  if (!record(value) || Object.keys(value).sort().join() !== 'archives,bootstrap_sha256,commit,files,version' ||
      typeof value.version !== 'string' || value.version.length > 64 || !version.test(value.version) ||
      typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit) || !digest(value.bootstrap_sha256) ||
      !record(value.archives) || Object.keys(value.archives).sort().join() !== 'tar.gz,zip' || !record(value.files)) throw new Error('Invalid Hub manifest');
  const id = `${value.version}-${value.commit}`;
  for (const format of ['tar.gz', 'zip']) {
    const archive = value.archives[format];
    if (!record(archive) || Object.keys(archive).sort().join() !== 'name,sha256' || archive.name !== `hub-client-${id}.${format}` || !digest(archive.sha256)) {
      throw new Error('Invalid Hub archive metadata');
    }
  }
  for (const [file, hash] of Object.entries(value.files)) {
    if (!digest(hash) || (!installerFiles.includes(file) &&
        (!filePattern.test(file) || file.split('/').includes('test')))) {
      throw new Error('Invalid Hub file metadata');
    }
  }
  for (const file of ['client/hub.mjs', 'client/launch.mjs', 'client/hub-release.mjs', ...installerFiles]) {
    if (!Object.hasOwn(value.files, file)) throw new Error('Incomplete Hub manifest');
  }
  if (value.bootstrap_sha256 !== value.files['client/hub-release.mjs']) throw new Error('Hub bootstrap metadata differs');
  return { ...value, id };
}

export function checkHash(bytes, expected, name) {
  if (sha256(bytes) !== expected) throw new Error(`SHA-256 mismatch: ${name}`);
}

export function ps(script, extraEnv = {}) {
  const command = windows ? 'powershell.exe' : 'pwsh';
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-Command', "$ErrorActionPreference='Stop'; " + script], {
    env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error('PowerShell could not complete the Hub file operation');
  return result.stdout;
}

function privateRoot() {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (!windows && stat.uid !== process.getuid())) throw new Error('Unsafe Hub install directory');
  if (windows) {
    ps(`
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $item = Get-Item -LiteralPath $env:HUB_PRIVATE_ROOT -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe install directory' }
      $acl = New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $env:HUB_PRIVATE_ROOT -AclObject $acl
    `, { HUB_PRIVATE_ROOT: root });
  } else {
    chmodSync(root, 0o700);
  }
}

export async function withLock(action) {
  privateRoot();
  const lock = join(root, 'change.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Hub install, update or uninstall is in progress');
    throw error;
  }
  try {
    return await action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function releasePath(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid installed Hub release ID');
  return join(releases, id);
}

function unpack(format, archive, destination) {
  if (format === 'zip') {
    // The same .NET API is available to Windows PowerShell 5.1 and PowerShell 7.
    ps(`
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [IO.Compression.ZipFile]::ExtractToDirectory($env:HUB_ARCHIVE, $env:HUB_EXTRACT)
    `, { HUB_ARCHIVE: archive, HUB_EXTRACT: destination });
  } else {
    const result = spawnSync('tar', ['-xzf', archive, '-C', destination], { timeout: 30000 });
    if (result.status !== 0) throw new Error('Could not extract Hub tarball. Check that tar is installed.');
  }
}

function verifyInstalled(directory, files) {
  const pending = [directory];
  const found = [];
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name);
      const name = path.slice(directory.length + 1).split(sep).join('/');
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && Object.hasOwn(files, name)) {
        checkHash(readFileSync(path), files[name], name);
        found.push(name);
      } else throw new Error('Unexpected file in Hub archive');
    }
  }
  if (found.length !== Object.keys(files).length) throw new Error('Hub archive is missing a file');
}

export async function stageRelease(base, format) {
  if (!['tar.gz', 'zip'].includes(format)) throw new Error('Unsupported Hub archive format');
  const manifest = releaseManifest(JSON.parse(await download(base, 'manifest.json')));
  const groups = publicConfig(JSON.parse(await download(base, 'config.json')));
  const { name, sha256: expected } = manifest.archives[format];
  const bytes = await download(base, name);
  checkHash(bytes, expected, name);
  mkdirSync(releases, { mode: 0o700, recursive: true });
  const scratch = mkdtempSync(join(root, '.install-'));
  const destination = releasePath(manifest.id);
  let created = false;
  let ready = false;
  try {
    const archive = join(scratch, name);
    const bundle = join(scratch, 'bundle');
    mkdirSync(bundle, { mode: 0o700 });
    writeFileSync(archive, bytes, { mode: 0o600 });
    unpack(format, archive, bundle);
    const files = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => !name.startsWith('install/')));
    verifyInstalled(bundle, files);
    try {
      // A previous update may have activated this exact immutable release.
      if (!lstatSync(destination).isDirectory()) throw new Error('Unsafe Hub release directory');
      verifyInstalled(destination, files);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      renameSync(bundle, destination);
      created = true;
    }
    const candidate = await import(pathToFileURL(join(destination, 'client/hub.mjs')).href);
    ready = true;
    return {
      candidate, groups, id: manifest.id, version: manifest.version, destination,
      discard() { if (created) rmSync(destination, { recursive: true, force: true }); },
    };
  } finally {
    if (created && !ready) rmSync(destination, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function groupProfile(groups, groupId, origin) {
  if (!Object.hasOwn(groups, groupId)) throw new Error('Your group is absent from the public Hub config');
  return {
    ...groups[groupId], group_id: groupId, project_key: `/data/projects/${groupId}`,
    hub_mail_url: new URL('/mcp/', distURL(origin)).href,
  };
}

function isBootstrap() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (process.argv[2] === 'install' && isBootstrap()) {
  try {
    if (lstatSync(fileURLToPath(import.meta.url)).size > 100_000) throw new Error('Unexpected bootstrap size');
    // The script bootstrap has the same HTTPS trust root as install.sh/ps1. Bind it
    // to the manifest as well before executing any staged release code.
    const base = distURL();
    const manifest = releaseManifest(JSON.parse(await download(base, 'manifest.json')));
    checkHash(readFileSync(fileURLToPath(import.meta.url)), manifest.bootstrap_sha256, 'bootstrap.mjs');
    await withLock(async () => {
      try {
        lstatSync(statePath);
        throw new Error('Hub is installed. Run hub update.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const format = process.argv[3];
      const release = await stageRelease(base, format);
      try {
        await release.candidate.install(release, base, format);
      } catch (error) {
        try { lstatSync(statePath); } catch { release.discard(); }
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
