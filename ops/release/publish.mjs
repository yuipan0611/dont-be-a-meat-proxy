import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkHash, publicConfig, releaseManifest, runtimeFiles, installerFiles } from '../../client/hub-release.mjs';

function regular(path) {
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular release input file');
  return readFileSync(path);
}

function publishFile(path, bytes) {
  const temporary = join(dirname(path), `.hub-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function requireDirectory(path) {
  mkdirSync(path, { mode: 0o755, recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error('Publish directories must be owned by the publisher and writable only by their owner');
  }
}

function publishImmutable(path, bytes, digest) {
  try {
    checkHash(regular(path), digest, 'existing release archive');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    publishFile(path, bytes);
  }
}

try {
  const [build, config, target = '/var/www/hub-downloads', ...rest] = process.argv.slice(2);
  if (!build || !config || rest.length) {
    throw new Error('Usage: ops/release/publish.sh BUILD_DIR PUBLIC_CONFIG_JSON [PUBLIC_ROOT]');
  }
  const rawManifest = JSON.parse(regular(join(build, 'manifest.json')));
  const manifest = releaseManifest(rawManifest);
  const allowedFiles = [...runtimeFiles, ...installerFiles];
  if (Object.keys(manifest.files).length !== allowedFiles.length || !allowedFiles.every((file) => Object.hasOwn(manifest.files, file))) {
    throw new Error('The manifest does not match this checkout’s release file allowlist');
  }
  const groups = publicConfig(JSON.parse(regular(config)));
  const distFiles = [
    ['bootstrap.mjs', manifest.bootstrap_sha256],
    ...Object.values(manifest.archives).map(({ name, sha256 }) => [name, sha256]),
  ];
  const installFiles = ['install.sh', 'install.ps1'].map((name) => [name, manifest.files['install/' + name]]);
  const materials = new Map();
  for (const [name, digest] of [...distFiles, ...installFiles]) {
    const bytes = regular(join(build, name));
    checkHash(bytes, digest, name);
    materials.set(name, bytes);
  }

  const webRoot = resolve(target);
  const publicDist = join(webRoot, 'dist');
  // Caddy only serves the public root. A restrictive caller umask must not make it unreadable to Caddy.
  process.umask(0o022);
  requireDirectory(webRoot);
  requireDirectory(publicDist);
  const lock = join(webRoot, '.publish.lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    for (const { name, sha256 } of Object.values(manifest.archives)) {
      publishImmutable(join(publicDist, name), materials.get(name), sha256);
    }
    publishFile(join(publicDist, 'bootstrap.mjs'), materials.get('bootstrap.mjs'));
    publishFile(join(publicDist, 'config.json'), JSON.stringify({ groups }, null, 2) + '\n');
    for (const [name] of installFiles) publishFile(join(webRoot, name), materials.get(name));
    publishFile(join(publicDist, 'manifest.json'), JSON.stringify(rawManifest, null, 2) + '\n');
  } finally {
    rmSync(lock, { recursive: true });
  }
  console.log(`Published Hub ${manifest.version} (${manifest.commit}) to ${webRoot}`);
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid release manifest or public config JSON' : error.message);
  process.exitCode = 1;
}
